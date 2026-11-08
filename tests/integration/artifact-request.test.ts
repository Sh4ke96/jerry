import fs from 'node:fs';
import path from 'node:path';
import type { TaskSummary } from '@jerry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

/** The user's Artifact switch: at plan approval or later; Claude is told to create it when the task is done. */
describe('Artifact on request (Core + MCP)', () => {
  const base = tempDir('artifact-request');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  let core: RunningCore;
  let mcp: McpClient;

  beforeAll(async () => {
    core = await startCore(home, {}, { projects: [repo] });
    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 'session-a' });
  });
  afterAll(async () => {
    mcp.close();
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const summary = async (taskId: string): Promise<TaskSummary> => (await api(core, 'GET', `/api/v1/tasks/${taskId}`)).body as TaskSummary;
  const create = async (title: string, artifact = ''): Promise<string> => {
    const plan = { ...samplePlan(repo, ['src/**']), artifact };
    return ((await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title, scope: plan.scope.include, document: plan })).body as { taskId: string }).taskId;
  };
  /** Report and acceptance without review: the final checks complete the task. */
  const finish = async (taskId: string): Promise<void> => {
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' })).status).toBe(201);
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED', review: false })).status).toBe(201);
    expect((await summary(taskId)).state).toBe('DONE');
  };
  const nextDetails = async (): Promise<string> => String(((await mcp.call('get_state', {})).structured['next'] as { details: string }).details);

  it('takes the switch with the plan approval, and tells Claude to create the Artifact when the task is done', async () => {
    const taskId = await create('Greeting');
    // Only a plan approval carries it.
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: 'x', artifact: { wanted: true } })).status).toBe(400);
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED', artifact: { wanted: true, kind: 'architecture-before-after' } })).status).toBe(201);
    expect((await summary(taskId)).artifact).toMatchObject({ request: { wanted: true, kind: 'architecture-before-after', by: 'user' }, decision: null });
    // Not before the task is done.
    expect(await nextDetails()).not.toContain('/jerry:artifact');

    await finish(taskId);
    const waited = await mcp.call('wait_for_decision', { taskId, stage: 'implementation', version: 1 });
    expect(String(waited.structured['nextStep'])).toContain(`${taskId}: the architecture before and after (the user switched it on)`);
    expect(String(waited.structured['nextStep'])).toContain('/jerry:artifact');
    expect(await nextDetails()).toContain('without asking again');
    const report = await mcp.call('get_final_report', { taskId });
    expect((report.structured['artifact'] as { planned: string }).planned).toContain('wanted: architecture-before-after (requested by the user)');

    // Once the Artifact decision is recorded, the reminder ends and the switch is closed.
    expect((await mcp.call('record_artifact', { taskId, decision: 'declined', reason: 'changed my mind' })).isError).toBe(false);
    expect(await nextDetails()).not.toContain('/jerry:artifact');
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/artifact-request`, { wanted: true })).status).toBe(409);
  });

  it("counts the plan's recorded wish, lets the user override it later, and says nothing without a request", async () => {
    const fromPlan = await create('Endpoints', 'wanted: endpoint and contract map');
    expect((await summary(fromPlan)).artifact?.request).toEqual({ wanted: true, kind: 'endpoint-contract-map', by: 'plan', at: null });
    // The user turns it off on the task page: the switch wins.
    const off = await api(core, 'POST', `/api/v1/tasks/${fromPlan}/artifact-request`, { wanted: false });
    expect(off.status).toBe(200);
    expect((off.body as { request: { wanted: boolean; by: string } }).request).toMatchObject({ wanted: false, by: 'user' });
    expect((await api(core, 'POST', `/api/v1/tasks/${fromPlan}/artifact-request`, { wanted: true, kind: 'a poster' })).status).toBe(400);
    await api(core, 'POST', `/api/v1/tasks/${fromPlan}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    await finish(fromPlan);
    expect(await nextDetails()).not.toContain('/jerry:artifact');

    // A vague plan field is no request: Claude never decides for the user.
    const vague = await create('Vague', 'maybe a diagram later');
    expect((await summary(vague)).artifact?.request).toBeNull();
    await api(core, 'POST', `/api/v1/tasks/${vague}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    await finish(vague);
    const waited = await mcp.call('wait_for_decision', { taskId: vague, stage: 'implementation', version: 1 });
    expect(String(waited.structured['nextStep'])).not.toContain('/jerry:artifact');
  });
});
