import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { DecisionWaitResult, TaskDetail } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

const PORT = 47996;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['decision', 'wait', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

const decisionUrl = (taskId: string, stage: string, version: number, waitMs: number): string => `/api/v1/tasks/${taskId}/decision?${new URLSearchParams({ stage, version: String(version), waitMs: String(waitMs) }).toString()}`;

/**
 * Claude waits for the user's decision after a submission: GET /api/v1/tasks/:id/decision is a long
 * poll that answers at once when the decision exists, else when it arrives or after waitMs. It is
 * token only and read-only. Runs the real Fastify app in process (inject, and a real socket for the
 * disconnect and shutdown cases).
 */
describe('waiting for the user decision (Core API)', () => {
  const base = tempDir('decision-wait');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const databaseFile = path.join(base, 'jerry.sqlite');
  let sessions: BrowserSessions;
  let store: StateStore;
  let app: FastifyInstance;

  const build = (port: () => number): FastifyInstance =>
    buildCoreApp({ token: TOKEN, store, jerryHome: path.join(base, 'home'), protectedRoots: [], startedAt: new Date(), port, sessions, onShutdownRequested: () => undefined });

  beforeAll(async () => {
    sessions = new BrowserSessions();
    store = await StateStore.open({ databaseFile, backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = build(() => PORT);
    await store.addProject(repo, new Date(), 'cli');
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const asCli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });

  const waitFor = async (taskId: string, stage: string, version: number, waitMs: number): Promise<DecisionWaitResult> => {
    const response = await asCli('GET', decisionUrl(taskId, stage, version, waitMs));
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as DecisionWaitResult;
  };

  async function plannedTask(title = 'Greeting'): Promise<string> {
    const plan = samplePlan(repo, ['src/**']);
    const created = await asCli('POST', '/api/v1/tasks', { repoPath: repo, title, scope: plan.scope.include, document: plan });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { taskId: string }).taskId;
  }

  const decide = async (taskId: string, body: Record<string, unknown>): Promise<void> => {
    const response = await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, body);
    expect(response.statusCode, response.body).toBe(201);
  };

  /** Everything a wait could change if it were not read-only. */
  const footprint = async (taskId: string): Promise<unknown> => {
    const detail = (await asCli('GET', `/api/v1/tasks/${taskId}`)).json() as TaskDetail;
    return { state: detail.state, planDecision: detail.planDecision, transitions: (await asCli('GET', `/api/v1/tasks/${taskId}/transitions`)).json(), approvals: store.snapshot().approvals.length };
  };

  it('answers at once when the decision on that version already exists', async () => {
    const taskId = await plannedTask();
    await decide(taskId, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    const started = Date.now();
    const result = await waitFor(taskId, 'plan', 1, 60_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ taskId, stage: 'plan', version: 1, status: 'approved', state: 'IMPLEMENTATION' });
    expect(result.decidedAt).toEqual(expect.any(String));
    expect(result.comment).toBeUndefined();
  });

  it('waits and returns the approval as soon as the user gives it', async () => {
    const taskId = await plannedTask();
    const started = Date.now();
    const waiting = waitFor(taskId, 'plan', 1, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await decide(taskId, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    expect(await waiting).toMatchObject({ status: 'approved', state: 'IMPLEMENTATION' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns a rejection with the user's comment", async () => {
    const taskId = await plannedTask();
    const waiting = waitFor(taskId, 'plan', 1, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await decide(taskId, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: 'Split step 2 into two steps' });
    expect(await waiting).toMatchObject({ status: 'rejected', comment: 'Split step 2 into two steps' });
  });

  it("answers 'pending' after waitMs and changes nothing", async () => {
    const taskId = await plannedTask();
    const before = await footprint(taskId);
    const started = Date.now();
    expect(await waitFor(taskId, 'plan', 1, 1_200)).toEqual({ taskId, stage: 'plan', version: 1, status: 'pending', state: 'WAIT_PLAN_APPROVAL' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_100);
    expect(await footprint(taskId)).toEqual(before);
  });

  it('binds to the exact stage and version: a decision on another one does not count', async () => {
    const taskId = await plannedTask();
    await decide(taskId, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    expect(await waitFor(taskId, 'plan', 2, 0)).toMatchObject({ status: 'pending' });
    expect(await waitFor(taskId, 'implementation', 1, 0)).toMatchObject({ status: 'pending', state: 'IMPLEMENTATION' });
    expect(await waitFor(taskId, 'review-fix', 1, 0)).toMatchObject({ status: 'pending' });
  });

  it('returns whether an accepted report goes to review', async () => {
    const taskId = await plannedTask('Reported');
    await decide(taskId, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' })).statusCode).toBe(201);
    expect(await waitFor(taskId, 'implementation', 1, 0)).toMatchObject({ status: 'pending', state: 'WAIT_IMPLEMENTATION_ACCEPTANCE' });
    await decide(taskId, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', review: true });
    expect(await waitFor(taskId, 'implementation', 1, 0)).toMatchObject({ status: 'approved', review: true });
  });

  it('stops waiting for a cancelled task: no decision will come', async () => {
    const taskId = await plannedTask();
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/transitions`, { event: 'task.cancelled' })).statusCode).toBe(201);
    const started = Date.now();
    expect(await waitFor(taskId, 'plan', 1, 20_000)).toMatchObject({ status: 'pending', state: 'CANCELLED' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses bad requests: unknown task, unknown stage, missing version', async () => {
    expect((await asCli('GET', decisionUrl('JRY-9999', 'plan', 1, 0))).statusCode).toBe(404);
    const taskId = await plannedTask();
    expect((await asCli('GET', `/api/v1/tasks/${taskId}/decision?stage=approve&version=1`)).statusCode).toBe(400);
    expect((await asCli('GET', `/api/v1/tasks/${taskId}/decision?stage=plan`)).statusCode).toBe(400);
  });

  it('is for the token only: not the dashboard, not anonymous callers', async () => {
    const taskId = await plannedTask();
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const url = new URL(login.url);
    const signedIn = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ method: 'GET', url: decisionUrl(taskId, 'plan', 1, 0), headers: { host: HOST, cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: decisionUrl(taskId, 'plan', 1, 0), headers: { host: HOST } })).statusCode).toBe(401);
  });

  describe('over a real socket', () => {
    let port = 0;
    let served: FastifyInstance;
    let closed = false;

    beforeAll(async () => {
      served = build(() => port);
      await served.listen({ host: '127.0.0.1', port: 0 });
      port = (served.server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      if (!closed) await served.close();
    });

    const open = (taskId: string, waitMs: number): { request: http.ClientRequest; answer: Promise<{ status: number; body: unknown }> } => {
      let request!: http.ClientRequest;
      const answer = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        request = http.request({ host: '127.0.0.1', port, method: 'GET', path: decisionUrl(taskId, 'plan', 1, waitMs), headers: { authorization: `Bearer ${TOKEN}` } }, (response) => {
          let text = '';
          response.on('data', (chunk: Buffer) => (text += chunk.toString()));
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
        });
        request.on('error', reject);
        request.end();
      });
      return { request, answer };
    };

    it('stops polling when the client disconnects, and Core keeps answering', async () => {
      const taskId = await plannedTask();
      const lookups = vi.spyOn(store, 'decisionOn');
      try {
        const { request, answer } = open(taskId, 30_000);
        answer.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 1_300));
        expect(lookups.mock.calls.length).toBeGreaterThan(0);
        request.destroy();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const settled = lookups.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 2_200));
        expect(lookups.mock.calls.length).toBe(settled);
      } finally {
        lookups.mockRestore();
      }
      expect(await waitFor(taskId, 'plan', 1, 0)).toMatchObject({ status: 'pending', state: 'WAIT_PLAN_APPROVAL' });
    });

    it("does not hold Core's shutdown: an open wait answers 'pending'", async () => {
      const taskId = await plannedTask();
      const { answer } = open(taskId, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = Date.now();
      await served.close();
      closed = true;
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(await answer).toMatchObject({ status: 200, body: { status: 'pending' } });
    });
  });
});
