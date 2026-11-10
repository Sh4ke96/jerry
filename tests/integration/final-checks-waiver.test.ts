import fs from 'node:fs';
import path from 'node:path';
import type { FinalChecksRerun, FinalReport, HistoryResponse, TaskDetail, WorkflowTransition } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, ROOT, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

const PORT = 47995;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['final', 'checks', 'waiver'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;
type Auth = { cookie: string; csrf?: string };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * The user completes a task the final checks refused, with a reason: only the user (CLI token after
 * the terminal asked, or a dashboard session with CSRF and the typed task ID), only from FINAL_REPORT,
 * only for the blockers they saw. The check stays failed; the waiver is recorded and shown.
 */
describe('completing a task despite failed final checks (Core API)', () => {
  const base = tempDir('waiver');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  let store: StateStore;
  let app: FastifyInstance;
  let auth: { cookie: string; csrf: string };

  beforeAll(async () => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: path.join(base, 'home'), protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions: new BrowserSessions(), onShutdownRequested: () => undefined });
    await store.addProject(repo, new Date(), 'cli');
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
  const waive = (taskId: string) => `/api/v1/tasks/${taskId}/final-checks/waive`;

  /** A task whose accepted report has a failed check: Core refuses DONE (report.no-failed-checks). */
  async function refusedTask(title: string): Promise<string> {
    const plan = samplePlan(repo, ['src/greeting/**']);
    const created = await asCli('POST', '/api/v1/tasks', { repoPath: repo, title, scope: plan.scope.include, document: plan });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = (created.json() as { taskId: string }).taskId;
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).statusCode).toBe(201);
    await tick();
    const failing = { ...sampleReport(['src/greeting/greet.ts']), checks: [{ kind: 'test', command: 'npm test', result: 'FAIL', details: 'expected red before the fix' }] };
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: failing, submittedBy: 'user' })).statusCode).toBe(201);
    await tick();
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', review: false })).statusCode).toBe(201);
    const task = await detail(taskId);
    expect(task.state).toBe('FINAL_REPORT');
    expect(task.finalCheck?.conditions.filter((condition) => condition.blocking && !condition.passed).map((condition) => condition.id)).toEqual(['report.no-failed-checks']);
    return taskId;
  }

  let cliTask = '';

  it('refuses everyone but the user, a blank reason, and a waiver of blockers the user did not see', async () => {
    cliTask = await refusedTask('Waived from the CLI');
    const body = { reason: 'the failing run was the reproduction before the fix', seen: ['report.no-failed-checks'] };
    // No session, no CSRF, another origin: refused before the handler.
    expect((await app.inject({ method: 'POST', url: waive(cliTask), headers: { host: HOST, origin: ORIGIN }, payload: body })).statusCode).toBe(401);
    expect((await asBrowser({ cookie: auth.cookie }, 'POST', waive(cliTask), { ...body, confirmTaskId: cliTask })).statusCode).toBe(403);
    const foreign = await app.inject({ method: 'POST', url: waive(cliTask), headers: { host: HOST, cookie: auth.cookie, origin: 'https://evil.example', 'x-jerry-csrf': auth.csrf }, payload: { ...body, confirmTaskId: cliTask } });
    expect(foreign.statusCode).toBe(403);
    // The dashboard always needs the typed task ID: completing cannot be undone.
    const untyped = await asBrowser(auth, 'POST', waive(cliTask), body);
    expect(untyped.statusCode).toBe(400);
    expect(untyped.json()).toMatchObject({ error: expect.stringContaining('needs the task ID typed as confirmation') });
    // A reason is required.
    expect((await asCli('POST', waive(cliTask), { ...body, reason: '   ' })).statusCode).toBe(400);
    // The user saw other blockers than the ones failing now: nothing changes.
    const stale = await asCli('POST', waive(cliTask), { ...body, seen: ['code.unchanged-since-report'] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: expect.stringContaining('changed since you looked') });
    expect((await detail(cliTask)).state).toBe('FINAL_REPORT');
    expect((await asCli('POST', waive('JRY-9999'), body)).statusCode).toBe(404);
  });

  it('completes the task as the user, keeps the check failed and records the waiver everywhere', async () => {
    const reason = 'the failing run was the reproduction before the fix';
    const done = await asCli('POST', waive(cliTask), { reason, seen: ['report.no-failed-checks'] });
    expect(done.statusCode, done.body).toBe(200);
    const result = done.json() as FinalChecksRerun;
    expect(result.state).toBe('DONE');
    expect(result.check).toMatchObject({ passed: false, waiver: { reason, channel: 'cli', conditions: [{ id: 'report.no-failed-checks' }] } });

    const task = await detail(cliTask);
    expect(task.state).toBe('DONE');
    expect(task.finalCheck).toMatchObject({ passed: false, waiver: { reason, channel: 'cli' } });
    const transitions = (await asCli('GET', `/api/v1/tasks/${cliTask}/transitions`)).json() as WorkflowTransition[];
    expect(transitions.at(-1)).toMatchObject({ event: 'final-checks.waived', actor: 'user', to: 'DONE', reason: expect.stringContaining(reason) });
    // Core itself never completed it.
    expect(transitions.some((step) => step.event === 'task.completed')).toBe(false);

    const report = (await asCli('GET', `/api/v1/tasks/${cliTask}/final-report`)).json() as FinalReport;
    expect(report).toMatchObject({ status: 'final', completion: { kind: 'waived', waiver: { reason } }, definitionOfDone: { passed: false } });
    expect(report.limitations).toContain('waived by the user (final checks did not pass): failed: npm test');
    expect(report.decisions.some((decision) => decision.includes('final-checks.waived') && decision.includes(reason))).toBe(true);

    // Later work learns that this task was not checked.
    const history = (await asCli('GET', `/api/v1/history?repoPath=${encodeURIComponent(repo)}&query=${encodeURIComponent('Waived from the CLI')}`)).json() as HistoryResponse;
    expect(history.tasks.find((entry) => entry.taskId === cliTask)?.decisions[0]).toContain("DONE by the user's waiver; JERRY's final checks did NOT pass");

    // Done is done: a second waiver is refused.
    expect((await asCli('POST', waive(cliTask), { reason, seen: ['report.no-failed-checks'] })).statusCode).toBe(409);
  });

  it('completes from the dashboard with the typed task ID (any case) and CSRF', async () => {
    const taskId = await refusedTask('Waived from the dashboard');
    const done = await asBrowser(auth, 'POST', waive(taskId), { reason: 'accepted risk', seen: ['report.no-failed-checks'], confirmTaskId: taskId.toLowerCase() });
    expect(done.statusCode, done.body).toBe(200);
    expect((await detail(taskId)).finalCheck?.waiver).toMatchObject({ channel: 'dashboard', reason: 'accepted risk' });
    // A normal DONE carries no waiver and reads as passed.
    const report = (await asCli('GET', `/api/v1/tasks/${taskId}/final-report`)).json() as FinalReport;
    expect(report.completion?.kind).toBe('waived');
  });

  it('is not an MCP tool: Claude has no way to it', () => {
    const tools = fs.readFileSync(path.join(ROOT, 'apps', 'mcp-server', 'src', 'tools.ts'), 'utf8');
    expect(tools).not.toContain('/final-checks');
    expect(tools).not.toMatch(/name:\s*'[^']*(waive|complete_task|complete_anyway)[^']*'/i);
    expect(tools).not.toMatch(/waiveFinal/);
  });
});
