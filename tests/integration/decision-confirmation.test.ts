import fs from 'node:fs';
import path from 'node:path';
import type { Settings, TaskDetail } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

const PORT = 47997;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['decision', 'confirmation', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;
type Auth = { cookie: string; csrf?: string };

/**
 * Quick decisions: with decisionConfirmation 'click' (the default) a dashboard session decides
 * reversible steps without typing the task ID; 'typed' brings the typed ID back. Irreversible
 * actions always need their typed confirmation, and CSRF, Origin and the session stay required.
 * Runs the real Fastify app through inject(), without a network.
 */
describe('decision confirmation: one click or the typed task ID (Core API)', () => {
  const base = tempDir('decision-confirmation');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const outsider = createFixtureRepo(path.join(base, 'outsider'));
  const databaseFile = path.join(base, 'jerry.sqlite');
  const openStore = () => StateStore.open({ databaseFile, backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
  let sessions: BrowserSessions;
  let store: StateStore;
  let app: FastifyInstance;
  let auth: { cookie: string; csrf: string };

  const build = (): FastifyInstance =>
    buildCoreApp({ token: TOKEN, store, jerryHome: path.join(base, 'home'), protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions, onShutdownRequested: () => undefined });

  beforeAll(async () => {
    sessions = new BrowserSessions();
    store = await openStore();
    app = build();
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

  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const url = new URL(login.url);
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const info = await app.inject({ method: 'GET', url: '/api/v1/ui/session', headers: { host: HOST, cookie } });
    return { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  }

  const asBrowser = (who: Auth, method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, cookie: who.cookie, origin: ORIGIN, ...(who.csrf === undefined ? {} : { 'x-jerry-csrf': who.csrf }) }, ...(payload === undefined ? {} : { payload }) });

  const setMode = async (decisionConfirmation: 'click' | 'typed'): Promise<void> => {
    const changed = await asCli('POST', '/api/v1/settings', { decisionConfirmation });
    expect(changed.statusCode, changed.body).toBe(200);
  };
  const stateOf = async (taskId: string): Promise<string> => ((await asCli('GET', `/api/v1/tasks/${taskId}`)).json() as TaskDetail).state;

  /** A task waiting for its plan decision. */
  async function plannedTask(title = 'Greeting'): Promise<string> {
    const plan = samplePlan(repo, ['src/**']);
    const created = await asCli('POST', '/api/v1/tasks', { repoPath: repo, title, scope: plan.scope.include, document: plan });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { taskId: string }).taskId;
  }
  /** A task with an approved plan and report v1, waiting for acceptance. */
  async function reportedTask(title = 'Reported'): Promise<string> {
    const taskId = await plannedTask(title);
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).statusCode).toBe(201);
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' })).statusCode).toBe(201);
    return taskId;
  }
  const approvePlan = (who: Auth, taskId: string, extra: Record<string, unknown> = {}) =>
    asBrowser(who, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED', ...extra });

  it('decides with one click by default', async () => {
    expect(((await asCli('GET', '/api/v1/settings')).json() as Settings).decisionConfirmation).toBe('click');
    expect(((await asBrowser(auth, 'GET', '/api/v1/settings')).json() as Settings).decisionConfirmation).toBe('click');
  });

  it('click mode: a session approves a plan without the typed ID, but only with its CSRF token and Origin', async () => {
    const taskId = await plannedTask();
    // Without the CSRF token, or from another origin: refused before the handler, nothing decided.
    expect((await approvePlan({ cookie: auth.cookie }, taskId)).statusCode).toBe(403);
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/approvals`,
      headers: { host: HOST, cookie: auth.cookie, origin: 'https://evil.example', 'x-jerry-csrf': auth.csrf },
      payload: { stage: 'PLAN', version: 1, decision: 'APPROVED' },
    });
    expect(foreign.statusCode).toBe(403);
    // Without a session: not signed in.
    const anonymous = await app.inject({ method: 'POST', url: `/api/v1/tasks/${taskId}/approvals`, headers: { host: HOST, origin: ORIGIN }, payload: { stage: 'PLAN', version: 1, decision: 'APPROVED' } });
    expect(anonymous.statusCode).toBe(401);
    expect(await stateOf(taskId)).toBe('WAIT_PLAN_APPROVAL');
    // A task ID sent anyway must be the right one.
    expect((await approvePlan(auth, taskId, { confirmTaskId: 'JRY-9999' })).statusCode).toBe(400);
    expect(await stateOf(taskId)).toBe('WAIT_PLAN_APPROVAL');

    const approved = await approvePlan(auth, taskId);
    expect(approved.statusCode, approved.body).toBe(201);
    expect(await stateOf(taskId)).toBe('IMPLEMENTATION');

    // The task ID typed or sent by the dashboard is accepted as well.
    const other = await plannedTask('With the ID');
    expect((await approvePlan(auth, other, { confirmTaskId: other })).statusCode).toBe(201);
  });

  it('click mode: reject a plan, request changes, accept with review and skip the review, all without the ID', async () => {
    const rejectedPlan = await plannedTask('Rejected plan');
    expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${rejectedPlan}/approvals`, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: 'smaller scope' })).statusCode).toBe(201);
    expect(await stateOf(rejectedPlan)).toBe('PLAN_DRAFT');

    const taskId = await reportedTask();
    const changes = await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'REJECTED', comment: 'handle empty names' });
    expect(changes.statusCode, changes.body).toBe(201);
    expect(await stateOf(taskId)).toBe('IMPLEMENTATION');
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' })).statusCode).toBe(201);

    const accepted = await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 2, decision: 'APPROVED', review: true });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ review: true });
    expect(await stateOf(taskId)).toBe('CODE_REVIEW');

    // The waiver still needs its reason.
    expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/review/skip`, { reason: ' ' })).statusCode).toBe(400);
    expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/review/skip`, { reason: 'small change', confirmTaskId: 'JRY-9999' })).statusCode).toBe(400);
    const skipped = await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/review/skip`, { reason: 'small change' });
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(await stateOf(taskId)).toBe('DONE');
  });

  it('click mode: pause and resume are one click, cancelling still needs the typed task ID', async () => {
    const taskId = await plannedTask('Cancelled');
    const control = (payload: Record<string, unknown>) => asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/transitions`, payload);
    expect((await control({ event: 'task.paused' })).statusCode).toBe(201);
    expect((await control({ event: 'task.resumed' })).statusCode).toBe(201);
    const refused = await control({ event: 'task.cancelled' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: expect.stringContaining('needs the task ID typed') });
    expect(await stateOf(taskId)).toBe('WAIT_PLAN_APPROVAL');
    expect((await control({ event: 'task.cancelled', confirmTaskId: taskId })).statusCode).toBe(201);
    expect(await stateOf(taskId)).toBe('CANCELLED');
  });

  it('click mode: adding or removing a project, deleting and forgetting data still need their typed confirmation', async () => {
    const add = await asBrowser(auth, 'POST', '/api/v1/projects', { path: outsider });
    expect(add.statusCode).toBe(400);
    expect(store.isMonitored(outsider)).toBe(false);
    const remove = await asBrowser(auth, 'POST', '/api/v1/projects/remove', { path: repo });
    expect(remove.statusCode).toBe(400);
    expect(store.isMonitored(repo)).toBe(true);
    const prune = await asBrowser(auth, 'POST', '/api/v1/data/prune', { eventsOlderThanDays: 3650 });
    expect(prune.statusCode).toBe(400);
    expect(prune.json()).toMatchObject({ error: expect.stringContaining('"delete"') });
    const forget = await asBrowser(auth, 'POST', '/api/v1/data/forget', { path: outsider });
    expect(forget.statusCode).toBe(400);
    // Any other word is not the typed confirmation.
    expect((await asBrowser(auth, 'POST', '/api/v1/data/prune', { eventsOlderThanDays: 3650, confirmation: 'yes' })).statusCode).toBe(400);
  });

  it('typed mode: the session needs the task ID for every decision; the CLI token does not', async () => {
    await setMode('typed');
    try {
      const taskId = await plannedTask('Typed');
      const refused = await approvePlan(auth, taskId);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: expect.stringContaining(`needs the task ID typed as confirmation (${taskId})`) });
      expect((await approvePlan(auth, taskId, { confirmTaskId: 'JRY-9999' })).statusCode).toBe(400);
      expect(await stateOf(taskId)).toBe('WAIT_PLAN_APPROVAL');
      expect((await approvePlan(auth, taskId, { confirmTaskId: taskId })).statusCode).toBe(201);

      const reported = await reportedTask('Typed report');
      expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${reported}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', review: true })).statusCode).toBe(400);
      expect(await stateOf(reported)).toBe('WAIT_IMPLEMENTATION_ACCEPTANCE');
      expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${reported}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', review: true, confirmTaskId: reported })).statusCode).toBe(201);
      expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${reported}/review/skip`, { reason: 'small change' })).statusCode).toBe(400);
      expect(await stateOf(reported)).toBe('CODE_REVIEW');
      expect((await asBrowser(auth, 'POST', `/api/v1/tasks/${reported}/review/skip`, { reason: 'small change', confirmTaskId: reported.toLowerCase() })).statusCode).toBe(200);

      // The CLI's token requests are unchanged: the terminal asked already.
      const cli = await plannedTask('From the CLI');
      expect((await asCli('POST', `/api/v1/tasks/${cli}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).statusCode).toBe(201);
      expect((await asCli('POST', `/api/v1/tasks/${cli}/transitions`, { event: 'task.cancelled' })).statusCode).toBe(201);
    } finally {
      await setMode('click');
    }
  });

  it('click mode: the CLI token path is unchanged', async () => {
    const taskId = await plannedTask('CLI in click mode');
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).statusCode).toBe(201);
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/transitions`, { event: 'task.cancelled' })).statusCode).toBe(201);
  });

  it('saves the setting from the CLI and from the dashboard (with CSRF), refuses unknown values, and keeps it after a restart', async () => {
    expect((await asCli('POST', '/api/v1/settings', { decisionConfirmation: 'never' })).statusCode).toBe(400);
    // Without the CSRF token: refused, nothing changes.
    expect((await asBrowser({ cookie: auth.cookie }, 'POST', '/api/v1/settings', { decisionConfirmation: 'typed' })).statusCode).toBe(403);
    expect(store.settings().decisionConfirmation).toBe('click');

    const changed = await asBrowser(auth, 'POST', '/api/v1/settings', { decisionConfirmation: 'typed' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'typed' });
    expect(((await asCli('GET', '/api/v1/settings')).json() as Settings).decisionConfirmation).toBe('typed');

    await app.close();
    await store.close();
    store = await openStore();
    app = build();
    expect(store.settings()).toEqual({ reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'typed' });
    // The restarted Core enforces it.
    auth = await signIn();
    const taskId = await plannedTask('After the restart');
    expect((await approvePlan(auth, taskId)).statusCode).toBe(400);
  });
});
