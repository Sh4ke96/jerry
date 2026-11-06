import fs from 'node:fs';
import path from 'node:path';
import type { TaskDetail, WorkflowTransition } from '@jerry/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

/**
 * ADR 0014: Claude reports the implementation; JERRY adds what it recorded itself; the user accepts
 * exactly that report version or sends it back with a comment.
 */
describe('implementation report and acceptance (bundled bridge + MCP + Core)', () => {
  const base = tempDir('report');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  let core: RunningCore;
  let mcp: McpClient | null = null;
  let taskId: string;

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

  const connect = async (): Promise<McpClient> => {
    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 'session-r' });
    return mcp;
  };
  const tool = (toolName: string, toolInput: Record<string, unknown>, toolUseId: string) =>
    runBridge('pre-tool-use', { session_id: 'session-r', cwd: repo, hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId }, env);
  const decide = (version: number, decision: 'APPROVED' | 'REJECTED', comment = '') => api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version, decision, comment });
  const detail = async (): Promise<TaskDetail> => (await api(core, 'GET', `/api/v1/tasks/${taskId}`)).body as TaskDetail;

  it('refuses a report before the plan is approved', async () => {
    const client = await connect();
    const submitted = await client.call('jerry_submit_plan', { title: 'Greeting helper', plan: samplePlan(repo) });
    taskId = submitted.structured['taskId'] as string;
    const early = await client.call('jerry_submit_report', { taskId, report: sampleReport() });
    expect(early.isError).toBe(true);
    expect(early.text).toContain('report.submitted is not possible while the task is WAIT_PLAN_APPROVAL');
    await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
  });

  it('rejects an incomplete report with the fields to fix', async () => {
    const client = await connect();
    const report = sampleReport();
    const unexplained = { ...report, checks: [{ kind: 'test', command: 'npm test', result: 'NOT_RUN', details: '' }] };
    const result = await client.call('jerry_submit_report', { taskId, report: unexplained });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('a check that did not run needs the reason');
    const { qaScenarios: _qa, ...withoutQa } = report;
    expect((await client.call('jerry_submit_report', { taskId, report: withoutQa })).text).toContain('qaScenarios');
  });

  it('records the report with what JERRY saw, and moves the task to the user', async () => {
    expect(tool('Write', { file_path: path.join(repo, 'src', 'greeting', 'greet.ts') }, 'toolu_w1')).toMatchObject({ exitCode: 0, stdout: '' });
    expect(JSON.parse(tool('Write', { file_path: path.join(repo, 'README.md') }, 'toolu_w2').stdout).systemMessage).toContain('monitor.out-of-scope');
    expect(tool('Bash', { command: 'git commit -am wip' }, 'toolu_b1').exitCode).toBe(2);

    const client = await connect();
    expect(tool('mcp__plugin_jerry_jerry__jerry_submit_report', {}, 'toolu_report1').exitCode).toBe(0);
    const result = await client.call('jerry_submit_report', { taskId, report: sampleReport() }, 'toolu_report1');
    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({ taskId, reportVersion: 1, state: 'WAIT_IMPLEMENTATION_ACCEPTANCE', jerryRecorded: { deviations: 1, blocked: 1, observedEdits: 2, unreportedEdits: ['README.md'] } });
    expect(result.text).toContain(`jerry approve ${taskId} --stage implementation --version 1`);
    expect(result.text).toContain('edited but not in the report: README.md');
    expect(result.text).toContain('1 check(s) failed or not run');

    const task = await detail();
    expect(task.state).toBe('WAIT_IMPLEMENTATION_ACCEPTANCE');
    expect(task.lastReport).toMatchObject({ version: 1, planVersion: 1, sessionId: 'session-r', evidence: { observedEdits: ['README.md', 'src/greeting/greet.ts'] } });
    expect(task.reportDecision).toBeNull();
    expect(task.sessions[0]).toMatchObject({ sessionId: 'session-r', lastActivity: 'report' });
  });

  it('treats edits while the report waits as deviations, and refuses a second report', async () => {
    expect(JSON.parse(tool('Write', { file_path: path.join(repo, 'src', 'greeting', 'greet.ts') }, 'toolu_w3').stdout).systemMessage).toContain('monitor.no-approved-plan');
    const client = await connect();
    expect((await client.call('jerry_get_state')).structured).toMatchObject({ next: { action: 'wait-for-acceptance' } });
    expect((await client.call('jerry_submit_report', { taskId, report: sampleReport() })).isError).toBe(true);
  });

  it('sends the report back with the user’s comment, which Claude then sees', async () => {
    expect((await decide(2, 'REJECTED')).status).toBe(409);
    expect((await decide(1, 'REJECTED', 'Handle empty names too.')).status).toBe(201);
    const task = await detail();
    expect(task.state).toBe('IMPLEMENTATION');
    expect(task.reportDecision).toMatchObject({ stage: 'IMPLEMENTATION', version: 1, decision: 'REJECTED', comment: 'Handle empty names too.' });

    const client = await connect();
    const state = (await client.call('jerry_get_state')).structured;
    expect(state['next']).toMatchObject({ action: 'apply-requested-changes', details: expect.stringContaining('"Handle empty names too."') });
    // The plan approval still holds: edits in scope pass again.
    expect(tool('Write', { file_path: path.join(repo, 'src', 'greeting', 'greet.ts') }, 'toolu_w4')).toMatchObject({ exitCode: 0, stdout: '' });
  });

  it('accepts exactly the latest report version, which moves the task to its final checks', async () => {
    const client = await connect();
    const second = await client.call('jerry_submit_report', { taskId, report: { ...sampleReport(), summary: 'Added greet(name), its unit test and empty-name handling.' } });
    expect(second.structured).toMatchObject({ reportVersion: 2 });
    expect((await decide(1, 'APPROVED')).status).toBe(409);
    expect((await decide(2, 'APPROVED')).status).toBe(201);

    const task = await detail();
    expect(task.state).toBe('FINAL_REPORT');
    expect(task.reports.map((report) => report.version)).toEqual([2, 1]);
    expect(task.reportDecision).toMatchObject({ version: 2, decision: 'APPROVED', contentHash: task.lastReport?.contentHash });
    const history = (await api(core, 'GET', `/api/v1/tasks/${taskId}/transitions`)).body as WorkflowTransition[];
    expect(history.map((step) => step.event)).toEqual(['plan.submitted', 'plan.approved', 'report.submitted', 'changes.requested', 'report.submitted', 'implementation.accepted']);
    expect((await connect().then((again) => again.call('jerry_get_state'))).structured).toMatchObject({ next: { action: 'final-checks' } });
  });
});
