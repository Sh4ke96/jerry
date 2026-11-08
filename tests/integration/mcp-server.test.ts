import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, preToolUse, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { DECISION_WAIT_CALLS, DECISION_WAIT_MS, decisionNextStep, decisionSummary, nextAction, skillsInstruction, workspaceInstruction } from '../../apps/mcp-server/src/tools.js';

describe('JERRY MCP server (bundled)', () => {
  const base = tempDir('mcp');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const otherRepo = createFixtureRepo(path.join(base, 'other-repo'));
  const home = path.join(base, 'home');
  let core: RunningCore;
  let client: McpClient;

  beforeAll(async () => {
    core = await startCore(home);
  });
  afterEach(() => client?.close());
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const connect = async (env: Record<string, string> = { JERRY_HOME: home, CLAUDE_PROJECT_DIR: repo }): Promise<McpClient> => {
    client = new McpClient(env);
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init['result']).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'jerry-guardian' }, capabilities: { tools: {} } });
    client.notify('notifications/initialized');
    return client;
  };

  it('offers state, checks and plan submission, and nothing that approves anything', async () => {
    const mcp = await connect();
    const listed = (await mcp.request('tools/list'))['result'] as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['assign_work', 'check_paths', 'finish_review', 'get_analysis', 'get_final_report', 'get_history', 'get_project_profile', 'get_review', 'get_state', 'list_deviations', 'list_findings', 'record_artifact', 'report_fixes', 'save_checkpoint', 'start_task', 'submit_analysis_report', 'submit_fix_plan', 'submit_plan', 'submit_report', 'submit_review', 'wait_for_decision']);
    expect(listed.tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(['submit_plan', 'start_task', 'record_artifact', 'submit_review', 'finish_review', 'submit_fix_plan', 'report_fixes', 'assign_work', 'submit_analysis_report', 'submit_report', 'save_checkpoint']);
    expect(names.some((name) => /approve|accept|reject|exclude|pause|resume|cancel|done|complete/.test(name))).toBe(false);
  });

  it('submits a plan as a task waiting for approval, and a revision voids the approval', async () => {
    const mcp = await connect();
    // A second repository keeps these tasks out of the plan-state test, which expects none in `repo`.
    const submitted = await mcp.call('submit_plan', { title: 'Greeting helper', repoPath: otherRepo, plan: samplePlan(otherRepo) });
    expect(submitted.isError).toBe(false);
    expect(submitted.structured).toMatchObject({ planVersion: 1, state: 'WAIT_PLAN_APPROVAL' });
    expect(submitted.text).toContain('Do not approve it yourself');
    const taskId = submitted.structured['taskId'] as string;
    // The first block is the human line the user sees in the tool row; the JSON follows it.
    expect(submitted.summary).toMatch(new RegExp(`^📋 ${taskId} plan v1 submitted · ⏳ waiting for your approval`));
    expect(submitted.text.split('\n').slice(1).join('\n')).toBe(JSON.stringify(submitted.structured, null, 2));

    const state = await mcp.call('get_state', { path: otherRepo });
    expect(state.summary).toBe(`🛡️ GUARDED · ⏳ ${taskId} waiting for plan approval · ⏳ 1 waiting for you`);
    expect((await mcp.call('check_paths', { paths: ['src/greeting/greet.ts'], cwd: otherRepo })).summary).toMatch(/^🔍 1 path\(s\): ✅ \d+ in scope · ⚠️ \d+ deviation · ⛔ \d+ blocked$/);

    const tasks = (await api(core, 'GET', '/api/v1/tasks')).body as Array<{ taskId: string; plan: { document?: { goal: string } }; planDecision: unknown }>;
    const stored = tasks.find((task) => task.taskId === taskId)!;
    expect(stored.plan.document?.goal).toContain('greeting helper');
    expect(stored.planDecision).toBeNull();

    await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    const revised = await mcp.call('submit_plan', { taskId, plan: { ...samplePlan(otherRepo), goal: 'Add a localised greeting helper.' } });
    expect(revised.structured).toMatchObject({ taskId, planVersion: 2, state: 'WAIT_PLAN_APPROVAL' });
    const after = ((await api(core, 'GET', '/api/v1/tasks')).body as Array<{ taskId: string; planDecision: unknown }>).find((task) => task.taskId === taskId)!;
    expect(after.planDecision).toBeNull();
  });

  it('rejects an incomplete plan with the fields to fix, and a new task without a title', async () => {
    const mcp = await connect();
    const { tests: _tests, ...withoutTests } = samplePlan(repo);
    const incomplete = await mcp.call('submit_plan', { title: 'x', plan: withoutTests });
    expect(incomplete.isError).toBe(true);
    expect(incomplete.text).toContain('tests');
    expect((await mcp.call('submit_plan', { plan: samplePlan(repo) })).text).toContain('needs a short title');
  });

  it('reports the live workflow state: none, waiting, in implementation, paused, cancelled', async () => {
    const mcp = await connect();
    expect((await mcp.call('get_state')).structured).toMatchObject({ guard: 'GUARDED', monitored: true, currentTask: null, next: { action: 'propose-plan' } });

    const created = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Live state', scope: ['src/**'] })).body as { taskId: string };
    expect((await mcp.call('get_state')).structured).toMatchObject({
      currentTask: { taskId: created.taskId, state: 'WAIT_PLAN_APPROVAL' },
      next: { action: 'wait-for-approval' },
    });

    // Approved while the session is running: the tool sees it immediately.
    await api(core, 'POST', `/api/v1/tasks/${created.taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    const state = (await mcp.call('get_state')).structured;
    expect(state).toMatchObject({ approved: [{ taskId: created.taskId, scope: ['src/**'], state: 'IMPLEMENTATION' }], open: [], next: { action: 'work-within-approved-scope' } });
    expect(String(state['hardRules'])).toContain('No Git command');

    await api(core, 'POST', `/api/v1/tasks/${created.taskId}/transitions`, { event: 'task.paused' });
    expect((await mcp.call('get_state')).structured).toMatchObject({ approved: [], open: [{ taskId: created.taskId, state: 'PAUSED' }], next: { action: 'paused' } });

    await api(core, 'POST', `/api/v1/tasks/${created.taskId}/transitions`, { event: 'task.cancelled' });
    expect((await mcp.call('get_state')).structured).toMatchObject({ approved: [], open: [], currentTask: null, next: { action: 'propose-plan' } });

    // Later tests preview edits against an approved plan in this repository.
    const next = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Live state again', scope: ['src/**'] })).body as { taskId: string };
    await api(core, 'POST', `/api/v1/tasks/${next.taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
  });

  it('previews gate decisions without recording them', async () => {
    const mcp = await connect();
    const before = ((await api(core, 'GET', '/api/v1/events?limit=500')).body as unknown[]).length;
    const result = await mcp.call('check_paths', { paths: ['src/app.ts', 'src/other.ts', 'README.md', '.git/config'] });
    expect(result.structured).toMatchObject({
      decisions: [
        // The fixture's src/app.ts holds the user's uncommitted change; a preview shows the warning without using it up.
        { path: 'src/app.ts', verdict: 'WARN', rule: 'monitor.user-uncommitted-file' },
        { path: 'src/other.ts', verdict: 'PASS', rule: 'monitor.in-approved-scope' },
        { path: 'README.md', verdict: 'WARN', rule: 'monitor.out-of-scope' },
        { path: '.git/config', verdict: 'DENY', rule: 'hard.git-metadata' },
      ],
    });
    expect(((await api(core, 'GET', '/api/v1/events?limit=500')).body as unknown[]).length).toBe(before);
  });

  it('lists recorded deviations of the repository', async () => {
    runBridge('pre-tool-use', preToolUse(repo, 'Write', { file_path: path.join(repo, 'README.md') }), { JERRY_HOME: home });
    runBridge('pre-tool-use', preToolUse(repo, 'Bash', { command: 'git push' }), { JERRY_HOME: home });
    const mcp = await connect();
    const result = await mcp.call('list_deviations');
    const deviations = result.structured['deviations'] as Array<{ verdict: string; rule: string }>;
    expect(deviations.map((deviation) => `${deviation.verdict}:${deviation.rule}`)).toEqual(expect.arrayContaining(['WARN:monitor.out-of-scope']));
  });

  it('says plainly when Core is unreachable, instead of guessing', async () => {
    const mcp = await connect({ JERRY_HOME: path.join(base, 'no-core-here'), CLAUDE_PROJECT_DIR: repo });
    const result = await mcp.call('get_state');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('JERRY Core is not reachable');
  });

  it("waits for the user's decision and says what came: approved, rejected with the comment, or a cancelled task", async () => {
    const mcp = await connect();
    const task = async (title: string): Promise<string> => ((await api(core, 'POST', '/api/v1/tasks', { repoPath: otherRepo, title, scope: ['src/**'] })).body as { taskId: string }).taskId;

    // The user approves a moment after Claude started waiting: the same call returns the approval.
    const approvedId = await task('Wait for approval');
    const waiting = mcp.call('wait_for_decision', { taskId: approvedId.toLowerCase(), stage: 'plan', version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await api(core, 'POST', `/api/v1/tasks/${approvedId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    const approved = await waiting;
    expect(approved.isError).toBe(false);
    expect(approved.summary).toBe(`✅ ${approvedId} plan v1 approved — continue`);
    expect(approved.structured).toMatchObject({ taskId: approvedId, stage: 'plan', version: 1, status: 'approved', state: 'IMPLEMENTATION' });
    expect(String(approved.structured['nextStep'])).toContain('/jerry:implement');

    const rejectedId = await task('Wait for rejection');
    await api(core, 'POST', `/api/v1/tasks/${rejectedId}/approvals`, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: 'Split step 2' });
    const rejected = await mcp.call('wait_for_decision', { taskId: rejectedId, stage: 'plan', version: 1 });
    expect(rejected.summary).toBe(`❌ ${rejectedId} plan v1 rejected: Split step 2`);
    expect(String(rejected.structured['nextStep'])).toContain('submit_plan');

    // Waiting decides nothing: a cancelled task gets no decision, and the wait ends at once.
    const cancelledId = await task('Cancelled while waiting');
    await api(core, 'POST', `/api/v1/tasks/${cancelledId}/transitions`, { event: 'task.cancelled' });
    const cancelled = await mcp.call('wait_for_decision', { taskId: cancelledId, stage: 'plan', version: 1 });
    expect(cancelled.summary).toBe(`🚫 ${cancelledId} is cancelled: no decision will come`);
    expect(cancelled.structured).toMatchObject({ status: 'pending', state: 'CANCELLED' });
    const tasks = (await api(core, 'GET', '/api/v1/tasks')).body as Array<{ taskId: string; planDecision: unknown }>;
    expect(tasks.find((candidate) => candidate.taskId === cancelledId)?.planDecision).toBeNull();

    const refused = await mcp.call('wait_for_decision', { taskId: approvedId, stage: 'approve', version: 1 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('plan, implementation or review-fix');
    expect((await mcp.call('wait_for_decision', { taskId: 'JRY-9999', stage: 'plan', version: 1 })).isError).toBe(true);
  });

  it('answers protocol errors without crashing', async () => {
    const mcp = await connect();
    expect((await mcp.request('tools/call', { name: 'approve_plan' }))['error']).toMatchObject({ code: -32602 });
    expect((await mcp.request('resources/list'))['error']).toMatchObject({ code: -32601 });
    expect((await mcp.request('ping'))['result']).toEqual({});
  });
});

describe('wait_for_decision answers', () => {
  const base = { taskId: 'JRY-0016', version: 4 } as const;

  it("stays inside one turn: below Claude Code's two-minute move to the background", () => {
    expect(DECISION_WAIT_MS).toBeLessThanOrEqual(120_000 - 30_000);
    expect(DECISION_WAIT_CALLS * DECISION_WAIT_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it('says what came in one line, and what Claude does next', () => {
    expect(decisionSummary({ ...base, stage: 'plan', status: 'approved', state: 'IMPLEMENTATION' })).toBe('✅ JRY-0016 plan v4 approved — continue');
    expect(decisionSummary({ ...base, stage: 'plan', status: 'rejected', state: 'PLAN_DRAFT' })).toBe('❌ JRY-0016 plan v4 rejected: no comment');
    expect(decisionSummary({ ...base, stage: 'implementation', status: 'approved', review: true, state: 'CODE_REVIEW' })).toBe('✅ JRY-0016 report v4 accepted with review — continue');
    expect(decisionSummary({ ...base, stage: 'review-fix', status: 'rejected', comment: 'Keep the API', state: 'REVIEW_REPORT' })).toBe('❌ JRY-0016 fix plan (round 4) rejected: Keep the API');
    const pending = { ...base, stage: 'plan', status: 'pending', state: 'WAIT_PLAN_APPROVAL' } as const;
    expect(decisionSummary(pending)).toBe('⏳ still waiting for your decision');
    expect(decisionNextStep(pending)).toContain(`at most ${DECISION_WAIT_CALLS} calls in a row`);
    expect(decisionNextStep(pending)).toContain('Never approve it yourself');
    expect(decisionNextStep({ ...base, stage: 'plan', status: 'rejected', state: 'PLAN_DRAFT' })).toContain('ask them what to change');
    expect(decisionNextStep({ ...base, stage: 'implementation', status: 'approved', review: true, state: 'CODE_REVIEW' })).toContain('/jerry:review');
    expect(decisionNextStep({ ...base, stage: 'implementation', status: 'approved', review: false, state: 'DONE' })).toContain('it is done');
    expect(decisionNextStep({ ...base, stage: 'review-fix', status: 'approved', state: 'FIX_IMPLEMENTATION' })).toContain('report_fixes');
  });

  it('names the added skills JERRY starts in the current task state, and nothing otherwise', () => {
    const skills = [
      { name: 'release-notes', description: 'Writes release notes.', states: ['CODE_REVIEW', 'REVERIFICATION'] as const },
      { name: 'a11y-check', description: 'Checks accessibility.', states: ['CODE_REVIEW'] as const },
    ].map((skill) => ({ ...skill, states: [...skill.states] }));
    const inReview = skillsInstruction(skills, [{ taskId: 'JRY-0001', state: 'CODE_REVIEW' }]);
    expect(inReview).toContain('JERRY starts skills here');
    expect(inReview).toContain('JRY-0001 is in CODE_REVIEW');
    expect(inReview).toContain('"release-notes" (Writes release notes.)');
    expect(inReview).toContain('"a11y-check"');
    expect(inReview).toContain('Skill tool');
    expect(skillsInstruction(skills, [{ taskId: 'JRY-0001', state: 'IMPLEMENTATION' }])).toBe('');
    expect(skillsInstruction(undefined, [{ taskId: 'JRY-0001', state: 'CODE_REVIEW' }])).toBe('');

    const state = { repoRoot: 'D:/Work/Repo', excluded: false, monitored: true, sessionTasks: [], skills, tasks: [] };
    expect(nextAction(state).details).not.toContain('JERRY starts skills');
    expect(nextAction({ ...state, monitored: false, excluded: true, skills }).details).not.toContain('JERRY starts skills');
  });

  it('knows the workspace: other repositories with waiting decisions, and a session in their parent folder', () => {
    const repo = (repoRoot: string, openTasks: number, waiting: number) => ({ repoRoot, project: true, present: true, openTasks, waiting, openTaskIds: [], waitingTaskIds: [] });
    const workspace = { id: 1, name: 'Shop', repos: [repo('D:/Work/api', 1, 1), repo('D:/Work/shop', 2, 0), repo('D:/Work/admin', 0, 0)] };
    const inShop = { repoRoot: 'D:/Work/shop', excluded: false, monitored: true, sessionTasks: [], tasks: [], workspace };
    expect(workspaceInstruction(inShop)).toBe('⏳ In workspace "Shop" decisions also wait in: D:/Work/api (1).');
    expect(nextAction(inShop).details).toContain('decisions also wait in: D:/Work/api (1)');
    // In the repository with the waiting decision, it is not repeated as "also".
    expect(workspaceInstruction({ ...inShop, repoRoot: 'D:/Work/api' })).toBe('');
    const inParent = { repoRoot: null, excluded: true, monitored: false, sessionTasks: [], tasks: [], workspace };
    expect(nextAction(inParent)).toMatchObject({ action: 'workspace', details: expect.stringContaining('This folder holds the repositories of workspace "Shop"') });
    expect(nextAction(inParent).details).toContain('One task may span several of them: plan it once, with repoPath set to the repository that leads the change and plan.repositoryScopes');
    expect(nextAction(inParent).details).toContain('not in this folder (JERRY records those as deviations)');
    expect(nextAction({ ...inParent, workspace: null }).action).toBe('none');
  });
});
