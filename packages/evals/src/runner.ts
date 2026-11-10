import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DEFAULT_VARIANT, repeatsOf, variantsOf, type EvalCase, type EvalVariant, type Grader, type HistoryTaskSeed } from './case.js';
import { commitSeededFiles, createFixture, removeFixture, type Fixture } from './fixture.js';
import { grade, type GraderResult, type RubricVerdict, type SessionEvent } from './graders.js';
import { attemptOutcome, classify, type AttemptOutcome, type CaseOutcome } from './results.js';
import { parseTranscript, type SessionTokens } from './transcript.js';

/** JERRY's plugin and MCP server as Claude Code names them in the session's init event. */
const JERRY_PLUGIN = 'jerry';

/**
 * The eval runner. Every attempt gets its own fixture repository, its own JERRY home and
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
  /** At most three sessions at once. */
  parallel?: number;
  /** Overrides each case's repeats (1–10). */
  repeats?: number;
  /** Keeps the fixtures of failed attempts for inspection. */
  keepFailed?: boolean;
  /** Runs every variant of each case (a comparison); default: only the first. */
  allVariants?: boolean;
  /** Overrides the model of every case and variant. */
  model?: string;
  /** Whether a rubric grader is calibrated. */
  calibrated?(rubricId: string): boolean;
  onAttempt?(attempt: AttemptResult): void;
}

export interface AttemptResult {
  caseId: string;
  /** The variant the attempt ran as ("jerry" unless the case names others). */
  variant: string;
  attempt: number;
  outcome: AttemptOutcome;
  results: GraderResult[];
  harnessError: string | null;
  output: string;
  costUsd: number | null;
  /** The session's tokens (all models, subagents included); null when Claude Code did not report them. */
  tokens: SessionTokens | null;
  turns: number | null;
  /** Tool calls by tool name, from the session's transcript. */
  toolCalls: Record<string, number>;
  /** Wall-clock time of the whole attempt (fixture, Core, session, grading). */
  durationMs: number;
  /** The session's own duration as Claude Code reported it. */
  sessionMs: number | null;
  sessionId: string | null;
  /** What the session loaded that an isolated eval should not (another plugin), or JERRY missing. */
  environment: string[];
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
  await request(core.info, 'POST', '/api/v1/shutdown', { requestedBy: 'evals', reason: 'eval case finished' }).catch(() => null);
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

/**
 * Seeds an earlier task into the eval Core the way it would have happened: plan (rejected first with
 * the user's feedback, when given), approval, the files written, the report, acceptance (DONE); then
 * the files are committed so the session starts after that work.
 */
async function seedHistory(info: CoreInfo, fixture: Fixture, seed: HistoryTaskSeed, index: number): Promise<void> {
  const paths = [...new Set([...seed.changes.map((change) => change.path), ...Object.keys(seed.files)])];
  const plan = {
    goal: seed.goal,
    classification: ['api-backend'],
    repositories: [fixture.repo],
    currentState: 'Seeded history for an eval.',
    changes: seed.changes.map((change) => ({ kind: change.kind === 'added' ? 'add' : change.kind === 'deleted' ? 'remove' : 'change', target: change.path, description: change.description })),
    architectureImpact: seed.approach,
    scope: { include: paths, exclude: [] },
    steps: [{ step: seed.title, files: paths, dependsOn: [] }],
    tests: [{ kind: 'unit', description: 'seeded' }],
    definitionOfDone: [seed.goal],
  };
  const created = (await request(info, 'POST', '/api/v1/tasks', { repoPath: fixture.repo, title: seed.title, scope: paths, document: plan })) as { taskId: string };
  const taskId = created.taskId;
  let version = 1;
  if (seed.feedback !== undefined) {
    await request(info, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: seed.feedback });
    await request(info, 'POST', `/api/v1/tasks/${taskId}/plan`, { scope: paths, document: plan });
    version = 2;
  }
  await request(info, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version, decision: 'APPROVED' });
  // Written (not yet committed) so the acceptance snapshot records their content.
  for (const [file, content] of Object.entries(seed.files)) {
    const target = path.join(fixture.repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const report = {
    summary: seed.goal,
    changes: seed.changes.map((change) => ({ repository: '', path: change.path, kind: change.kind, description: change.description })),
    agents: [],
    skills: [],
    checks: [{ kind: 'test', command: 'seeded', result: 'NOT_RUN', details: 'seeded history' }],
    planDeviations: [],
    risks: [],
    commitSubjects: [seed.title],
    qaScenarios: [{ id: 'QA-1', priority: 'P3', title: seed.title, location: paths[0] ?? 'repository', roles: [], preconditions: '', testData: '', steps: ['seeded'], expected: 'seeded', negative: '', related: '', kind: 'new' }],
    artifact: '',
  };
  await request(info, 'POST', `/api/v1/tasks/${taskId}/reports`, { report, submittedBy: 'user' });
  await request(info, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED' });
  commitSeededFiles(fixture, seed.files, `history ${index + 1}: ${seed.title}`);
}

/** The claude arguments for an attempt: the case's session in the variant's shape, isolated from the user's own setup. */
export function sessionArgs(evalCase: EvalCase, variant: EvalVariant, options: Pick<RunnerOptions, 'pluginDir' | 'model'>): string[] {
  const model = options.model ?? variant.model ?? evalCase.session.model;
  const args = ['-p', evalCase.session.prompt];
  if (variant.plugin) args.push('--plugin-dir', options.pluginDir);
  // The user's own settings (and with them their plugins) stay out; project and local settings of
  // the throwaway fixture are empty. --bare is not used: it would switch JERRY's hooks off too.
  args.push('--setting-sources', 'project,local');
  args.push('--model', model, '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose', '--no-session-persistence');
  // A budget grader also caps the session itself, so a runaway case cannot overspend.
  const budget = evalCase.graders.find((grader) => grader.type === 'budget');
  if (budget !== undefined) args.push('--max-budget-usd', String(budget.maxCostUsd));
  if (evalCase.session.maxTurns !== undefined) args.push('--max-turns', String(evalCase.session.maxTurns));
  if (evalCase.session.allowedTools.length > 0) args.push('--allowedTools', ...evalCase.session.allowedTools);
  const disallowed = [...new Set([...evalCase.session.disallowedTools, ...variant.disallowedTools])];
  if (disallowed.length > 0) args.push('--disallowedTools', ...disallowed);
  return args;
}

/** What the session loaded that an eval of this variant should not have, or lacks. */
function environmentProblems(variant: EvalVariant, plugins: string[] | null): string[] {
  if (plugins === null) return [];
  const named = (name: string): boolean => name.toLowerCase() === JERRY_PLUGIN || name.toLowerCase().startsWith(`${JERRY_PLUGIN}@`);
  const others = plugins.filter((name) => !named(name));
  const problems = others.length === 0 ? [] : [`other plugin(s) loaded: ${others.join(', ')}`];
  if (variant.plugin && !plugins.some(named)) problems.push("JERRY's plugin did not load");
  if (!variant.plugin && plugins.some(named)) problems.push("JERRY's plugin loaded although the variant runs without it");
  return problems;
}

export async function runAttempt(evalCase: EvalCase, attempt: number, options: RunnerOptions, variant: EvalVariant = variantsOf(evalCase, false)[0] ?? DEFAULT_VARIANT): Promise<AttemptResult> {
  const started = Date.now();
  let fixture: Fixture | null = null;
  let core: { child: ChildProcess; info: CoreInfo } | null = null;
  let output = '';
  let costUsd: number | null = null;
  let sessionId: string | null = null;
  let tokens: SessionTokens | null = null;
  let turns: number | null = null;
  let sessionMs: number | null = null;
  let toolCalls: Record<string, number> = {};
  let environment: string[] = [];
  let results: GraderResult[] = [];
  let harnessError: string | null = null;
  try {
    fixture = createFixture(evalCase, options.parentDir);
    const home = path.join(fixture.base, 'jerry-home');
    core = await startCore(options.coreBundle, home, fixture.base);
    // JERRY monitors only projects: the fixture is added the way the user adds a repository.
    await request(core.info, 'POST', '/api/v1/projects', { path: fixture.repo });
    for (const [index, seed] of evalCase.setup.history.entries()) await seedHistory(core.info, fixture, seed, index);
    let taskId: string | null = null;
    if (evalCase.setup.task !== undefined) {
      const created = (await request(core.info, 'POST', '/api/v1/tasks', { repoPath: fixture.repo, title: evalCase.setup.task.title, scope: evalCase.setup.task.scope })) as { taskId: string };
      taskId = created.taskId;
      if (evalCase.setup.task.approve) await request(core.info, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    }
    const env: NodeJS.ProcessEnv = { ...process.env, JERRY_HOME: home, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
    const run = await runProcess(options.claudeBin, sessionArgs(evalCase, variant, options), { cwd: fixture.repo, env, timeoutMs: evalCase.session.timeoutMs });
    if (run.timedOut) throw new Error(`the session timed out after ${evalCase.session.timeoutMs} ms`);
    const transcript = parseTranscript(run.stdout);
    if (!transcript.finished) throw new Error(`the session gave no result (exit ${run.code}): ${(run.stderr || run.stdout).slice(0, 200)}`);
    ({ output, sessionId, costUsd, tokens, turns, toolCalls } = transcript);
    sessionMs = transcript.durationMs;
    environment = environmentProblems(variant, transcript.plugins);
    if (environment.some((problem) => problem.startsWith("JERRY's plugin"))) throw new Error(`the eval environment is wrong: ${environment.join('; ')}`);
    // Telemetry hooks are asynchronous: give them a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const taskState = taskId === null ? null : ((await request(core.info, 'GET', `/api/v1/tasks/${taskId}`)) as { state: string }).state;
    results = await grade(evalCase, {
      output,
      costUsd,
      fixture,
      events: variant.plugin ? await sessionEvents(home, sessionId) : [],
      taskState,
      variant,
      toolCalls,
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
  return {
    caseId: evalCase.id,
    variant: variant.id,
    attempt,
    outcome,
    results,
    harnessError,
    output: output.slice(0, 4000),
    costUsd,
    tokens,
    turns,
    toolCalls,
    durationMs: Date.now() - started,
    sessionMs,
    sessionId,
    environment,
    fixtureDir: keep && fixture !== null ? fixture.base : null,
  };
}

/** Runs every case (and, for a comparison, every variant) with its repeats, at most `parallel` (≤ 3) attempts at a time. */
export async function runSuite(cases: readonly EvalCase[], options: RunnerOptions): Promise<CaseResult[]> {
  const parallel = Math.min(Math.max(options.parallel ?? 3, 1), 3);
  // Attempt numbers run on across a case's variants: labels refer to (case, attempt).
  const jobs = cases.flatMap((evalCase) => {
    const repeats = options.repeats ?? repeatsOf(evalCase);
    return variantsOf(evalCase, options.allVariants === true).flatMap((variant, variantIndex) => Array.from({ length: repeats }, (_unused, index) => ({ evalCase, variant, attempt: variantIndex * repeats + index + 1 })));
  });
  const attempts = new Map<string, AttemptResult[]>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next]!;
      next += 1;
      const result = await runAttempt(job.evalCase, job.attempt, options, job.variant);
      options.onAttempt?.(result);
      attempts.set(job.evalCase.id, [...(attempts.get(job.evalCase.id) ?? []), result]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return cases.map((evalCase) => {
    const order = variantsOf(evalCase, true).map((variant) => variant.id);
    const own = (attempts.get(evalCase.id) ?? []).sort((a, b) => order.indexOf(a.variant) - order.indexOf(b.variant) || a.attempt - b.attempt);
    // The case outcome is the default variant's: the other variants are a comparison, not a gate.
    const gated = own.filter((entry) => entry.variant === order[0]);
    return { caseId: evalCase.id, suite: evalCase.suite, kind: evalCase.kind, critical: evalCase.critical, outcome: classify((gated.length > 0 ? gated : own).map((entry) => entry.outcome)), attempts: own };
  });
}
