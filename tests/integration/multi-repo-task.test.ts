import fs from 'node:fs';
import path from 'node:path';
import type { CompletionCheck, GateDecision, ImplementationReportRecord, RepositoryState, Task, TaskDetail, TaskSummary } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffPlans } from '@jerry/workflow';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, tempDir } from '../helpers/harness.js';
import { sampleMultiRepoPlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

const PORT = 47995;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: no credential-shaped literal.
const TOKEN = ['multi', 'repo', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

/**
 * One task across several repositories of a workspace, through Core's API: one plan with a scope per
 * repository, one approval, the gate per repository (the same path in two repositories is two files),
 * a command in the workspace's parent folder, the report's evidence per repository, the final checks,
 * and the refusals (repositories outside the workspace, not projects, not roots, unsafe globs).
 */
describe('a task across several repositories of a workspace', () => {
  const base = tempDir('multi-repo');
  const work = path.join(base, 'work');
  const home = path.join(base, 'home');
  let api: string;
  let shop: string;
  let admin: string;
  let loose: string;
  let store: StateStore;
  let app: FastifyInstance;
  let taskId: string;

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true });
    api = createFixtureRepo(path.join(work, 'api'));
    shop = createFixtureRepo(path.join(work, 'shop'));
    admin = createFixtureRepo(path.join(base, 'other', 'admin'));
    loose = createFixtureRepo(path.join(work, 'loose'));
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json'), projectsFile: path.join(base, 'projects.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: home, protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions: new BrowserSessions(), onShutdownRequested: () => undefined });
    await app.ready();
    expect((await asCli('POST', '/api/v1/workspaces', { name: 'Shop', paths: [api, shop] })).statusCode).toBe(201);
    expect((await asCli('POST', '/api/v1/workspaces', { name: 'Back office', paths: [admin] })).statusCode).toBe(201);
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const asCli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });
  const gate = async (cwd: string, toolInput: Record<string, unknown>, toolName = 'Write'): Promise<GateDecision> =>
    (await asCli('POST', '/api/v1/gate/check', { sessionId: 'multi-1', cwd, toolName, toolInput, toolUseId: null, agentId: null })).json() as GateDecision;
  const same = (a: string | null, b: string): boolean => a !== null && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const plan = (others: Array<{ repository: string; include?: string[] }>) => {
    const document = sampleMultiRepoPlan([api, ...others.map((other) => other.repository)], ['src/**']);
    return { ...document, repositoryScopes: others.map((other) => ({ repository: other.repository, include: other.include ?? ['src/**', 'web/**'], exclude: [] })) };
  };
  const create = (document: ReturnType<typeof plan>) => asCli('POST', '/api/v1/tasks', { repoPath: api, title: 'Greeting across the workspace', scope: document.scope.include, document, submittedBy: 'claude' });
  const error = (response: LightMyRequestResponse): string => (response.json() as { error: string }).error;

  it('refuses repositories outside the workspace, ones that are no project or no root, and unsafe globs', async () => {
    expect(error(await create(plan([{ repository: admin }])))).toMatch(/not in the workspace Shop/);
    expect(error(await create(plan([{ repository: loose }])))).toMatch(/not a JERRY project/);
    expect(error(await create(plan([{ repository: path.join(shop, 'src') }])))).toMatch(/not the root of a Git repository/);
    expect(error(await create(plan([{ repository: shop, include: ['../api/**'] }])))).toMatch(/leaves its repository/);
    expect(error(await create(plan([{ repository: shop }, { repository: shop }])))).toMatch(/named twice/);
    expect(error(await create(plan([{ repository: api }])))).toMatch(/named twice/);
    const stray = { ...plan([{ repository: shop }]), changes: [{ kind: 'add' as const, target: 'x.ts', description: 'elsewhere', repository: admin }] };
    expect(error(await create(stray))).toMatch(/outside the plan/);
    expect(((await asCli('GET', '/api/v1/tasks')).json() as TaskSummary[]).length).toBe(0);
  });

  it('creates one task whose plan covers both repositories, each with its own scope', async () => {
    const response = await create(plan([{ repository: shop, include: ['src/**', 'web/**'] }]));
    expect(response.statusCode).toBe(201);
    const task = response.json() as Task;
    taskId = task.taskId;
    expect(task.repoRoot).toBe(api);
    expect(task.plan.scope).toEqual(['src/**']);
    expect(task.plan.repositories?.map((repository) => [repository.repoRoot, repository.scope])).toEqual([[shop, ['src/**', 'web/**']]]);
    // The plan diff names the other repository's globs.
    const v1 = (await asCli('GET', `/api/v1/tasks/${taskId}/plans`)).json() as Array<Pick<Task['plan'], 'version' | 'scope' | 'document'>>;
    expect(v1).toHaveLength(1);
    expect(diffPlans({ version: 0, scope: [], document: undefined }, v1[0]!).sections.find((section) => section.section === 'Repository scopes')?.added).toEqual([`${shop}: src/**`, `${shop}: web/**`]);
    // Before approval nothing covers edits, in either repository.
    expect((await gate(shop, { file_path: path.join(shop, 'web', 'a.ts') })).ruleId).toBe('monitor.no-approved-plan');
  });

  it('one approval covers both repositories: their baselines are taken, and the gate checks each against its own scope', async () => {
    const approved = await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED', confirmTaskId: taskId });
    expect(approved.statusCode).toBe(201);
    const detail = (await asCli('GET', `/api/v1/tasks/${taskId}`)).json() as TaskDetail;
    expect(detail.baseline?.userFiles).toContain('src/app.ts');
    expect(detail.baselines?.map((baseline) => [baseline.repoRoot, baseline.userFiles.includes('src/app.ts')])).toEqual([[shop, true]]);

    expect(await gate(shop, { file_path: path.join(shop, 'web', 'a.ts') })).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.in-approved-scope', taskId });
    expect(await gate(shop, { file_path: path.join(shop, 'docs', 'a.md') })).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.out-of-scope', taskId });
    // web/** is the shop's scope, not the api's.
    expect(await gate(api, { file_path: path.join(api, 'web', 'a.ts') })).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.out-of-scope' });
    // src/app.ts had the user's changes in both repositories: one warning in each, then none.
    expect((await gate(api, { file_path: path.join(api, 'src', 'app.ts') })).ruleId).toBe('monitor.user-uncommitted-file');
    expect((await gate(api, { file_path: path.join(api, 'src', 'app.ts') })).ruleId).toBe('monitor.in-approved-scope');
    const inShop = await gate(shop, { file_path: path.join(shop, 'src', 'app.ts') });
    expect(inShop.ruleId).toBe('monitor.user-uncommitted-file');
    expect(same(inShop.repoRoot, shop)).toBe(true);

    // The shop's state shows the task too.
    const state = (await asCli('GET', `/api/v1/repositories/state?path=${encodeURIComponent(shop)}`)).json() as RepositoryState;
    expect(state.tasks.map((task) => task.taskId)).toEqual([taskId]);
  });

  it("records a modifying command in the workspace's parent folder against its open task", async () => {
    const decision = await gate(work, { command: 'npm install' }, 'Bash');
    expect(decision).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.workspace-folder-command', taskId });
    expect((await gate(work, { command: 'ls' }, 'Bash')).verdict).toBe('PASS');
  });

  it('keeps a repository an open task covers from being forgotten', async () => {
    const response = await asCli('POST', '/api/v1/data/forget', { path: shop });
    expect(response.statusCode).toBe(409);
    expect(error(response)).toContain(taskId);
  });

  it("reports per repository: unknown repositories are refused, JERRY's evidence covers both", async () => {
    fs.mkdirSync(path.join(api, 'src', 'greeting'), { recursive: true });
    fs.writeFileSync(path.join(api, 'src', 'greeting', 'greet.ts'), 'export const greet = (name: string) => `Hello, ${name}!`;\n');
    fs.mkdirSync(path.join(shop, 'web'), { recursive: true });
    fs.writeFileSync(path.join(shop, 'web', 'greet.ts'), 'export const label = "Hello";\n');
    expect((await gate(api, { file_path: path.join(api, 'src', 'greeting', 'greet.ts') })).verdict).toBe('PASS');
    expect((await gate(shop, { file_path: path.join(shop, 'web', 'greet.ts') })).verdict).toBe('PASS');

    const report = sampleReport(['src/greeting/greet.ts']);
    const wrong = { ...report, changes: [...report.changes, { repository: admin, path: 'x.ts', kind: 'added' as const, description: 'not in the plan' }] };
    const refused = await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: wrong, submittedBy: 'claude' });
    expect(refused.statusCode).toBe(400);
    expect(error(refused)).toMatch(/not part of/);

    const full = { ...report, changes: [...report.changes, { repository: shop, path: 'web/greet.ts', kind: 'added' as const, description: 'shop label' }] };
    const submitted = await asCli('POST', `/api/v1/tasks/${taskId}/reports`, { report: full, submittedBy: 'claude' });
    expect(submitted.statusCode).toBe(201);
    const { evidence } = submitted.json() as ImplementationReportRecord;
    expect(evidence.repositories?.map((repository) => [path.basename(repository.repoRoot), repository.observedEdits.includes(repository.repoRoot === api ? 'src/greeting/greet.ts' : 'web/greet.ts')])).toEqual([
      ['api', true],
      ['shop', true],
    ]);
    // What the gate saw edited but the report leaves out, per repository (src/app.ts in each is its own file).
    expect(evidence.repositories?.map((repository) => repository.unreportedEdits)).toEqual([
      ['src/app.ts', 'web/a.ts'],
      ['docs/a.md', 'src/app.ts', 'web/a.ts'],
    ]);
    expect(evidence.unreportedEdits.filter((file) => file.endsWith('src/app.ts'))).toHaveLength(2);
    expect(evidence.observedEdits.some((file) => file.endsWith('shop/web/greet.ts'))).toBe(true);
  });

  it('accepting runs the final checks over both repositories', async () => {
    const accepted = await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', review: false, confirmTaskId: taskId });
    expect(accepted.statusCode).toBe(201);
    const [summary] = ((await asCli('GET', '/api/v1/tasks')).json() as TaskSummary[]).filter((task) => task.taskId === taskId);
    const check = summary!.finalCheck as CompletionCheck;
    expect(check.conditions.find((condition) => condition.id === 'repositories.readable')).toMatchObject({ blocking: true, passed: true });
    expect(check.conditions.filter((condition) => condition.blocking && !condition.passed)).toEqual([]);
    expect(summary!.state).toBe('DONE');
  });
});
