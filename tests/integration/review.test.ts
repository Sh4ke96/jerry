import fs from 'node:fs';
import path from 'node:path';
import type { ReviewState, ReviewSubmission, TaskDetail, WorkflowTransition } from '@jerry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';
import { sampleReport } from '../helpers/report-fixture.js';

/** ADR 0032–0035: three independent reviewers, coverage, the fix gate and re-review, then DONE. */
describe('independent code review (bundled bridge + MCP + Core)', () => {
  const base = tempDir('review');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  const greet = path.join(repo, 'src', 'greeting', 'greet.ts');
  let core: RunningCore;
  let mcp: McpClient;
  let taskId: string;

  beforeAll(async () => {
    core = await startCore(home);
    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 'session-v' });
  });
  afterAll(async () => {
    mcp.close();
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const hook = (event: Record<string, unknown>) => runBridge(event['hook_event_name'] === 'PreToolUse' ? 'pre-tool-use' : 'event', { session_id: 'session-v', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', ...event }, env);
  const detail = async (): Promise<TaskDetail> => (await api(core, 'GET', `/api/v1/tasks/${taskId}`)).body as TaskDetail;
  const review = async (): Promise<ReviewState> => (await api(core, 'GET', `/api/v1/tasks/${taskId}/review`)).body as ReviewState;
  const submission = (role: ReviewSubmission['role'], findings: ReviewSubmission['findings'] = [], files = ['src/greeting/greet.ts', 'src/app.ts']): ReviewSubmission => ({
    role,
    filesReviewed: files,
    summary: `${role} looked at the greeting`,
    findings,
    gaps: [],
  });
  const blankNames = { title: 'Blank names produce an odd greeting', severity: 'P2' as const, confidence: 0.8, file: 'src/greeting/greet.ts', line: 1, evidence: 'return `Hello, ${name}!`', whyItMatters: 'Users see "Hello, !"', suggestedFix: 'Fall back to "Hello!" for blank input' };
  /** A reviewer subagent submits through MCP; the hook saw its tool call, which ties the review to it. */
  const asSubagent = async (agentId: string, role: ReviewSubmission['role'], body: ReviewSubmission) => {
    hook({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: `jerry:${role}` });
    const toolUseId = `toolu_${agentId}_${Math.random()}`;
    hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_jerry_jerry__jerry_submit_review', tool_input: {}, tool_use_id: toolUseId, agent_id: agentId });
    const result = await mcp.call('jerry_submit_review', { taskId, review: body }, toolUseId);
    hook({ hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: `jerry:${role}` });
    return result;
  };

  /** ADR 0041–0042: the final report of the DONE task, and the Artifact as the user's recorded choice. */
  const checkFinalReportAndArtifact = async (): Promise<void> => {
    const filesBefore = (fs.readdirSync(repo, { recursive: true }) as string[]).filter((entry) => !entry.startsWith('.git')).sort();
    const report = await mcp.call('jerry_get_final_report', { taskId });
    expect(report.isError, report.text).toBe(false);
    expect(report.structured).toMatchObject({
      taskId,
      status: 'final',
      review: { outcome: 'passed', rounds: 2, findings: { total: 1, fixed: 1, open: [] } },
      commitSubjects: ['feat(greeting): add greet helper'],
      artifact: { decision: 'not-asked' },
      definitionOfDone: { passed: true, items: ['greet implemented', 'unit tests pass'] },
    });
    expect((report.structured['repositories'] as Array<{ changes: Array<{ path: string }> }>)[0]!.changes.map((change) => change.path)).toEqual(['src/greeting/greet.ts']);

    // Only claude.ai Artifact links are recorded; a decision needs no Artifact when the user declined.
    expect((await mcp.call('jerry_record_artifact', { taskId, decision: 'created', kind: 'other', title: 'x', url: 'https://evil.example/artifact/1' })).isError).toBe(true);
    expect((await mcp.call('jerry_record_artifact', { taskId, decision: 'declined', reason: 'not needed now' })).structured).toMatchObject({ saved: true, decision: 'declined' });
    const created = await mcp.call('jerry_record_artifact', { taskId, decision: 'created', kind: 'stakeholder-presentation', title: 'Greeting overview', url: 'https://claude.ai/code/artifact/0f6c1a2b-aaaa-bbbb-cccc-000000000001' });
    expect(created.structured).toMatchObject({ saved: true, decision: 'created' });
    expect(((await mcp.call('jerry_get_final_report', { taskId })).structured['artifact'] as Record<string, unknown>)).toMatchObject({ decision: 'created', kind: 'stakeholder-presentation', url: 'https://claude.ai/code/artifact/0f6c1a2b-aaaa-bbbb-cccc-000000000001' });
    expect((await api(core, 'GET', '/api/v1/artifacts')).body).toMatchObject([{ taskId, decision: 'created' }]);
    // JERRY wrote nothing into the repository.
    expect((fs.readdirSync(repo, { recursive: true }) as string[]).filter((entry) => !entry.startsWith('.git')).sort()).toEqual(filesBefore);
  };

  /** After three rounds JERRY stops the automatic loop; the user waives the rest (ADR 0035). */
  const checkMaxRounds = async (): Promise<void> => {
    const plan = samplePlan(repo, ['src/**']);
    const id = ((await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Stubborn finding', scope: plan.scope.include, document: plan })).body as { taskId: string }).taskId;
    await api(core, 'POST', `/api/v1/tasks/${id}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    await api(core, 'POST', `/api/v1/tasks/${id}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' });
    await api(core, 'POST', `/api/v1/tasks/${id}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED' });
    const reviewAll = async () => {
      for (const role of ['jerry-correctness-reviewer', 'jerry-security-reviewer', 'jerry-design-reviewer'] as const) {
        expect((await api(core, 'POST', `/api/v1/tasks/${id}/reviews`, { review: submission(role, role === 'jerry-correctness-reviewer' ? [blankNames] : []) })).status).toBe(201);
      }
    };
    for (let round = 1; round <= 3; round += 1) {
      await reviewAll();
      const state = (await api(core, 'GET', `/api/v1/tasks/${id}/review`)).body as ReviewState;
      expect(state.state).toBe('REVIEW_REPORT');
      const plan = { summary: 'retry', items: [{ findings: [state.openFindings[0]!.findingId], change: 'fix', files: ['src/greeting/greet.ts'] }] };
      const proposed = await api(core, 'POST', `/api/v1/tasks/${id}/fix-plan`, { plan });
      if (round === 3) {
        expect(proposed.status).toBe(409);
        expect(JSON.stringify(proposed.body)).toContain('the user decides now');
        break;
      }
      expect(proposed.status).toBe(201);
      await api(core, 'POST', `/api/v1/tasks/${id}/approvals`, { stage: 'REVIEW_FIX', version: round, decision: 'APPROVED' });
      await api(core, 'POST', `/api/v1/tasks/${id}/fixes`, { summary: 'tried again' });
    }
    expect((await api(core, 'POST', `/api/v1/tasks/${id}/review/skip`, { reason: 'accepted as a known limitation' })).status).toBe(200);
    const finished = (await api(core, 'GET', `/api/v1/tasks/${id}`)).body as TaskDetail;
    expect(finished.state).toBe('DONE');
    expect(finished.finalCheck?.conditions.find((condition) => condition.id === 'review.open-findings')).toMatchObject({ passed: false, blocking: false });
  };

  it('starts the review when the user accepts the implementation, with every changed file to cover', async () => {
    const plan = samplePlan(repo, ['src/**']);
    taskId = ((await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Greeting', scope: plan.scope.include, document: plan })).body as { taskId: string }).taskId;
    await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    fs.mkdirSync(path.dirname(greet), { recursive: true });
    fs.writeFileSync(greet, 'export const greet = (name: string) => `Hello, ${name}!`;\n');
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: greet }, tool_use_id: 'toolu_impl' });
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(['src/greeting/greet.ts']), submittedBy: 'user' })).status).toBe(201);
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED' })).status).toBe(201);

    expect((await detail()).state).toBe('CODE_REVIEW');
    const state = await review();
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]!.changedFiles).toContain('src/greeting/greet.ts');
    expect((await mcp.call('jerry_get_state', {})).structured['next']).toMatchObject({ action: 'review' });
  });

  it('records three reviews, merges the same finding, and tracks coverage and independence', async () => {
    expect((await asSubagent('rev-c', 'jerry-correctness-reviewer', submission('jerry-correctness-reviewer', [blankNames]))).isError).toBe(false);
    // A reviewer that writes is warned (it is read-only).
    // (README.md is outside the scope, so these attempts do not change the reviewed code.)
    const readme = path.join(repo, 'README.md');
    const write = hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: readme }, tool_use_id: 'toolu_revwrite', agent_id: 'rev-s' });
    hook({ hook_event_name: 'SubagentStart', agent_id: 'rev-s', agent_type: 'jerry:jerry-security-reviewer' });
    const warned = hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: readme }, tool_use_id: 'toolu_revwrite2', agent_id: 'rev-s' });
    expect(write.exitCode).toBe(0);
    expect(warned.stdout).toContain('monitor.read-only-agent-write');
    const security = await asSubagent('rev-s', 'jerry-security-reviewer', submission('jerry-security-reviewer', [{ ...blankNames, severity: 'P1', title: 'blank names produce an odd  greeting' }]));
    expect(security.structured).toMatchObject({ round: 1, independence: expect.stringContaining('also made') });
    expect((await detail()).state).toBe('CODE_REVIEW');

    // The third review comes from the main session (no subagent): recorded, not independent.
    // It names the file with an absolute path, as real reviewers sometimes do: stored repo-relative.
    const design = await mcp.call('jerry_submit_review', { taskId, review: submission('jerry-design-reviewer', [], [greet]) });
    expect(design.isError, design.text).toBe(false);

    const state = await review();
    expect((await detail()).state).toBe('REVIEW_REPORT');
    expect(state.openFindings).toHaveLength(1);
    expect(state.openFindings[0]).toMatchObject({ source: 'review', severity: 'P1', file: 'src/greeting/greet.ts', status: 'OPEN' });
    const round = state.rounds[0]!;
    expect(round.completedAt).not.toBeNull();
    expect(round.submissions.map((entry) => `${entry.role}:${entry.independent}`)).toEqual(['jerry-correctness-reviewer:true', 'jerry-security-reviewer:false', 'jerry-design-reviewer:false']);
    expect(round.submissions[2]!.filesReviewed).toEqual(['src/greeting/greet.ts']);
    expect(round.uncovered).toEqual(round.changedFiles.filter((file) => file !== 'src/greeting/greet.ts' && file !== 'src/app.ts'));
  });

  it('gates the fixes: a plan citing real findings, approved only by the user', async () => {
    const findingId = (await review()).openFindings[0]!.findingId;
    const unknown = await mcp.call('jerry_submit_fix_plan', { taskId, plan: { summary: 'x', items: [{ findings: ['FND-999'], change: 'x', files: ['src/greeting/greet.ts'] }] } });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('FND-999');
    const outside = await mcp.call('jerry_submit_fix_plan', { taskId, plan: { summary: 'x', items: [{ findings: [findingId], change: 'x', files: ['README.md'] }] } });
    expect(outside.text).toContain('outside the approved scope');

    const proposed = await mcp.call('jerry_submit_fix_plan', { taskId, plan: { summary: 'Handle blank names', items: [{ findings: [findingId], change: 'Fall back to "Hello!"', files: ['src/greeting/greet.ts'] }], tests: ['unit: blank name'] } });
    expect(proposed.isError, proposed.text).toBe(false);
    expect(proposed.text).toContain('--stage review-fix --version 1');
    expect((await detail()).state).toBe('WAIT_REVIEW_FIX_APPROVAL');
    // Before the approval an edit is a deviation.
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'README.md') }, tool_use_id: 'toolu_early' }).stdout).toContain('monitor.no-approved-plan');

    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'REVIEW_FIX', version: 2, decision: 'APPROVED' })).status).toBe(409);
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'REVIEW_FIX', version: 1, decision: 'APPROVED' })).status).toBe(201);
    expect((await detail()).state).toBe('FIX_IMPLEMENTATION');
  });

  it('re-reviews the fixes with the same reviewers, resolves the finding, and completes the task', async () => {
    fs.writeFileSync(greet, 'export const greet = (name: string) => (name.trim() === "" ? "Hello!" : `Hello, ${name}!`);\n');
    // An approved fix is no deviation; Claude is reminded of the open review finding instead.
    const fixEdit = hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: greet }, tool_use_id: 'toolu_fix' }).stdout;
    expect(fixEdit).not.toContain('systemMessage');
    expect(fixEdit).toContain('Blank names produce an odd greeting');
    const fixed = await mcp.call('jerry_report_fixes', { taskId, summary: 'Blank names fall back to "Hello!".' });
    expect(fixed.structured).toMatchObject({ reviewRound: 2, filesToReview: ['src/greeting/greet.ts'] });
    expect((await detail()).state).toBe('REVERIFICATION');

    for (const [agent, role] of [['rev-c2', 'jerry-correctness-reviewer'], ['rev-s2', 'jerry-security-reviewer'], ['rev-d2', 'jerry-design-reviewer']] as const) {
      expect((await asSubagent(agent, role, submission(role, [], ['src/greeting/greet.ts']))).isError).toBe(false);
    }
    const task = await detail();
    expect(task.finalCheck?.conditions.filter((condition) => condition.blocking && !condition.passed)).toEqual([]);
    expect(task.state).toBe('DONE');
    expect(task.finalCheck?.conditions.find((condition) => condition.id === 'review.done')).toMatchObject({ passed: true, detail: 'review passed after 2 round(s)' });
    // The approved fix after the report does not count as an unreported change.
    expect(task.finalCheck?.conditions.find((condition) => condition.id === 'code.unchanged-since-report')).toMatchObject({ passed: true });
    expect(task.finalCheck?.conditions.find((condition) => condition.id === 'review.independent')).toMatchObject({ passed: false });
    const state = await review();
    expect(state.outcome).toBe('passed');
    expect(state.openFindings).toEqual([]);

    await checkFinalReportAndArtifact();
    await checkMaxRounds();
    const history = ((await api(core, 'GET', `/api/v1/tasks/${taskId}/transitions`)).body as WorkflowTransition[]).map((step) => `${step.event}:${step.actor}`);
    expect(history.slice(-9)).toEqual([
      'report.submitted:user',
      'implementation.accepted:user',
      'review.reported:core',
      'fixes.proposed:claude',
      'fixes.approved:user',
      'fixes.reported:claude',
      'review.reported:core',
      'review.passed:core',
      'task.completed:core',
    ]);
  });
});
