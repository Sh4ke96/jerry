import fs from 'node:fs';
import path from 'node:path';
import { EVENT_SCHEMA_VERSION, type FinalChecksRerun, type FinalReport, type GateDecision, type TaskDetail } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, ROOT, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

const PORT = 47996;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['later', 'work', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;
type Auth = { cookie: string; csrf?: string };

/** Lets the clock move on, so events, reports and transitions get distinct timestamps. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * Final checks and later approved work: task A reported, then task B (approved, in implementation)
 * changed A's files. B's work does not hold A back once B reported those files; everything else after
 * A's report still blocks. The user re-runs A's final checks (never Claude). Runs the real Fastify app
 * through inject(), with real Git in temporary repositories, without a network.
 */
describe('final checks ignore later approved work; the user re-runs them (Core API)', () => {
  const base = tempDir('later-work');
  const repoPass = createFixtureRepo(path.join(base, 'pass'));
  const repoBlock = createFixtureRepo(path.join(base, 'block'));
  let sessions: BrowserSessions;
  let store: StateStore;
  let app: FastifyInstance;
  let auth: { cookie: string; csrf: string };
  let toolUse = 0;

  beforeAll(async () => {
    sessions = new BrowserSessions();
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: path.join(base, 'home'), protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions, onShutdownRequested: () => undefined });
    await store.addProject(repoPass, new Date(), 'cli');
    await store.addProject(repoBlock, new Date(), 'cli');
    auth = await signIn();
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const asCli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });
  const asBrowser = (who: Auth, method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, cookie: who.cookie, origin: ORIGIN, ...(who.csrf === undefined ? {} : { 'x-jerry-csrf': who.csrf }) }, ...(payload === undefined ? {} : { payload }) });

  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const url = new URL(login.url);
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const info = await app.inject({ method: 'GET', url: '/api/v1/ui/session', headers: { host: HOST, cookie } });
    return { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  }

  const detail = async (taskId: string): Promise<TaskDetail> => (await asCli('GET', `/api/v1/tasks/${taskId}`)).json() as TaskDetail;

  /** A task with an approved plan over src/greeting/**, in implementation. */
  async function approvedTask(repo: string, title: string): Promise<string> {
    const plan = samplePlan(repo, ['src/greeting/**']);
    const created = await asCli('POST', '/api/v1/tasks', { repoPath: repo, title, scope: plan.scope.include, document: plan });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = (created.json() as { taskId: string }).taskId;
    const approved = await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    expect(approved.statusCode, approved.body).toBe(201);
    await tick();
    return taskId;
  }

  /** Claude's Write as the hook reports it to Core, then the file on disk. */
  async function write(repo: string, file: string, content: string): Promise<GateDecision> {
    toolUse += 1;
    const checked = await asCli('POST', '/api/v1/gate/check', { sessionId: 'session-later', cwd: repo, toolName: 'Write', toolInput: { file_path: path.join(repo, file) }, toolUseId: `toolu_${toolUse}`, agentId: null });
    expect(checked.statusCode, checked.body).toBe(200);
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
    await tick();
    return checked.json() as GateDecision;
  }

  /** A recorded edit with the given decision: an event evaluated late, or one from before decisions carried a task. */
  async function recordedEdit(repoRoot: string, file: string, taskId: string | null, at: Date): Promise<void> {
    toolUse += 1;
    await store.recordEvents(
      [
        {
          eventId: `evt_later_${toolUse}_${Math.random().toString(16).slice(2)}`,
          schemaVersion: EVENT_SCHEMA_VERSION,
          source: 'claude-code-hook',
          eventType: 'PreToolUse',
          timestamp: at.toISOString(),
          sessionId: 'session-later',
          agentId: null,
          agentType: null,
          cwd: repoRoot,
          toolName: 'Write',
          toolUseId: `toolu_${toolUse}`,
          taskId,
          repoRoot,
          verdict: 'PASS',
          ruleId: 'monitor.in-approved-scope',
          payload: { input: { path: path.join(repoRoot, file) } },
          redaction: { applied: false, reasons: [] },
          pendingEvaluation: false,
        },
      ],
      new Date(),
      false,
    );
  }

  const report = async (taskId: string, files: string[]): Promise<void> => {
    const submitted = await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(files), submittedBy: 'user' });
    expect(submitted.statusCode, submitted.body).toBe(201);
    await tick();
  };
  const accept = async (taskId: string): Promise<void> => {
    const accepted = await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', review: false });
    expect(accepted.statusCode, accepted.body).toBe(201);
  };
  const blockingOf = (task: TaskDetail) => task.finalCheck?.conditions.filter((condition) => condition.blocking && !condition.passed) ?? [];

  let taskA = '';
  let taskB = '';

  it("holds A back while B's work on its files is unreported, and lists B's later work", async () => {
    taskA = await approvedTask(repoPass, 'Greeting helper');
    expect(await write(repoPass, 'src/greeting/greet.ts', 'export const greet = (name: string) => `Hello, ${name}!`;\n')).toMatchObject({ ruleId: 'monitor.in-approved-scope', taskId: taskA });
    await report(taskA, ['src/greeting/greet.ts']);

    // B is approved while A waits for acceptance, and edits A's files under its own plan.
    taskB = await approvedTask(repoPass, 'Greeting formats');
    expect((await write(repoPass, 'src/greeting/greet.ts', 'export const greet = (name: string) => `Hi, ${name}!`;\n')).taskId).toBe(taskB);
    expect(await write(repoPass, 'src/greeting/format.ts', 'export const format = (text: string) => text.trim();\n')).toMatchObject({ ruleId: 'monitor.in-approved-scope', taskId: taskB });

    await accept(taskA);
    const task = await detail(taskA);
    // Git sees the changes too, and B has not reported them yet: they still block.
    expect(task.state).toBe('FINAL_REPORT');
    expect(blockingOf(task)).toEqual([{ id: 'code.unchanged-since-report', blocking: true, passed: false, detail: 'edited after report v1 was submitted: src/greeting/format.ts, src/greeting/greet.ts' }]);
    expect(task.finalCheck?.laterWork).toEqual([{ taskId: taskB, files: ['src/greeting/format.ts', 'src/greeting/greet.ts'] }]);
    expect(task.finalCheck?.conditions.find((condition) => condition.id === 'code.later-work')).toMatchObject({ blocking: false, passed: true, detail: `changed later by other tasks under their approved plans: ${taskB} (src/greeting/format.ts, src/greeting/greet.ts)` });
  });

  it('re-runs final checks only for the user and only in FINAL_REPORT', async () => {
    // Other states: refused, nothing changes.
    const implementing = await asCli('POST', `/api/v1/tasks/${taskB}/final-checks`, {});
    expect(implementing.statusCode).toBe(409);
    expect(implementing.json()).toMatchObject({ error: expect.stringContaining('only while the task is waiting in FINAL_REPORT') });
    expect((await detail(taskB)).state).toBe('IMPLEMENTATION');
    expect((await asCli('POST', '/api/v1/tasks/JRY-9999/final-checks', {})).statusCode).toBe(404);

    // A dashboard session without its CSRF token, from another origin, or no session at all: refused before the handler.
    expect((await asBrowser({ cookie: auth.cookie }, 'POST', `/api/v1/tasks/${taskA}/final-checks`, {})).statusCode).toBe(403);
    const foreign = await app.inject({ method: 'POST', url: `/api/v1/tasks/${taskA}/final-checks`, headers: { host: HOST, cookie: auth.cookie, origin: 'https://evil.example', 'x-jerry-csrf': auth.csrf }, payload: {} });
    expect(foreign.statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/tasks/${taskA}/final-checks`, headers: { host: HOST, origin: ORIGIN }, payload: {} })).statusCode).toBe(401);
    // A task ID sent anyway must be the right one.
    expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${taskA}/final-checks`, { confirmTaskId: 'JRY-9999' })).statusCode).toBe(400);
    expect((await detail(taskA)).finalCheck?.passed).toBe(false);

    // Not an MCP tool: Claude has no way to it (and the hard rules block direct Core API calls).
    const tools = fs.readFileSync(path.join(ROOT, 'apps', 'mcp-server', 'src', 'tools.ts'), 'utf8');
    expect(tools).not.toContain('/final-checks');
    // No tool may call it; mentioning the user's own 'jerry task recheck' in advice to Claude is fine.
    expect(tools).not.toMatch(/name:\s*'[^']*(recheck|rerun|final_checks)[^']*'/i);
    expect(tools).not.toMatch(/rerunFinal/);
    // ("jerry task recheck" needs an interactive terminal: tests/integration/cli.test.ts; the hard rules block it for agents.)
  });

  it("completes A once B reported the files, through the user's re-run, and keeps B in the final report", async () => {
    // Still unreported: a re-run from the CLI token gives the same answer and A waits.
    const early = await asCli('POST', `/api/v1/tasks/${taskA}/final-checks`, {});
    expect(early.statusCode, early.body).toBe(200);
    expect(early.json()).toMatchObject({ state: 'FINAL_REPORT', check: { passed: false } });

    await report(taskB, ['src/greeting/greet.ts', 'src/greeting/format.ts']);
    // One click from the dashboard (the default 'click' confirmation).
    const rerun = await asBrowser(auth, 'POST', `/api/v1/tasks/${taskA}/final-checks`, {});
    expect(rerun.statusCode, rerun.body).toBe(200);
    const result = rerun.json() as FinalChecksRerun;
    expect(result.state).toBe('DONE');
    expect(result.check).toMatchObject({ taskId: taskA, reportVersion: 1, passed: true, laterWork: [{ taskId: taskB, files: ['src/greeting/format.ts', 'src/greeting/greet.ts'] }] });
    expect(result.check.conditions.find((condition) => condition.id === 'code.unchanged-since-report')).toMatchObject({ passed: true, detail: 'no in-scope file was edited after the report other than by later approved tasks' });

    const task = await detail(taskA);
    expect(task.state).toBe('DONE');
    expect(task.finalCheck?.laterWork).toEqual([{ taskId: taskB, files: ['src/greeting/format.ts', 'src/greeting/greet.ts'] }]);
    const history = (await asCli('GET', `/api/v1/tasks/${taskA}/transitions`)).json() as Array<{ event: string; actor: string }>;
    expect(history.slice(-2).map((step) => `${step.event}:${step.actor}`)).toEqual(['implementation.accepted:user', 'task.completed:core']);
    const final = (await asCli('GET', `/api/v1/tasks/${taskA}/final-report`)).json() as FinalReport;
    expect(final).toMatchObject({ status: 'final', laterWork: [{ taskId: taskB, files: ['src/greeting/format.ts', 'src/greeting/greet.ts'] }] });

    // Done is done.
    expect((await asCli('POST', `/api/v1/tasks/${taskA}/final-checks`, {})).statusCode).toBe(409);
  });

  it('still blocks unplanned edits, edits under the task itself, edits outside the other task’s implementation, unattributed events and changes only Git saw', async () => {
    const task = await approvedTask(repoBlock, 'Parser');
    await write(repoBlock, 'src/greeting/greet.ts', 'export const greet = () => "Hello";\n');
    await report(task, ['src/greeting/greet.ts']);
    const repoRoot = (await detail(task)).repoRoot;

    // No approved plan covers the file now: a deviation.
    expect(await write(repoBlock, 'src/greeting/unplanned.ts', 'export {};\n')).toMatchObject({ ruleId: 'monitor.no-approved-plan', taskId: null });
    // Recorded under the task itself after its report (an event evaluated late), and an old event without a task.
    await recordedEdit(repoRoot, 'src/greeting/own.ts', task, new Date());
    await recordedEdit(repoRoot, 'src/greeting/old.ts', null, new Date());
    const beforeOther = new Date();
    await tick();

    const other = await approvedTask(repoBlock, 'Lexer');
    // Named the other task, but before that task was in implementation.
    await recordedEdit(repoRoot, 'src/greeting/early.ts', other, beforeOther);
    // A shell command changed a file in scope: only Git saw it.
    fs.writeFileSync(path.join(repoBlock, 'src', 'greeting', 'shell.ts'), 'export const generated = true;\n');
    // The other task's file-tool edit is its later work, but its report does not list the file Git saw changed.
    expect((await write(repoBlock, 'src/greeting/lexer.ts', 'export const lex = () => [];\n')).taskId).toBe(other);
    await report(other, ['src/greeting/tokens.ts']);

    await accept(task);
    const held = await detail(task);
    expect(held.state).toBe('FINAL_REPORT');
    expect(blockingOf(held)).toEqual([
      {
        id: 'code.unchanged-since-report',
        blocking: true,
        passed: false,
        detail: 'edited after report v1 was submitted: src/greeting/early.ts, src/greeting/lexer.ts, src/greeting/old.ts, src/greeting/own.ts, src/greeting/shell.ts, src/greeting/unplanned.ts',
      },
    ]);
    expect(held.finalCheck?.laterWork).toEqual([{ taskId: other, files: ['src/greeting/lexer.ts'] }]);

    // Typed confirmations: the dashboard needs the task ID; the re-run answers and the task still waits.
    expect((await asCli('POST', '/api/v1/settings', { decisionConfirmation: 'typed' })).statusCode).toBe(200);
    try {
      const refused = await asBrowser(auth, 'POST', `/api/v1/tasks/${task}/final-checks`, {});
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: `Type ${task} to confirm re-running its final checks` });
      const typed = await asBrowser(auth, 'POST', `/api/v1/tasks/${task}/final-checks`, { confirmTaskId: task.toLowerCase() });
      expect(typed.statusCode, typed.body).toBe(200);
      expect(typed.json()).toMatchObject({ state: 'FINAL_REPORT', check: { passed: false } });
    } finally {
      expect((await asCli('POST', '/api/v1/settings', { decisionConfirmation: 'click' })).statusCode).toBe(200);
    }
  });
});
