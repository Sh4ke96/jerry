import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TELEMETRY_METRICS_PATH } from '@jerry/platform';
import Fastify, { type FastifyInstance, type InjectOptions, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp, routeAccessTable, type RouteAccessEntry } from '../../apps/core/src/app.js';
import { ACCESS_CLASSES, BrowserSessions, type AccessClass } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, ROOT, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';

const PORT = 47993;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
const API = '/api/v1';
type Payload = NonNullable<InjectOptions['payload']>;

/**
 * The non-GET routes the agent token may call: what the hook bridge, the MCP server and the status
 * line send (Claude's own submissions). Every other state-changing route is the user's. A new route
 * here needs a reason: the agent token is readable by every agent.
 */
const AGENT_WRITES = [
  'POST /gate/check',
  'POST /gate/preview',
  'POST /events',
  'POST /sessions',
  'POST /usage/snapshots',
  'POST /usage/jerry-share',
  'POST /tasks',
  'POST /tasks/intake',
  'POST /tasks/:taskId/plan',
  'POST /tasks/:taskId/analyses',
  'POST /tasks/:taskId/checkpoints',
  'POST /tasks/:taskId/reports',
  'POST /tasks/:taskId/assignments',
  'POST /tasks/:taskId/artifact',
  'POST /tasks/:taskId/reviews',
  'POST /tasks/:taskId/reviews/finish',
  'POST /tasks/:taskId/fix-plan',
  'POST /tasks/:taskId/fixes',
].map((route) => route.replace(' /', ` ${API}/`));

/** User decisions named in the plan; each must refuse the agent token. */
const PINNED: Record<string, AccessClass> = {
  'POST /ui/login-codes': 'USER_ONLY',
  'POST /shutdown': 'USER_ONLY',
  'POST /evals/runs': 'USER_ONLY',
  'POST /tasks/:taskId/approvals': 'USER_DECISION',
  'POST /tasks/:taskId/transitions': 'USER_DECISION',
  'POST /tasks/:taskId/final-checks': 'USER_DECISION',
  'POST /tasks/:taskId/final-checks/waive': 'USER_DECISION',
  'POST /tasks/:taskId/review/skip': 'USER_DECISION',
  'POST /tasks/:taskId/artifact-request': 'USER_DECISION',
  'POST /findings/:findingId/status': 'USER_DECISION',
  'POST /settings': 'USER_DECISION',
  'POST /agents/models': 'USER_DECISION',
  'POST /projects': 'USER_DECISION',
  'POST /projects/remove': 'USER_DECISION',
  'POST /repositories/exclusions': 'USER_DECISION',
  'POST /usage/collection': 'USER_DECISION',
  'POST /data/prune': 'USER_DECISION',
  'POST /data/forget': 'USER_DECISION',
  'POST /evals/baseline': 'USER_DECISION',
  'POST /evals/labels': 'USER_DECISION',
  'POST /skills/install': 'USER_DECISION',
  'POST /skills/:name/enable': 'USER_DECISION',
  'POST /skills/:name/remove': 'USER_DECISION',
  'POST /evals/runner/start': 'SESSION_ONLY',
  'GET /tasks/:taskId/decision': 'AGENT',
  'GET /history': 'AGENT',
  'GET /tasks': 'READ',
  'GET /settings': 'READ',
};

const key = (entry: { method: string; url: string }): string => `${entry.method} ${entry.url}`;

/** A concrete URL for a route pattern (any value for its parameters). */
function concrete(url: string): string {
  const values: Record<string, string> = { taskId: 'JRY-0001', findingId: 'FND-1', id: '1', runId: 'EVR-1', name: 'example-skill' };
  return url.replace(/:(\w+)/g, (_match, name: string) => values[name] ?? 'x');
}

/** Paths the agent clients call, per source file: method and path with template parts as "X", query cut off. */
function agentCalls(): Array<{ method: string; path: string; file: string }> {
  const files = ['apps/mcp-server/src/tools.ts', 'apps/mcp-server/src/share.ts', 'apps/hook-bridge/src/main.ts'];
  const calls: Array<{ method: string; path: string; file: string }> = [];
  const normalise = (raw: string): string => raw.replace(/\$\{[^}]*\}/g, 'X').split('?')[0]!;
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of text.matchAll(/core\('(GET|POST)',\s*[`'](\/api\/v1\/[^`']+)[`']/g)) calls.push({ method: match[1]!, path: normalise(match[2]!), file });
    for (const match of text.matchAll(/method: '(GET|POST)',\s*path: [`'](\/api\/v1\/[^`']+)[`']/g)) calls.push({ method: match[1]!, path: normalise(match[2]!), file });
  }
  // The status line posts its snapshots through a constant.
  const statusline = fs.readFileSync(path.join(ROOT, 'apps/statusline/src/main.ts'), 'utf8');
  const snapshots = /USAGE_SNAPSHOTS_PATH = '([^']+)'/.exec(statusline)?.[1];
  if (snapshots !== undefined) calls.push({ method: 'POST', path: snapshots, file: 'apps/statusline/src/main.ts' });
  return calls;
}

/** The route a request goes to: an exact static route first, else the one whose parameters match. */
function routeFor(table: readonly RouteAccessEntry[], method: string, requestPath: string): RouteAccessEntry | undefined {
  const candidates = table.filter((entry) => entry.method === method);
  return candidates.find((entry) => entry.url === requestPath) ?? candidates.find((entry) => new RegExp(`^${entry.url.replace(/:\w+/g, '[^/]+')}$`).test(requestPath));
}

/**
 * The split credential: the agent token in run/core.json (readable by every agent) reaches only the
 * agent and read routes; the user's token (run/core-user.json) and a dashboard session make the user's
 * decisions. Runs the real Fastify app through inject(), without a network.
 */
describe('Core access classes: the agent token cannot make user decisions', () => {
  const base = tempDir('core-auth');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const userToken = randomBytes(32).toString('hex');
  const agentToken = randomBytes(32).toString('hex');
  const sessions = new BrowserSessions();
  const shutdowns: unknown[] = [];
  let store: StateStore;
  let app: FastifyInstance;
  let table: readonly RouteAccessEntry[];
  let auth: { cookie: string; csrf: string };

  beforeAll(async () => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({
      token: userToken,
      agentToken,
      store,
      jerryHome: path.join(base, 'home'),
      claudeConfigDir: path.join(base, 'claude'),
      protectedRoots: [],
      startedAt: new Date(),
      port: () => PORT,
      sessions,
      onShutdownRequested: (request) => shutdowns.push(request),
    });
    await app.ready();
    table = routeAccessTable(app);
    await store.addProject(repo, new Date(), 'cli');
    auth = await signIn();
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const withToken = (token: string, method: string, url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method: method as 'GET' | 'POST', url, headers: { host: HOST, authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
  const asBrowser = (method: string, url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method: method as 'GET' | 'POST', url, headers: { host: HOST, cookie: auth.cookie, origin: ORIGIN, 'x-jerry-csrf': auth.csrf }, ...(payload === undefined ? {} : { payload }) });

  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const login = await withToken(userToken, 'POST', `${API}/ui/login-codes`, {});
    expect(login.statusCode, login.body).toBe(200);
    const url = new URL((login.json() as { url: string }).url);
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const info = await app.inject({ method: 'GET', url: `${API}/ui/session`, headers: { host: HOST, cookie } });
    return { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  }

  /** Routes of these classes, one entry per method and URL (HEAD copies of GET routes left out). */
  const routesOf = (...classes: AccessClass[]): RouteAccessEntry[] => table.filter((entry) => entry.method !== 'HEAD' && classes.includes(entry.access));
  const refusedFor = (response: LightMyRequestResponse): boolean => response.statusCode === 401 || response.statusCode === 403;
  const AGENT_REFUSAL = /needs the user's token \(run\/core-user\.json, used by the jerry CLI and the desktop app\) or the dashboard; the agent token in run\/core\.json cannot make user decisions/;

  it('gives every registered route an explicit access class', () => {
    expect(table.length).toBeGreaterThan(80);
    for (const entry of table) expect(ACCESS_CLASSES, key(entry)).toContain(entry.access);
    // Every API route is behind a credential; the public ones are the health check, the login page,
    // the installed app's manifest and icons (no data) and telemetry (its own key).
    const open = routesOf('PUBLIC').map(key).sort();
    expect(open).toEqual(['GET /health', 'GET /ui/login', 'GET /manifest.webmanifest', 'GET /icons/:name', `POST ${TELEMETRY_METRICS_PATH}`].sort());
    for (const [route, access] of Object.entries(PINNED)) {
      const [method, url] = route.split(' ') as [string, string];
      expect(table.find((entry) => entry.method === method && entry.url === `${API}${url}`)?.access, route).toBe(access);
    }
  });

  it('refuses to register a route without an access class', async () => {
    const other = buildCoreApp({ token: userToken, agentToken, store, jerryHome: path.join(base, 'home'), claudeConfigDir: path.join(base, 'claude'), protectedRoots: [], startedAt: new Date(), port: () => PORT, onShutdownRequested: () => undefined });
    try {
      expect(() => other.get(`${API}/unclassified`, async () => ({}))).toThrow(/has no access class/);
      expect(() => other.post(`${API}/unclassified`, { config: { access: 'NOBODY' as AccessClass } }, async () => ({}))).toThrow(/has no access class/);
    } finally {
      await other.close();
    }
    // Fastify itself registers nothing without it: a plain app has no such hook (sanity check of the test).
    const plain = Fastify();
    expect(() => plain.get('/plain', async () => ({}))).not.toThrow();
    await plain.close();
  });

  it('lets the agent token change state only on the agent routes', () => {
    const agentWrites = table.filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD' && (entry.access === 'AGENT' || entry.access === 'READ')).map(key).sort();
    expect(agentWrites).toEqual([...AGENT_WRITES].sort());
    // Reads are GETs only.
    expect(routesOf('READ').filter((entry) => entry.method !== 'GET').map(key)).toEqual([]);
  });

  it('keeps every route the hook bridge, the MCP server and the status line call open to the agent token', () => {
    const calls = agentCalls();
    expect(calls.length).toBeGreaterThan(30);
    for (const call of calls) {
      const route = routeFor(table, call.method, call.path);
      expect(route, `${call.method} ${call.path} (${call.file})`).toBeDefined();
      expect(['AGENT', 'READ'], `${call.method} ${call.path} (${call.file})`).toContain(route!.access);
    }
  });

  it('refuses the agent token on every user decision, login codes and shutdown, with the reason', async () => {
    const routes = routesOf('USER_DECISION', 'USER_ONLY');
    expect(routes.length).toBeGreaterThan(30);
    for (const route of routes) {
      const response = await withToken(agentToken, route.method, concrete(route.url), {});
      expect(response.statusCode, `${key(route)}: ${response.body}`).toBe(403);
      expect((response.json() as { error: string }).error, key(route)).toMatch(AGENT_REFUSAL);
    }
    expect(shutdowns).toEqual([]);
  });

  it('refuses the agent token on the dashboard routes', async () => {
    for (const route of routesOf('SESSION_ONLY')) {
      const response = await withToken(agentToken, route.method, concrete(route.url), route.method === 'GET' ? undefined : {});
      expect(response.statusCode, key(route)).toBe(403);
    }
  });

  it('accepts the agent token on the agent and read routes', async () => {
    for (const route of routesOf('AGENT', 'READ')) {
      // The decision long poll answers 400 at once without its query; nothing here waits.
      const response = await withToken(agentToken, route.method, concrete(route.url), route.method === 'GET' ? undefined : {});
      expect(refusedFor(response), `${key(route)}: ${response.statusCode} ${response.body}`).toBe(false);
    }
  });

  it("accepts the user's token on every bearer route", async () => {
    for (const route of routesOf('AGENT', 'READ', 'USER_DECISION', 'USER_ONLY')) {
      const response = await withToken(userToken, route.method, concrete(route.url), route.method === 'GET' ? undefined : {});
      expect(refusedFor(response), `${key(route)}: ${response.statusCode} ${response.body}`).toBe(false);
    }
    // POST /shutdown went through for the user's token (Core stops on the next turn of the event loop).
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdowns).toHaveLength(1);
  });

  it('accepts a dashboard session with its CSRF token on user decisions and reads, not on bearer-only routes', async () => {
    for (const route of routesOf('USER_DECISION', 'READ')) {
      const response = await asBrowser(route.method, concrete(route.url), route.method === 'GET' ? undefined : {});
      expect(refusedFor(response), `${key(route)}: ${response.statusCode} ${response.body}`).toBe(false);
    }
    for (const route of routesOf('USER_ONLY', 'AGENT')) {
      const response = await asBrowser(route.method, concrete(route.url), route.method === 'GET' ? undefined : {});
      expect(response.statusCode, key(route)).toBe(403);
    }
    // Without its CSRF token a session changes nothing.
    const noCsrf = await app.inject({ method: 'POST', url: `${API}/settings`, headers: { host: HOST, cookie: auth.cookie, origin: ORIGIN }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('keeps a plan decision with the user: the agent submits, only the user approves', async () => {
    const plan = samplePlan(repo, ['src/greeting/**']);
    const created = await withToken(agentToken, 'POST', `${API}/tasks`, { repoPath: repo, title: 'Agent plan', scope: plan.scope.include, document: plan });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = (created.json() as { taskId: string }).taskId;
    const approval = { stage: 'PLAN', version: 1, decision: 'APPROVED' };
    const byAgent = await withToken(agentToken, 'POST', `${API}/tasks/${taskId}/approvals`, approval);
    expect(byAgent.statusCode).toBe(403);
    expect((await withToken(agentToken, 'GET', `${API}/tasks/${taskId}`)).json()).toMatchObject({ state: 'WAIT_PLAN_APPROVAL' });
    const skip = await withToken(agentToken, 'POST', `${API}/tasks/${taskId}/review/skip`, { reason: 'agent wants to skip' });
    expect(skip.statusCode).toBe(403);
    const byUser = await withToken(userToken, 'POST', `${API}/tasks/${taskId}/approvals`, approval);
    expect(byUser.statusCode, byUser.body).toBe(201);
    expect((await withToken(agentToken, 'GET', `${API}/tasks/${taskId}`)).json()).toMatchObject({ state: 'IMPLEMENTATION' });
  });

  it('still answers 404 for unknown routes and 401 for unknown tokens', async () => {
    expect((await withToken(agentToken, 'GET', `${API}/no-such-route`)).statusCode).toBe(404);
    expect((await withToken(randomBytes(32).toString('hex'), 'GET', `${API}/tasks`)).statusCode).toBe(401);
    // A bearer token from a browser page is refused, the user's as much as the agent's.
    for (const token of [userToken, agentToken]) {
      const response = await app.inject({ method: 'GET', url: `${API}/tasks`, headers: { host: HOST, authorization: `Bearer ${token}`, origin: ORIGIN } });
      expect(response.statusCode).toBe(403);
    }
  });
});
