import fs from 'node:fs';
import path from 'node:path';
import type { ProjectSummary, RepositoryState, SessionRegistrationResponse, Workspace, WorkspaceChangeResult, WorkspaceScan } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { commonParent } from '../../apps/core/src/workspace-service.js';
import { createFixtureRepo, tempDir } from '../helpers/harness.js';

const PORT = 47994;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: no credential-shaped literal.
const TOKEN = ['workspace', 'route', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

/**
 * Workspaces through Core's API (inject, no network): scanning a folder for repositories, creating
 * a workspace (its repositories become projects), adding, removing, renaming, deleting (projects
 * stay), the user-only checks, and what a session in a workspace repository or in the common parent
 * folder learns.
 */
describe('workspaces (Core API)', () => {
  const base = tempDir('workspaces');
  const work = path.join(base, 'work');
  const home = path.join(base, 'home');
  const projectsFile = path.join(base, 'projects.json');
  let api: string;
  let shop: string;
  let admin: string;
  let store: StateStore;
  let app: FastifyInstance;
  let auth: { cookie: string; csrf: string };

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true });
    api = createFixtureRepo(path.join(work, 'api'));
    shop = createFixtureRepo(path.join(work, 'shop'));
    admin = createFixtureRepo(path.join(work, 'apps', 'admin'));
    // Never scanned into.
    createFixtureRepo(path.join(work, 'node_modules', 'lib'));
    fs.mkdirSync(path.join(work, 'notes'), { recursive: true });
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json'), projectsFile });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: home, protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions: new BrowserSessions(), onShutdownRequested: () => undefined });
    await app.ready();
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const url = new URL(login.url);
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const info = await app.inject({ method: 'GET', url: '/api/v1/ui/session', headers: { host: HOST, cookie } });
    auth = { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const asCli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });
  const asBrowser = (method: 'GET' | 'POST', url: string, payload?: Payload, csrf: string | null = auth.csrf): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, cookie: auth.cookie, origin: ORIGIN, ...(csrf === null ? {} : { 'x-jerry-csrf': csrf }) }, ...(payload === undefined ? {} : { payload }) });
  const projectRoots = async (): Promise<string[]> => ((await asCli('GET', '/api/v1/projects')).json() as ProjectSummary[]).map((project) => project.repoRoot);
  const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  it('finds the Git repositories under a folder, two levels deep, skipping node_modules', async () => {
    const scan = (await asBrowser('POST', '/api/v1/workspaces/scan', { folder: work })).json() as WorkspaceScan;
    expect(scan.repos.map((repo) => path.relative(work, repo.repoRoot))).toEqual(['api', path.join('apps', 'admin'), 'shop']);
    expect(scan.repos.every((repo) => !repo.project && repo.workspace === null)).toBe(true);
    expect((await asBrowser('POST', '/api/v1/workspaces/scan', { folder: path.join(base, 'nope') })).statusCode).toBe(400);
  });

  it('creates a workspace only as the user: its repositories become projects', async () => {
    // A browser needs CSRF; a non-repository and a folder inside a repository are refused.
    expect((await asBrowser('POST', '/api/v1/workspaces', { name: 'Shop', paths: [api] }, null)).statusCode).toBe(403);
    expect((await asCli('POST', '/api/v1/workspaces', { name: 'Shop', paths: [path.join(work, 'notes')] })).json()).toMatchObject({ error: expect.stringMatching(/not a Git repository/) });
    expect((await asCli('POST', '/api/v1/workspaces', { name: 'Shop', paths: [path.join(api, 'src')] })).json()).toMatchObject({ error: expect.stringMatching(/give the repository root/) });
    expect((await asCli('POST', '/api/v1/workspaces', { name: '../x', paths: [api] })).statusCode).toBe(400);

    const created = await asBrowser('POST', '/api/v1/workspaces', { name: 'Shop', paths: [api, shop, api] });
    expect(created.statusCode, created.body).toBe(201);
    const result = created.json() as WorkspaceChangeResult;
    expect(result.workspace).toMatchObject({ name: 'Shop', repos: [expect.objectContaining({ project: true, present: true, openTasks: 0 }), expect.objectContaining({ project: true })] });
    expect(result.addedProjects).toHaveLength(2);
    expect((await projectRoots()).some((root) => same(root, api))).toBe(true);
    // Names are unique whatever their case; a repository belongs to one workspace.
    expect((await asCli('POST', '/api/v1/workspaces', { name: 'shop', paths: [admin] })).statusCode).toBe(409);
    expect((await asCli('POST', '/api/v1/workspaces', { name: 'Other', paths: [api] })).json()).toMatchObject({ error: expect.stringMatching(/already in the workspace Shop/) });
  });

  it('adds, renames and removes as the user decides; removing keeps the project; typed name when Settings ask for it', async () => {
    const [shopSpace] = (await asCli('GET', '/api/v1/workspaces')).json() as Workspace[];
    const id = shopSpace!.id;
    expect((await asCli('POST', '/api/v1/settings', { decisionConfirmation: 'typed' })).statusCode).toBe(200);
    expect((await asBrowser('POST', `/api/v1/workspaces/${id}/repos`, { path: admin })).statusCode).toBe(400);
    const added = await asBrowser('POST', `/api/v1/workspaces/${id}/repos`, { path: admin, confirmation: 'SHOP' });
    expect(added.statusCode, added.body).toBe(200);
    expect((added.json() as WorkspaceChangeResult).workspace!.repos).toHaveLength(3);
    expect((await asCli('POST', '/api/v1/settings', { decisionConfirmation: 'click' })).statusCode).toBe(200);

    expect(((await asBrowser('POST', `/api/v1/workspaces/${id}/rename`, { name: 'Sklep' })).json() as WorkspaceChangeResult).workspace!.name).toBe('Sklep');
    const removed = (await asBrowser('POST', `/api/v1/workspaces/${id}/repos/remove`, { path: admin })).json() as WorkspaceChangeResult;
    expect(removed.workspace!.repos).toHaveLength(2);
    expect((await projectRoots()).some((root) => same(root, admin))).toBe(true);
    expect((await asCli('POST', `/api/v1/workspaces/${id}/repos/remove`, { path: admin })).statusCode).toBe(404);
  });

  it('gives a session in a workspace repository or in the common parent folder the workspace', async () => {
    const register = async (cwd: string): Promise<SessionRegistrationResponse> => (await asCli('POST', '/api/v1/sessions', { sessionId: `s-${path.basename(cwd)}`, cwd, source: 'startup' })).json() as SessionRegistrationResponse;
    const inRepo = await register(api);
    expect(inRepo).toMatchObject({ monitored: true, workspace: { name: 'Sklep' } });
    expect(inRepo.workspace!.repos.map((repo) => path.basename(repo.repoRoot)).sort()).toEqual(['api', 'shop']);
    // The common parent of api and shop is the work folder: a workspace session, not "not a project".
    expect(commonParent([api, shop])).toBe(path.resolve(work));
    const inParent = await register(work);
    expect(inParent).toMatchObject({ monitored: true, excluded: false, repoRoot: null, workspace: { name: 'Sklep' } });
    // The bridge asks Core about the parent folder: it is in projects.json.
    const roots = (JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as { roots: string[] }).roots;
    expect(roots.some((root) => same(root, work))).toBe(true);
    // A folder above it holds them too but is not their parent: not a project.
    const above = await register(base);
    expect(above.monitored).toBe(false);
    expect(above.workspace ?? null).toBeNull();
    const state = (await asCli('GET', `/api/v1/repositories/state?path=${encodeURIComponent(shop)}`)).json() as RepositoryState;
    expect(state.workspace).toMatchObject({ name: 'Sklep' });
  });

  it('deletes a workspace only: its repositories stay projects', async () => {
    const [workspace] = (await asCli('GET', '/api/v1/workspaces')).json() as Workspace[];
    const deleted = await asBrowser('POST', `/api/v1/workspaces/${workspace!.id}/delete`, {});
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toEqual({ workspace: null, addedProjects: [] });
    expect((await asCli('GET', '/api/v1/workspaces')).json()).toEqual([]);
    expect((await projectRoots()).filter((root) => [api, shop, admin].some((repo) => same(root, repo)))).toHaveLength(3);
    const roots = (JSON.parse(fs.readFileSync(projectsFile, 'utf8')) as { roots: string[] }).roots;
    expect(roots.some((root) => same(root, work))).toBe(false);
  });
});
