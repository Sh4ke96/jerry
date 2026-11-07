import fs from 'node:fs';
import path from 'node:path';
import type { FinalReport, ProjectSummary, Settings, TaskDetail, TaskSummary, WorkflowTransition } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

const PORT = 47998;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['optional', 'review', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

/**
 * Review is optional by default: accepting finishes the task after the final checks unless the
 * user asks for review; the review mode (global, or a project's own) can require it. Runs the real
 * Fastify app through inject(), without a network.
 */
describe('optional review and the workflow settings (Core API)', () => {
  const base = tempDir('optional-review');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const other = createFixtureRepo(path.join(base, 'other'));
  const sessions = new BrowserSessions();
  let store: StateStore;
  let app: FastifyInstance;

  beforeAll(async () => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: path.join(base, 'home'), protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions, onShutdownRequested: () => undefined });
    await store.addProject(repo, new Date(), 'cli');
    await store.addProject(other, new Date(), 'cli');
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

  const asBrowser = (auth: { cookie: string; csrf?: string }, method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, cookie: auth.cookie, origin: ORIGIN, ...(auth.csrf === undefined ? {} : { 'x-jerry-csrf': auth.csrf }) }, ...(payload === undefined ? {} : { payload }) });

  /** A task with an approved plan and a submitted report v1, waiting for acceptance. */
  async function reportedTask(root = repo, title = 'Greeting'): Promise<string> {
    const plan = samplePlan(root, ['src/**']);
    const created = await asCli('POST', '/api/v1/tasks', { repoPath: root, title, scope: plan.scope.include, document: plan });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = (created.json() as { taskId: string }).taskId;
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).statusCode).toBe(201);
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' })).statusCode).toBe(201);
    return taskId;
  }
  const accept = (taskId: string, extra: Record<string, unknown> = {}) => asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', ...extra });
  const detail = async (taskId: string): Promise<TaskDetail> => (await asCli('GET', `/api/v1/tasks/${taskId}`)).json() as TaskDetail;
  const settings = async (): Promise<Settings> => (await asCli('GET', '/api/v1/settings')).json() as Settings;
  const project = async (root: string): Promise<ProjectSummary> => ((await asCli('GET', '/api/v1/projects')).json() as ProjectSummary[]).find((candidate) => candidate.repoRoot === root)!;

  it('starts with review optional and QA scenarios in Polish', async () => {
    expect(await settings()).toEqual({ reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' });
    expect(await project(repo)).toMatchObject({ reviewMode: null, effectiveReviewMode: 'optional' });
  });

  it('accepting without a choice finishes the task through the final checks, without review', async () => {
    const taskId = await reportedTask();
    const before = (await detail(taskId)) as TaskSummary;
    expect(before).toMatchObject({ reviewRequested: null, effectiveReviewMode: 'optional' });

    const accepted = await accept(taskId);
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ stage: 'IMPLEMENTATION', decision: 'APPROVED', review: false });

    const task = await detail(taskId);
    expect(task.state).toBe('DONE');
    expect(task).toMatchObject({ reviewRequested: false, effectiveReviewMode: 'optional' });
    expect(task.finalCheck?.conditions.find((condition) => condition.id === 'review.done')).toMatchObject({ blocking: false, passed: true, detail: expect.stringContaining('review was not requested') });
    const history = (await asCli('GET', `/api/v1/tasks/${taskId}/transitions`)).json() as WorkflowTransition[];
    expect(history.slice(-2).map((step) => `${step.from}>${step.to} ${step.event}`)).toEqual(['WAIT_IMPLEMENTATION_ACCEPTANCE>FINAL_REPORT implementation.accepted', 'FINAL_REPORT>DONE task.completed']);
    expect(((await asCli('GET', `/api/v1/tasks/${taskId}/review`)).json() as { rounds: unknown[] }).rounds).toEqual([]);

    // The final report says so.
    const report = (await asCli('GET', `/api/v1/tasks/${taskId}/final-report`)).json() as FinalReport;
    expect(report.status).toBe('final');
    expect(report.review).toMatchObject({ requested: false, outcome: 'not requested', rounds: 0 });
  });

  it('sends the work to independent review when the user asks for it', async () => {
    const taskId = await reportedTask();
    expect((await accept(taskId, { review: true })).json()).toMatchObject({ review: true });
    const task = await detail(taskId);
    expect(task).toMatchObject({ state: 'CODE_REVIEW', reviewRequested: true });
    expect(((await asCli('GET', `/api/v1/tasks/${taskId}/review`)).json() as { rounds: unknown[] }).rounds).toHaveLength(1);
    expect(((await asCli('GET', `/api/v1/tasks/${taskId}/final-report`)).json() as FinalReport).review).toMatchObject({ requested: true, outcome: 'not finished' });

    // A task already in review is finished by the user's waiver, as before.
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/review/skip`, { reason: 'reviewed in the meeting' })).statusCode).toBe(200);
    const finished = await detail(taskId);
    expect(finished.state).toBe('DONE');
    expect(finished.finalCheck?.conditions.find((condition) => condition.id === 'review.done')).toMatchObject({ blocking: true, passed: true, detail: 'the user waived the review: reviewed in the meeting' });
  });

  it('refuses a review choice on any decision other than accepting an implementation', async () => {
    const plan = samplePlan(repo, ['src/**']);
    const taskId = ((await asCli('POST', '/api/v1/tasks', { repoPath: repo, title: 'Plan only', scope: plan.scope.include, document: plan })).json() as { taskId: string }).taskId;
    const refused = await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED', review: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: expect.stringContaining('review applies only to accepting an implementation') });
    expect((await detail(taskId)).state).toBe('WAIT_PLAN_APPROVAL');
  });

  it('a required review mode forces review and refuses accepting without it', async () => {
    const changed = await asCli('POST', '/api/v1/settings', { reviewMode: 'required' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ reviewMode: 'required', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' });
    expect(await project(repo)).toMatchObject({ reviewMode: null, effectiveReviewMode: 'required' });

    const taskId = await reportedTask();
    expect(await detail(taskId)).toMatchObject({ effectiveReviewMode: 'required', reviewRequested: null });
    const refused = await accept(taskId, { review: false });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: expect.stringContaining('review is required') });
    expect((await detail(taskId)).state).toBe('WAIT_IMPLEMENTATION_ACCEPTANCE');

    expect((await accept(taskId)).json()).toMatchObject({ review: true });
    expect(await detail(taskId)).toMatchObject({ state: 'CODE_REVIEW', reviewRequested: true });
  });

  it("a project's own review mode wins over the global one, and inherit follows it again", async () => {
    const own = await asCli('POST', '/api/v1/projects/settings', { path: path.join(other, 'src'), reviewMode: 'optional' });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ repoRoot: other, reviewMode: 'optional', effectiveReviewMode: 'optional', openTasks: 0 });
    expect(await project(repo)).toMatchObject({ reviewMode: null, effectiveReviewMode: 'required' });

    const taskId = await reportedTask(other, 'Other project');
    expect(await detail(taskId)).toMatchObject({ effectiveReviewMode: 'optional' });
    expect((await accept(taskId)).json()).toMatchObject({ review: false });
    expect((await detail(taskId)).state).toBe('DONE');

    expect((await asCli('POST', '/api/v1/projects/settings', { path: other, reviewMode: null })).json()).toMatchObject({ reviewMode: null, effectiveReviewMode: 'required' });
    expect((await asCli('POST', '/api/v1/projects/settings', { path: path.join(base, 'not-a-project'), reviewMode: 'required' })).statusCode).toBe(404);
    expect((await asCli('POST', '/api/v1/projects/settings', { path: other, reviewMode: 'sometimes' })).statusCode).toBe(400);
  });

  it('changes settings for the CLI token and for the dashboard only with its CSRF token', async () => {
    expect((await asCli('POST', '/api/v1/settings', {})).statusCode).toBe(400);
    expect((await asCli('POST', '/api/v1/settings', { qaLanguage: 'de' })).statusCode).toBe(400);
    expect((await asCli('POST', '/api/v1/settings', { reviewMode: 'optional', qaLanguage: 'en' })).json()).toEqual({ reviewMode: 'optional', qaLanguage: 'en', usageShowBar: true, decisionConfirmation: 'click' });

    const auth = await signIn();
    expect((await asBrowser(auth, 'GET', '/api/v1/settings')).json()).toEqual({ reviewMode: 'optional', qaLanguage: 'en', usageShowBar: true, decisionConfirmation: 'click' });
    // No CSRF token: refused, nothing changes.
    expect((await asBrowser({ cookie: auth.cookie }, 'POST', '/api/v1/settings', { qaLanguage: 'pl' })).statusCode).toBe(403);
    expect((await asBrowser({ cookie: auth.cookie }, 'POST', '/api/v1/projects/settings', { path: repo, reviewMode: 'required' })).statusCode).toBe(403);
    expect(await settings()).toEqual({ reviewMode: 'optional', qaLanguage: 'en', usageShowBar: true, decisionConfirmation: 'click' });
    expect(await project(repo)).toMatchObject({ reviewMode: null });
    // From another origin: refused as well.
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/settings', headers: { host: HOST, cookie: auth.cookie, origin: 'https://evil.example', 'x-jerry-csrf': auth.csrf }, payload: { qaLanguage: 'pl' } });
    expect(foreign.statusCode).toBe(403);

    // With it, a plain setting change needs no typed confirmation.
    const changed = await asBrowser(auth, 'POST', '/api/v1/settings', { qaLanguage: 'pl' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toEqual({ reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' });
    const own = await asBrowser(auth, 'POST', '/api/v1/projects/settings', { path: repo, reviewMode: 'required' });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ repoRoot: repo, reviewMode: 'required', effectiveReviewMode: 'required' });
  });

  it('tells the repository state which preferences apply there', async () => {
    const state = (await asCli('GET', `/api/v1/repositories/state?path=${encodeURIComponent(repo)}`)).json() as { preferences: unknown };
    expect(state.preferences).toEqual({ qaLanguage: 'pl', reviewMode: 'required' });
    const elsewhere = (await asCli('GET', `/api/v1/repositories/state?path=${encodeURIComponent(other)}`)).json() as { preferences: unknown };
    expect(elsewhere.preferences).toEqual({ qaLanguage: 'pl', reviewMode: 'optional' });
  });

  it('keeps the settings after a restart', async () => {
    const reopened = await StateStore.open({ databaseFile: path.join(base, 'copy.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    try {
      // A fresh database has the defaults.
      expect(reopened.settings()).toEqual({ reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' });
    } finally {
      await reopened.close();
    }
    await store.close();
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    expect(store.settings()).toEqual({ reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' });
    expect(store.projects().find((candidate) => candidate.repoRoot === repo)).toMatchObject({ reviewMode: 'required' });
    expect(store.effectiveReviewModeAt(path.join(repo, 'src'))).toBe('required');
  });
});
