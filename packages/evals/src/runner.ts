import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { repeatsOf, type EvalCase, type Grader } from './case.js';
import { createFixture, removeFixture, type Fixture } from './fixture.js';
import { grade, type GraderResult, type RubricVerdict, type SessionEvent } from './graders.js';
import { attemptOutcome, classify, type AttemptOutcome, type CaseOutcome } from './results.js';

/**
 * The eval runner (ADR 0038). Every attempt gets its own fixture repository, its own JERRY home and
 * its own Core, under the system temp directory: an eval never touches the user's repositories or
 * JERRY data. Claude Code runs headless with JERRY's plugin from `pluginDir`.
 */

export interface RunnerOptions {
  /** Core bundle (dist/core/core.mjs) and plugin payload (dist/plugin) of the JERRY under test. */
  coreBundle: string;
  pluginDir: string;
  /** The claude binary; a .mjs/.js file runs with Node (the test stand-in). */
  claudeBin: string;
  /** Parent of the per-attempt directories (default: the system temp directory). */
  parentDir?: string;
  /** At most three sessions at once (ADR 0015). */
  parallel?: number;
  /** Overrides each case's repeats (1–10). */
  repeats?: number;
  /** Keeps the fixtures of failed attempts for inspection. */
  keepFailed?: boolean;
  /** Whether a rubric grader is calibrated (ADR 0039). */
  calibrated?(rubricId: string): boolean;
  onAttempt?(attempt: AttemptResult): void;
}

export interface AttemptResult {
  caseId: string;
  attempt: number;
  outcome: AttemptOutcome;
  results: GraderResult[];
  harnessError: string | null;
  output: string;
  costUsd: number | null;
  durationMs: number;
  sessionId: string | null;
  /** Kept only when the attempt failed and keepFailed is set. */
  fixtureDir: string | null;
}

export interface CaseResult {
  caseId: string;
  suite: EvalCase['suite'];
  kind: EvalCase['kind'];
  critical: boolean;
  outcome: CaseOutcome;
  attempts: AttemptResult[];
}

interface CoreInfo {
  port: number;
  token: string;
}

function request(info: CoreInfo, method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const call = http.request(
      { host: '127.0.0.1', port: info.port, method, path: apiPath, agent: false, headers: { authorization: `Bearer ${info.token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode ?? 500) >= 400) reject(new Error(`Core answered ${response.statusCode} for ${method} ${apiPath}: ${text.slice(0, 200)}`));
          else resolve(text === '' ? null : JSON.parse(text));
        });
      },
    );
    call.on('error', reject);
    if (payload !== undefined) call.write(payload);
    call.end();
  });
}

function runProcess(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const viaNode = /\.(mjs|cjs|js)$/i.test(command);
  return new Promise((resolve) => {
    const child = spawn(viaNode ? process.execPath : command, viaNode ? [command, ...args] : [...args], { cwd: options.cwd, env: options.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
  });
}

async function startCore(coreBundle: string, home: string, cwd: string): Promise<{ child: ChildProcess; info: CoreInfo }> {
  const child = spawn(process.execPath, [coreBundle], { cwd, env: { ...process.env, JERRY_HOME: home, JERRY_CORE_PORT: '0', JERRY_QUALITY_DEBOUNCE_MS: '300' }, stdio: 'ignore', windowsHide: true });
  const coreFile = path.join(home, 'run', 'core.json');
  for (let wait = 0; wait < 200 && !fs.existsSync(coreFile); wait += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!fs.existsSync(coreFile)) {
    child.kill();
    throw new Error('the eval Core did not start within 10 s');
  }
  // core.json can appear a moment before it is complete.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const info = JSON.parse(fs.readFileSync(coreFile, 'utf8')) as CoreInfo;
      return { child, info };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  child.kill();
  throw new Error('the eval Core wrote an unreadable core.json');
}

async function stopCore(core: { child: ChildProcess; info: CoreInfo }): Promise<void> {
  await request(core.info, 'POST', '/api/v1/shutdown', {}).catch(() => null);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      core.child.kill();
      resolve();
    }, 3000);
    core.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Hook events of the session, read from the eval Core's database (read-only). node:sqlite is loaded
 * here, not at the top: a static import would print Node's experimental warning on every CLI command.
 */
async function sessionEvents(home: string, sessionId: string | null): Promise<SessionEvent[]> {
  const file = path.join(home, 'database', 'jerry.sqlite');
  if (sessionId === null || !fs.existsSync(file)) return [];
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT event_type, tool_name, verdict, rule_id, agent_type FROM hook_events WHERE session_id = ? ORDER BY occurred_at').all(sessionId) as Array<Record<string, string | null>>).map((row) => ({
      eventType: String(row['event_type']),
      toolName: row['tool_name'] ?? null,
      verdict: row['verdict'] ?? null,
      ruleId: row['rule_id'] ?? null,
      agentType: row['agent_type'] ?? null,
    }));
  } finally {
    db.close();
  }
}

/** A rubric grader through the same claude binary, with the grader's pinned model and no tools. */
export function claudeRubric(claudeBin: string, cwd: string): (grader: Extract<Grader, { type: 'rubric' }>, output: string) => Promise<RubricVerdict> {
  return async (grader, output) => {
    const prompt = [
      'You are a strict grader. Score the RESPONSE against the RUBRIC from 0 to 1.',
      'Answer with JSON only: {"score": <number 0..1>, "reason": "<one sentence>"}.',
      `RUBRIC:\n${grader.rubric}`,
      `RESPONSE:\n${output.slice(0, 12_000)}`,
    ].join('\n\n');
    const run = await runProcess(claudeBin, ['-p', prompt, '--model', grader.model, '--output-format', 'json', '--no-session-persistence', '--tools', ''], { cwd, env: process.env, timeoutMs: 120_000 });
    const text = String((JSON.parse(run.stdout || '{}') as { result?: unknown }).result ?? '');
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (json === undefined) throw new Error(`the rubric model gave no JSON verdict: ${text.slice(0, 120)}`);
    const verdict = JSON.parse(json) as { score?: unknown; reason?: unknown };
    const score = Number(verdict.score);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`the rubric model gave an invalid score: ${String(verdict.score)}`);
    return { score, reason: String(verdict.reason ?? '') };
  };
}

export async function runAttempt(evalCase: EvalCase, attempt: number, options: RunnerOptions): Promise<AttemptResult> {
  const started = Date.now();
  let fixture: Fixture | null = null;
  let core: { child: ChildProcess; info: CoreInfo } | null = null;
  let output = '';
  let costUsd: number | null = null;
  let sessionId: string | null = null;
  let results: GraderResult[] = [];
  let harnessError: string | null = null;
  try {
    fixture = createFixture(evalCase, options.parentDir);
    const home = path.join(fixture.base, 'jerry-home');
    core = await startCore(options.coreBundle, home, fixture.base);
    let taskId: string | null = null;
    if (evalCase.setup.task !== undefined) {
      const created = (await request(core.info, 'POST', '/api/v1/tasks', { repoPath: fixture.repo, title: evalCase.setup.task.title, scope: evalCase.setup.task.scope })) as { taskId: string };
      taskId = created.taskId;
      if (evalCase.setup.task.approve) await request(core.info, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    }
    const args = ['-p', evalCase.session.prompt, '--plugin-dir', options.pluginDir, '--model', evalCase.session.model, '--permission-mode', 'acceptEdits', '--output-format', 'json', '--no-session-persistence'];
    // A budget grader also caps the session itself, so a runaway case cannot overspend.
    const budget = evalCase.graders.find((grader) => grader.type === 'budget');
    if (budget !== undefined) args.push('--max-budget-usd', String(budget.maxCostUsd));
    if (evalCase.session.allowedTools.length > 0) args.push('--allowedTools', ...evalCase.session.allowedTools);
    const run = await runProcess(options.claudeBin, args, { cwd: fixture.repo, env: { ...process.env, JERRY_HOME: home }, timeoutMs: evalCase.session.timeoutMs });
    if (run.timedOut) throw new Error(`the session timed out after ${evalCase.session.timeoutMs} ms`);
    try {
      const parsed = JSON.parse(run.stdout) as { result?: unknown; session_id?: unknown; total_cost_usd?: unknown };
      output = String(parsed.result ?? '');
      sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
      costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
    } catch {
      throw new Error(`the session gave no JSON result (exit ${run.code}): ${(run.stderr || run.stdout).slice(0, 200)}`);
    }
    // Telemetry hooks are asynchronous: give them a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const taskState = taskId === null ? null : ((await request(core.info, 'GET', `/api/v1/tasks/${taskId}`)) as { state: string }).state;
    results = await grade(evalCase, {
      output,
      costUsd,
      fixture,
      events: await sessionEvents(home, sessionId),
      taskState,
      rubric: claudeRubric(options.claudeBin, fixture.base),
      calibrated: options.calibrated ?? (() => false),
    });
  } catch (error) {
    harnessError = error instanceof Error ? error.message : String(error);
  } finally {
    if (core !== null) await stopCore(core);
  }
  const outcome = attemptOutcome(results, harnessError);
  const keep = options.keepFailed === true && outcome !== 'PASS';
  if (fixture !== null && !keep) removeFixture(fixture);
  return { caseId: evalCase.id, attempt, outcome, results, harnessError, output: output.slice(0, 4000), costUsd, durationMs: Date.now() - started, sessionId, fixtureDir: keep && fixture !== null ? fixture.base : null };
}

/** Runs every case with its repeats, at most `parallel` (≤ 3) attempts at a time. */
export async function runSuite(cases: readonly EvalCase[], options: RunnerOptions): Promise<CaseResult[]> {
  const parallel = Math.min(Math.max(options.parallel ?? 3, 1), 3);
  const jobs = cases.flatMap((evalCase) => Array.from({ length: options.repeats ?? repeatsOf(evalCase) }, (_unused, index) => ({ evalCase, attempt: index + 1 })));
  const attempts = new Map<string, AttemptResult[]>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next]!;
      next += 1;
      const result = await runAttempt(job.evalCase, job.attempt, options);
      options.onAttempt?.(result);
      attempts.set(job.evalCase.id, [...(attempts.get(job.evalCase.id) ?? []), result]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return cases.map((evalCase) => {
    const own = (attempts.get(evalCase.id) ?? []).sort((a, b) => a.attempt - b.attempt);
    return { caseId: evalCase.id, suite: evalCase.suite, kind: evalCase.kind, critical: evalCase.critical, outcome: classify(own.map((entry) => entry.outcome)), attempts: own };
  });
}
