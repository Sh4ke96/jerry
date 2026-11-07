import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions, LOGIN_CODE_TTL_MS, SESSION_COOKIE } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, ROOT, tempDir } from '../helpers/harness.js';

/** Built by the global test setup (scripts/build.mjs). */
const DASHBOARD_DIR = path.join(ROOT, 'dist', 'core', 'dashboard');

const PORT = 47999;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = 'a'.repeat(64);
type Payload = NonNullable<InjectOptions['payload']>;

/**
 * Who may call what. Runs the real Fastify app through inject(), without a network.
 */
describe('Core API access control', () => {
  const base = tempDir('api-auth');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  let clock = Date.now();
  const sessions = new BrowserSessions(() => clock);
  let store: StateStore;
  let app: FastifyInstance;
  let taskId: string;

  beforeAll(async () => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: base, protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions, dashboardDir: DASHBOARD_DIR, onShutdownRequested: () => undefined });
    taskId = (await store.createTask({ repoRoot: repo, title: 'Dashboard approval', scope: ['src/**'] }, new Date())).taskId;
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
    const loginResponse: LightMyRequestResponse = await app.inject({ method: 'GET', url: new URL(login.url).pathname + new URL(login.url).search, headers: { host: HOST } });
    expect(loginResponse.statusCode).toBe(302);
    const setCookie = String(loginResponse.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    const info = await app.inject({ method: 'GET', url: '/api/v1/ui/session', headers: { host: HOST, cookie } });
    return { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  }

  const asBrowser = (auth: { cookie: string; csrf?: string }, method: 'GET' | 'POST', url: string, extra: { origin?: string | null; payload?: Payload; site?: string } = {}): Promise<LightMyRequestResponse> =>
    app.inject({
      method,
      url,
      headers: {
        host: HOST,
        cookie: auth.cookie,
        ...(extra.origin === null ? {} : { origin: extra.origin ?? ORIGIN }),
        ...(auth.csrf === undefined ? {} : { 'x-jerry-csrf': auth.csrf }),
        ...(extra.site === undefined ? {} : { 'sec-fetch-site': extra.site }),
      },
      ...(extra.payload === undefined ? {} : { payload: extra.payload }),
    });

  const status = (response: LightMyRequestResponse): number => response.statusCode;

  it('answers only its own loopback host names (DNS rebinding)', async () => {
    expect(status(await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example:47999' } }))).toBe(421);
    expect(status(await app.inject({ method: 'GET', url: '/health', headers: { host: HOST } }))).toBe(200);
  });

  it('keeps the API closed without credentials', async () => {
    expect(status(await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { host: HOST } }))).toBe(401);
    expect(status(await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { host: HOST, authorization: `Bearer ${'b'.repeat(64)}` } }))).toBe(401);
  });

  it('refuses the CLI token when it comes from a browser page', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { host: HOST, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' } });
    expect(status(response)).toBe(403);
  });

  it('turns a one-time login code into a session cookie, once', async () => {
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const url = new URL(login.url);
    expect(url.origin).toBe(ORIGIN);
    const first = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    expect(first.statusCode).toBe(302);
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    const second = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    expect(second.statusCode).toBe(401);
  });

  it('rejects expired login codes', async () => {
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    clock += LOGIN_CODE_TTL_MS + 1;
    const url = new URL(login.url);
    expect(status(await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } }))).toBe(401);
  });

  it('serves the dashboard app only to a signed-in browser, under a strict CSP', async () => {
    const signedOut = await app.inject({ method: 'GET', url: '/', headers: { host: HOST } });
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.headers['content-type']).toMatch(/text\/html/);
    const auth = await signIn();
    const page = await asBrowser(auth, 'GET', '/', { origin: null });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<div id="app"></div>');
    // Only the dashboard's own files: scripts, styles (no inline styles), bundled fonts, images and API.
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self' http://ipc.localhost ipc:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.body).not.toContain(TOKEN);
  });

  it('serves dashboard scripts only with a session, and the manifest and icons to anyone', async () => {
    const script = /\/assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(path.join(DASHBOARD_DIR, 'index.html'), 'utf8'))![1]!;
    expect(status(await app.inject({ method: 'GET', url: `/assets/${script}`, headers: { host: HOST } }))).toBe(401);
    const auth = await signIn();
    const asset = await asBrowser(auth, 'GET', `/assets/${script}`, { origin: null });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.body).not.toMatch(/new Function|\beval\(/);

    for (const url of ['/manifest.webmanifest', '/icons/icon-32.png', '/icons/icon-256.png', '/icons/icon-512.png', '/icons/icon.svg']) {
      expect(status(await app.inject({ method: 'GET', url, headers: { host: HOST } })), url).toBe(200);
    }
  });

  it('never serves files outside the dashboard directory', async () => {
    const auth = await signIn();
    for (const url of ['/assets/..%2F..%2Fcore.mjs', '/assets/..%5C..%5Ccore.mjs', '/icons/..%2Findex.html', '/assets/.env', '/icons/x.exe']) {
      expect(status(await asBrowser(auth, 'GET', url, { origin: null })), url).toBe(404);
    }
  });

  it('lets the dashboard read, but refuses cross-origin and cross-site requests', async () => {
    const auth = await signIn();
    expect(status(await asBrowser(auth, 'GET', '/api/v1/tasks', { origin: null }))).toBe(200);
    expect(status(await asBrowser(auth, 'GET', '/api/v1/tasks', { origin: 'https://evil.example' }))).toBe(403);
    expect(status(await asBrowser(auth, 'GET', '/api/v1/tasks', { origin: null, site: 'cross-site' }))).toBe(403);
  });

  it('requires a CSRF token and the dashboard origin for every state change', async () => {
    const auth = await signIn();
    const approve = { stage: 'PLAN', version: 1, decision: 'APPROVED', confirmTaskId: taskId };
    expect(status(await asBrowser({ cookie: auth.cookie }, 'POST', `/api/v1/tasks/${taskId}/approvals`, { payload: approve }))).toBe(403);
    expect(status(await asBrowser({ cookie: auth.cookie, csrf: 'f'.repeat(64) }, 'POST', `/api/v1/tasks/${taskId}/approvals`, { payload: approve }))).toBe(403);
    expect(status(await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/approvals`, { origin: null, payload: approve }))).toBe(403);
    expect(status(await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/approvals`, { origin: 'https://evil.example', payload: approve }))).toBe(403);
  });

  it('approves from the dashboard only with the task ID typed as confirmation, when the user chose typed confirmations', async () => {
    expect(status(await asCli('POST', '/api/v1/settings', { decisionConfirmation: 'typed' }))).toBe(200);
    try {
      const auth = await signIn();
      const without = await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/approvals`, { payload: { stage: 'PLAN', version: 1, decision: 'APPROVED' } });
      expect(without.statusCode).toBe(400);
      const approved = await asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/approvals`, { payload: { stage: 'PLAN', version: 1, decision: 'APPROVED', confirmTaskId: taskId } });
      expect(approved.statusCode).toBe(201);
      expect(store.planDecision(taskId)?.decision).toBe('APPROVED');
    } finally {
      await asCli('POST', '/api/v1/settings', { decisionConfirmation: 'click' });
    }
  });

  it('pauses and resumes from the dashboard, cancels only with the typed task ID, and refuses steps the workflow does not allow', async () => {
    const auth = await signIn();
    const control = (payload: Record<string, unknown>) => asBrowser(auth, 'POST', `/api/v1/tasks/${taskId}/transitions`, { payload });
    expect(status(await asBrowser({ cookie: auth.cookie }, 'POST', `/api/v1/tasks/${taskId}/transitions`, { payload: { event: 'task.paused' } }))).toBe(403);
    expect(JSON.parse((await control({ event: 'task.paused' })).body)).toMatchObject({ taskId, state: 'PAUSED' });
    expect(status(await control({ event: 'task.paused' }))).toBe(409);
    expect(JSON.parse((await control({ event: 'task.resumed' })).body)).toMatchObject({ state: 'IMPLEMENTATION' });
    // Only user decisions go through this endpoint; Claude's steps have their own.
    expect(status(await control({ event: 'plan.approved' }))).toBe(400);

    expect(status(await control({ event: 'task.cancelled' }))).toBe(400);
    expect(JSON.parse((await control({ event: 'task.cancelled', confirmTaskId: taskId })).body)).toMatchObject({ state: 'CANCELLED' });
    const history = JSON.parse((await asBrowser(auth, 'GET', `/api/v1/tasks/${taskId}/transitions`, { origin: null })).body) as Array<{ event: string }>;
    expect(history.map((step) => step.event)).toEqual(['plan.submitted', 'plan.approved', 'task.paused', 'task.resumed', 'task.cancelled']);
  });

  it('adds and removes projects and deletes data from the dashboard only with CSRF, the origin and the typed confirmation', async () => {
    // Outside JERRY's data directory (base), which can never be a project.
    const outside = tempDir('api-auth-projects');
    const project = createFixtureRepo(path.join(outside, 'project'));
    const forgotten = createFixtureRepo(path.join(outside, 'forgotten'));
    const auth = await signIn();
    const post = (url: string, payload: Record<string, unknown>, who: { cookie: string; csrf?: string } = auth, origin?: string | null) => asBrowser(who, 'POST', url, { payload, ...(origin === undefined ? {} : { origin }) });
    try {
      // Without CSRF or from another origin: refused before the handler.
      for (const [url, payload] of [
        ['/api/v1/projects', { path: project, confirmation: project }],
        ['/api/v1/projects/remove', { path: project, confirmation: project }],
        ['/api/v1/data/prune/preview', { eventsOlderThanDays: 3650 }],
        ['/api/v1/data/prune', { eventsOlderThanDays: 3650, confirmation: 'delete' }],
        ['/api/v1/data/forget/preview', { path: forgotten }],
        ['/api/v1/data/forget', { path: forgotten, confirmation: forgotten }],
      ] as const) {
        expect(status(await post(url, payload, { cookie: auth.cookie })), `${url} without CSRF`).toBe(403);
        expect(status(await post(url, payload, auth, 'https://evil.example')), `${url} cross-origin`).toBe(403);
      }
      expect(status(await post('/api/v1/projects', { path: project, confirmation: path.join(outside, 'other') }))).toBe(400);

      // Adding needs the repository root typed.
      expect(status(await post('/api/v1/projects', { path: project }))).toBe(400);
      const added = await post('/api/v1/projects', { path: project, confirmation: project });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ added: true, project: { addedBy: 'dashboard' } });
      expect((await asBrowser(auth, 'GET', '/api/v1/projects', { origin: null })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ addedBy: 'dashboard', openTasks: 0 })]));

      // Removing too; open tasks stay and are named in the warning.
      const open = (await store.createTask({ repoRoot: project, title: 'Still open', scope: ['src/**'] }, new Date())).taskId;
      expect(status(await post('/api/v1/projects/remove', { path: project }))).toBe(400);
      const removed = await post('/api/v1/projects/remove', { path: project, confirmation: project });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ removed: true, openTasks: [open] });
      expect(String(removed.json<{ warning: string }>().warning)).toContain(open);

      // Deleting old data needs the word "delete"; the preview needs nothing typed.
      const options = { eventsOlderThanDays: 3650 };
      expect(status(await post('/api/v1/data/prune/preview', options))).toBe(200);
      expect(status(await post('/api/v1/data/prune', options))).toBe(400);
      expect(status(await post('/api/v1/data/prune', { ...options, confirmation: 'Delete it' }))).toBe(400);
      const pruned = await post('/api/v1/data/prune', { ...options, confirmation: 'delete' });
      expect(pruned.statusCode).toBe(200);
      expect(pruned.json()).toHaveProperty('backupFile');

      // Forgetting needs the repository root typed, and is refused while tasks are open.
      expect((await post('/api/v1/data/forget/preview', { path: project })).json()).toMatchObject({ openTasks: [open] });
      expect(status(await post('/api/v1/data/forget', { path: project, confirmation: project }))).toBe(409);
      expect(status(await post('/api/v1/data/forget', { path: forgotten }))).toBe(400);
      expect(status(await post('/api/v1/data/forget', { path: forgotten, confirmation: forgotten }))).toBe(200);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps hook and lifecycle endpoints away from the browser', async () => {
    const auth = await signIn();
    for (const url of ['/api/v1/gate/check', '/api/v1/events', '/api/v1/sessions', '/api/v1/shutdown', '/api/v1/ui/login-codes', '/api/v1/tasks']) {
      expect(status(await asBrowser(auth, 'POST', url, { payload: {} })), url).toBe(403);
    }
  });

  it('signs the browser out', async () => {
    const auth = await signIn();
    const logout = await asBrowser(auth, 'POST', '/ui/logout', { payload: {} });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
    expect(status(await asBrowser(auth, 'GET', '/api/v1/tasks', { origin: null }))).toBe(401);
  });
});
