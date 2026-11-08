import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisReport, TaskDetail, WorkflowTransition } from '@jerry/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';

/** Task intake, read-only analysts, and the plan built on their reports. */
describe('analysis first: intake, analysts, plan from their reports (bundled bridge + MCP + Core)', () => {
  const base = tempDir('analysis-first');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  let core: RunningCore;
  let mcp: McpClient | null = null;
  let taskId = '';

  beforeAll(async () => {
    core = await startCore(home);
  });
  afterEach(() => {
    mcp?.close();
    mcp = null;
  });
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const connect = async (): Promise<McpClient> => (mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 'session-x' }));
  const hook = (event: Record<string, unknown>) => runBridge(event['hook_event_name'] === 'PreToolUse' ? 'pre-tool-use' : 'event', { session_id: 'session-x', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', ...event }, env);
  const detail = async (): Promise<TaskDetail> => (await api(core, 'GET', `/api/v1/tasks/${taskId}`)).body as TaskDetail;
  const report = (role: AnalysisReport['role']): AnalysisReport => ({
    role,
    scope: 'the answer constant',
    filesRead: ['src/app.ts'],
    observations: [{ statement: 'The answer is a hard-coded constant', evidence: ['src/app.ts:1'] }],
    risks: [{ risk: 'Callers depend on the literal', severity: 'medium', scenario: 'a consumer compares with 42' }],
    recommendations: ['Keep the export name'],
    confidence: { level: 'high', reason: 'one small file' },
    gaps: ['No tests exist to show the callers'],
  });

  it('takes in a task before its plan: Discovery, the focus as scope, nothing approved', async () => {
    const client = await connect();
    const started = await client.call('start_task', { title: 'Make the answer configurable', goal: 'Read the answer from configuration instead of a constant', focus: ['src/**'] });
    expect(started.isError, started.text).toBe(false);
    expect(started.structured).toMatchObject({ state: 'DISCOVERY', focus: ['src/**'] });
    // No classification: all three analysts, as before JERRY sized the analysis.
    expect(started.text).toContain("all three of JERRY's analysts");
    expect(started.structured['analysts']).toEqual(['jerry-architecture-analyst', 'jerry-risk-analyst', 'jerry-quality-analyst']);
    taskId = started.structured['taskId'] as string;

    const task = await detail();
    expect(task).toMatchObject({ state: 'DISCOVERY', goal: 'Read the answer from configuration instead of a constant', planDecision: null });
    expect(task.plan.document).toBeUndefined();
    expect(task.sessions.map((session) => session.sessionId)).toEqual(['session-x']);

    // Nothing is approved: an edit in the focus area is a deviation.
    const edit = hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src', 'other.ts') }, tool_use_id: 'toolu_edit1' });
    expect(edit.exitCode).toBe(0);
    expect(edit.stdout).toContain('deviation');

    const state = await client.call('get_state', {});
    expect(state.structured['next']).toMatchObject({ action: 'analyse-then-plan' });
  });

  it('refuses an intake without a focus or goal', async () => {
    const client = await connect();
    expect((await client.call('start_task', { title: 'x', goal: '', focus: ['src/**'] })).isError).toBe(true);
    expect((await client.call('start_task', { title: 'x', goal: 'y', focus: [] })).isError).toBe(true);
  });

  it("moves to Analysis with the first analyst's report and lists reports and gaps", async () => {
    const client = await connect();
    const saved = await client.call('submit_analysis_report', { taskId, report: report('jerry-architecture-analyst') });
    expect(saved.isError, saved.text).toBe(false);
    expect((await detail()).state).toBe('PARALLEL_ANALYSIS');
    // A second report changes no state.
    await client.call('submit_analysis_report', { taskId, report: report('jerry-risk-analyst') });
    expect((await detail()).state).toBe('PARALLEL_ANALYSIS');

    // The quality analyst stopped without a report: a gap, not a success.
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: {}, tool_use_id: 'toolu_spawnq' });
    hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-q', agent_type: 'jerry:jerry-quality-analyst' });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-q', agent_type: 'jerry:jerry-quality-analyst' });

    const analysis = await client.call('get_analysis', { taskId: taskId.toLowerCase() });
    expect(analysis.isError, analysis.text).toBe(false);
    expect(analysis.structured).toMatchObject({
      taskId,
      state: 'PARALLEL_ANALYSIS',
      goal: 'Read the answer from configuration instead of a constant',
      focus: ['src/**'],
      reports: [
        { role: 'jerry-architecture-analyst', observations: ['The answer is a hard-coded constant [src/app.ts:1]'], risks: ['medium: Callers depend on the literal (a consumer compares with 42)'], gaps: ['No tests exist to show the callers'] },
        { role: 'jerry-risk-analyst' },
      ],
      gaps: ['jerry:jerry-quality-analyst stopped without a report'],
      running: 0,
      rolesWithoutReport: ['jerry-quality-analyst'],
    });
    expect(analysis.text).toContain('plan.analysis.reports');
  });

  it('refuses a plan citing reports the task does not have', async () => {
    const client = await connect();
    const plan = { ...samplePlan(repo), analysis: { reports: [9999], gaps: [] } };
    const result = await client.call('submit_plan', { taskId, plan });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('9999');
    expect((await detail()).state).toBe('PARALLEL_ANALYSIS');
    // A new task cannot cite reports either.
    expect((await client.call('submit_plan', { title: 'Other', plan })).isError).toBe(true);
  });

  it('closes the analysis with the plan built on the reports, which then waits for the user', async () => {
    const client = await connect();
    const ids = (await detail()).analyses.map((record) => record.id);
    const plan = { ...samplePlan(repo, ['src/**', 'tests/**']), analysis: { reports: ids, gaps: ['jerry-quality-analyst stopped without a report'] } };
    const submitted = await client.call('submit_plan', { taskId, plan });
    expect(submitted.isError, submitted.text).toBe(false);
    expect(submitted.structured).toMatchObject({ taskId, planVersion: 2, state: 'WAIT_PLAN_APPROVAL', completeness: { level: 'complete', missing: [], informational: true } });

    const task = await detail();
    expect(task.plan.document?.analysis).toEqual({ reports: ids, gaps: ['jerry-quality-analyst stopped without a report'] });
    const transitions = (await api(core, 'GET', `/api/v1/tasks/${taskId}/transitions`)).body as WorkflowTransition[];
    expect(transitions.map((step) => `${step.event}:${step.actor}:${step.to}`)).toEqual([
      'task.started:claude:DISCOVERY',
      'analysis.started:core:PARALLEL_ANALYSIS',
      'analysis.completed:core:PLAN_DRAFT',
      'plan.revised:claude:WAIT_PLAN_APPROVAL',
    ]);

    // Only the user approves; then edits in the plan's scope are covered.
    const approved = await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 2, decision: 'APPROVED', confirmTaskId: taskId });
    expect(approved.status).toBe(201);
    expect((await detail()).state).toBe('IMPLEMENTATION');
  });

  it('lets a small change skip the analysts: a plan straight from discovery', async () => {
    const client = await connect();
    const started = await client.call('start_task', { title: 'Typo', goal: 'Fix a typo', focus: ['README.md'] });
    const id = started.structured['taskId'] as string;
    const submitted = await client.call('submit_plan', { taskId: id, plan: samplePlan(repo, ['README.md']) });
    expect(submitted.structured).toMatchObject({ planVersion: 2, state: 'WAIT_PLAN_APPROVAL' });
    // The sample plan changes files outside README.md: JERRY's completeness check says so, and only informs.
    // Runs of the earlier task in the same session are not this task's gaps.
    expect(submitted.structured['completeness']).toMatchObject({ level: 'incomplete', missing: [expect.stringContaining('changes outside the scope'), expect.stringContaining('step files outside the scope')] });
    expect(submitted.text).toContain('completeness check');
    const summary = (await api(core, 'GET', `/api/v1/tasks/${id}`)).body as TaskDetail;
    expect(summary.planGrade).toMatchObject({ planVersion: 2, level: 'incomplete' });
    const approved = await api(core, 'POST', `/api/v1/tasks/${id}/approvals`, { stage: 'PLAN', version: 2, decision: 'APPROVED', confirmTaskId: id });
    expect(approved.status).toBe(201);
  });

  it('sizes the analysis to the kind of change and measures missing reports against it', async () => {
    const client = await connect();
    const tests = await client.call('start_task', { title: 'More tests', goal: 'Cover the answer with tests', focus: ['tests/**'], classification: ['tests'] });
    expect(tests.isError, tests.text).toBe(false);
    expect(tests.structured['analysts']).toEqual(['jerry-quality-analyst']);
    expect(tests.text).toContain('only these JERRY analyst(s)');
    const testsId = tests.structured['taskId'] as string;
    expect(((await api(core, 'GET', `/api/v1/tasks/${testsId}`)).body as TaskDetail).analysts).toMatchObject({ roles: ['jerry-quality-analyst'], reasons: [expect.stringContaining('tests')] });
    // Only the suggested analyst counts as missing.
    expect((await client.call('get_analysis', { taskId: testsId })).structured).toMatchObject({ rolesWithoutReport: ['jerry-quality-analyst'] });
    await client.call('submit_analysis_report', { taskId: testsId, report: report('jerry-quality-analyst') });
    expect((await client.call('get_analysis', { taskId: testsId })).structured).toMatchObject({ rolesWithoutReport: [] });

    const docs = await client.call('start_task', { title: 'Docs', goal: 'Explain the answer', focus: ['README.md'], classification: ['docs'] });
    expect(docs.structured['analysts']).toEqual([]);
    expect(docs.text).toContain('No analyst is needed');

    const sensitive = await client.call('start_task', { title: 'Auth', goal: 'Sign requests', focus: ['src/**'], classification: ['api-backend', 'security'] });
    expect(sensitive.structured['analysts']).toEqual(['jerry-architecture-analyst', 'jerry-risk-analyst', 'jerry-quality-analyst']);
    const full = await client.call('start_task', { title: 'Docs, deeply', goal: 'Explain the answer', focus: ['README.md'], classification: ['docs'], depth: 'full' });
    expect(full.structured['analysts']).toHaveLength(3);
    expect((await client.call('start_task', { title: 'x', goal: 'y', focus: ['src/**'], classification: ['everything'] })).isError).toBe(true);
  });
});
