import fs from 'node:fs';
import path from 'node:path';
import type { ReportDraft } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';

const PORT = 47994;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['report', 'draft', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

/** The report draft: what JERRY recorded, prefilled for Claude to complete. */
describe('implementation report draft (Core API)', () => {
  const base = tempDir('report-draft');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  let store: StateStore;
  let app: FastifyInstance;
  let taskId = '';

  beforeAll(async () => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: path.join(base, 'home'), protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions: new BrowserSessions(), onShutdownRequested: () => undefined });
    await store.addProject(repo, new Date(), 'cli');
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const asCli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });

  it('refuses a task that is not being implemented', async () => {
    const plan = samplePlan(repo);
    const created = await asCli('POST', '/api/v1/tasks', { repoPath: repo, title: 'Greeting', scope: plan.scope.include, document: plan });
    taskId = (created.json() as { taskId: string }).taskId;
    expect((await asCli('GET', `/api/v1/tasks/${taskId}/report-draft`)).statusCode).toBe(409);
    expect((await asCli('GET', '/api/v1/tasks/JRY-9999/report-draft')).statusCode).toBe(404);
  });

  it('prefills changed files, plan descriptions, recorded test runs, commit subjects and deviations', async () => {
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).statusCode).toBe(201);
    fs.mkdirSync(path.join(repo, 'src', 'greeting'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'greeting', 'greet.ts'), 'export const greet = (name: string) => `Hello, ${name.trim()}!`;\n');
    fs.mkdirSync(path.join(repo, 'src', 'extra'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'extra', 'note.ts'), 'export {};\n');
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const run = (command: string, result: 'PASS' | 'FAIL', minutes: number, summary: string | null) => store.recordTestRun({ taskId, repoRoot: repo, sessionId: 's', agentId: null, eventId: `evt_${command}_${minutes}`, command, result, exitCode: result === 'PASS' ? 0 : 1, summary, at: at(minutes) });
    await run('npm test', 'FAIL', 10, '1 failed');
    await run('npm test', 'PASS', 2, 'Tests 3 passed (3)');
    await run('npm run lint', 'PASS', 5, null);
    // An out-of-scope edit: a deviation recorded for the task.
    const gate = await asCli('POST', '/api/v1/gate/check', { sessionId: 's', cwd: repo, toolName: 'Write', toolInput: { file_path: path.join(repo, 'README.md') }, toolUseId: null, agentId: null });
    expect(gate.json()).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.out-of-scope' });

    const response = await asCli('GET', `/api/v1/tasks/${taskId}/report-draft`);
    expect(response.statusCode, response.body).toBe(200);
    const draft = response.json() as ReportDraft;
    expect(draft).toMatchObject({ taskId, planVersion: 1 });
    const changes = Object.fromEntries(draft.draft.changes.map((change) => [change.path, change]));
    expect(changes['src/greeting/greet.ts']).toEqual({ repository: '', path: 'src/greeting/greet.ts', kind: 'added', description: 'greet(name) returns "Hello, <name>!" and trims input' });
    // Not named by the plan: Claude writes the description.
    expect(changes['src/extra/note.ts']).toMatchObject({ kind: 'modified', description: '' });
    expect(draft.sources.changes.find((entry) => entry.path === 'src/extra/note.ts')!.source).toContain('outside the plan scope');
    // The latest run of each command, newest first.
    expect(draft.draft.checks.map((check) => [check.command, check.result])).toEqual([
      ['npm test', 'PASS'],
      ['npm run lint', 'PASS'],
    ]);
    expect(draft.draft.checks[0]!.details).toContain('Tests 3 passed (3)');
    expect(draft.draft.commitSubjects).toEqual(['feat(greeting): add greet helper']);
    expect(draft.draft.qaLanguage).toBe('pl');
    expect(draft.sources.deviations).toEqual([expect.objectContaining({ rule: 'monitor.out-of-scope', tool: 'Write' })]);
    expect(draft.fill.join(' ')).toContain('run the project checks again');
    expect(draft.fill.join(' ')).toContain('a description for each change without one (');
  });
});
