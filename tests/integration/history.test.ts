import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisReport, HistoryResponse } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { createFixtureRepo, tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

const PORT = 47995;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['history', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

const FEEDBACK = 'Reuse the existing formatter in src/app.ts instead of a new helper';

/**
 * Project history: what JERRY recorded about earlier tasks, found by files or words, with whether
 * each file still has the content it had then.
 */
describe('project history for Claude (Core API)', () => {
  const base = tempDir('history');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const other = createFixtureRepo(path.join(base, 'other'));
  const greet = path.join(repo, 'src', 'greeting', 'greet.ts');
  let store: StateStore;
  let app: FastifyInstance;
  let doneTask = '';

  beforeAll(async () => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: path.join(base, 'home'), protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions: new BrowserSessions(), onShutdownRequested: () => undefined });
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
  const history = async (params: Record<string, string | string[]>, root = repo): Promise<HistoryResponse> => {
    const search = new URLSearchParams({ repoPath: root });
    for (const [key, value] of Object.entries(params)) for (const entry of Array.isArray(value) ? value : [value]) search.append(key, entry);
    const response = await asCli('GET', `/api/v1/history?${search.toString()}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as HistoryResponse;
  };

  it('remembers a finished task: what it changed in each file, its approach and the user’s feedback', async () => {
    const plan = samplePlan(repo);
    const created = await asCli('POST', '/api/v1/tasks', { repoPath: repo, title: 'Greeting', scope: plan.scope.include, document: plan });
    expect(created.statusCode, created.body).toBe(201);
    doneTask = (created.json() as { taskId: string }).taskId;
    // The user rejected the first version with a reason, then approved the revision.
    expect((await asCli('POST', `/api/v1/tasks/${doneTask}/approvals`, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: FEEDBACK })).statusCode).toBe(201);
    expect((await asCli('POST', `/api/v1/tasks/${doneTask}/plan`, { scope: plan.scope.include, document: plan })).statusCode).toBe(200);
    expect((await asCli('POST', `/api/v1/tasks/${doneTask}/approvals`, { stage: 'PLAN', version: 2, decision: 'APPROVED' })).statusCode).toBe(201);
    fs.mkdirSync(path.dirname(greet), { recursive: true });
    fs.writeFileSync(greet, 'export const greet = (name: string) => `Hello, ${name.trim()}!`;\n');
    expect((await asCli('POST', `/api/v1/tasks/${doneTask}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' })).statusCode).toBe(201);
    const accepted = await asCli('POST', `/api/v1/tasks/${doneTask}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED' });
    expect(accepted.statusCode, accepted.body).toBe(201);

    const answer = await history({ paths: 'src/greeting/greet.ts' });
    expect(answer.tasks).toHaveLength(1);
    const [task] = answer.tasks;
    expect(task).toMatchObject({
      taskId: doneTask,
      title: 'Greeting',
      state: 'DONE',
      summary: 'Added greet(name) and its unit test.',
      files: [{ path: 'src/greeting/greet.ts', kind: 'added', description: 'greet helper', fresh: 'unchanged' }],
      userFeedback: [{ stage: 'PLAN', decision: 'REJECTED', comment: FEEDBACK }],
      commitSubjects: ['feat(greeting): add greet helper'],
    });
    expect(task!.finishedAt).not.toBeNull();
    expect(task!.patterns[0]).toContain('New leaf module');
    expect(task!.patterns.some((pattern) => pattern.includes('greet(name)'))).toBe(true);
    expect(answer.note).toContain('as data');
    // A folder covers the files inside it.
    expect((await history({ paths: 'src/greeting' })).tasks.map((entry) => entry.taskId)).toEqual([doneTask]);
  });

  it('keeps analysts’ observations with their evidence and says whether the files still match', async () => {
    const intake = await asCli('POST', '/api/v1/tasks/intake', { repoPath: repo, title: 'Polish greeting', goal: 'Localise the greeting', focus: ['src/**'], classification: ['tests'] });
    expect(intake.statusCode, intake.body).toBe(201);
    const taskId = (intake.json() as { taskId: string }).taskId;
    const report: AnalysisReport = {
      role: 'jerry-quality-analyst',
      scope: 'greeting',
      filesRead: ['src/greeting/greet.ts'],
      observations: [{ statement: 'greet trims the name before formatting', evidence: ['src/greeting/greet.ts:1'] }],
      risks: [],
      recommendations: [],
      confidence: { level: 'high', reason: 'one file' },
      gaps: ['none'],
    };
    expect((await asCli('POST', `/api/v1/tasks/${taskId}/analyses`, { report })).statusCode).toBe(201);
    const answer = await history({ paths: 'src/greeting/greet.ts' });
    expect(answer.analyses).toEqual([expect.objectContaining({ taskId, role: 'jerry-quality-analyst', observations: ['greet trims the name before formatting [src/greeting/greet.ts:1]'], fresh: 'unchanged' })]);
    // The intake task changed nothing yet: it is not an earlier change of this file.
    expect(answer.tasks.map((entry) => entry.taskId)).toEqual([doneTask]);
  });

  it('lists findings the user dismissed and rules that keep coming back on the files', async () => {
    const at = new Date().toISOString();
    const finding = (rule: string, status: string, reason = '') => ({
      task_id: doneTask, repo_root: repo, file: 'src/greeting/greet.ts', rule_id: rule, rule_version: '1', fingerprint: `${rule}-${status}-${Math.random()}`, source: 'quality', category: 'naming', severity: 'P3', confidence: 0.9,
      line_start: 1, line_end: 1, title: rule, evidence: 'x', why: 'y', fix: 'z', status, status_reason: reason, session_id: null, agent_id: null, fed_back_at: null, first_seen_at: at, last_seen_at: at, created_at: at, updated_at: at,
    });
    await store.kysely.insertInto('findings').values([finding('naming.short', 'FALSE_POSITIVE', 'greet is the domain word'), finding('errors.swallowed', 'FIXED'), finding('errors.swallowed', 'FIXED')]).execute();
    const { findings } = await history({ paths: 'src/greeting/**' });
    expect(findings.dismissed).toEqual([{ rule: 'naming.short', file: 'src/greeting/greet.ts', status: 'FALSE_POSITIVE', reason: 'greet is the domain word' }]);
    expect(findings.recurring).toEqual([{ rule: 'errors.swallowed', count: 2, files: ['src/greeting/greet.ts'] }]);
  });

  it('marks entries whose files changed since', async () => {
    fs.writeFileSync(greet, 'export const greet = (name: string) => `Hi, ${name}!`;\n');
    const answer = await history({ paths: 'src/greeting/greet.ts' });
    expect(answer.tasks[0]!.files[0]!.fresh).toBe('changed');
    expect(answer.analyses[0]!.fresh).toBe('changed');
  });

  it('finds work by words, and nothing where no task worked', async () => {
    expect((await history({ query: 'greeting helper' })).tasks.map((entry) => entry.taskId)).toEqual([doneTask]);
    expect((await history({ query: 'kubernetes ingress' })).tasks).toEqual([]);
    const none = await history({ paths: 'docs/guide.md' });
    expect(none).toMatchObject({ tasks: [], analyses: [], findings: { dismissed: [], recurring: [] }, truncated: false });
  });

  it('tells a new session how many finished tasks it can ask about', async () => {
    const here = await asCli('POST', '/api/v1/sessions', { sessionId: 'history-session', cwd: repo, source: 'startup' });
    expect(here.json()).toMatchObject({ finishedTasks: 1 });
    const elsewhere = await asCli('POST', '/api/v1/sessions', { sessionId: 'history-other', cwd: other, source: 'startup' });
    expect(elsewhere.json()).toMatchObject({ finishedTasks: 0 });
  });

  it('answers only for the requested project, and refuses unmonitored or empty requests', async () => {
    expect((await history({ paths: 'src/greeting/greet.ts' }, other)).tasks).toEqual([]);
    expect((await asCli('GET', `/api/v1/history?repoPath=${encodeURIComponent(repo)}`)).statusCode).toBe(400);
    const outside = createFixtureRepo(path.join(base, 'outside'));
    expect((await asCli('GET', `/api/v1/history?repoPath=${encodeURIComponent(outside)}&paths=src`)).statusCode).toBe(409);
    expect((await asCli('GET', `/api/v1/history?repoPath=${encodeURIComponent(repo)}&paths=src`, undefined)).statusCode).toBe(200);
    const unauthorised = await app.inject({ method: 'GET', url: `/api/v1/history?repoPath=${encodeURIComponent(repo)}&paths=src`, headers: { host: HOST } });
    expect(unauthorised.statusCode).toBe(401);
  });
});
