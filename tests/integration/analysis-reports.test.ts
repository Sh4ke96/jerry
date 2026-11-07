import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisReport, TaskDetail } from '@jerry/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';

/** Analysts' evidence-backed reports, subagent runs, and the warning before a fourth subagent. */
describe('analysis reports and subagent runs (bundled bridge + MCP + Core)', () => {
  const base = tempDir('analysis');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  let core: RunningCore;
  let mcp: McpClient | null = null;
  let taskId: string;

  beforeAll(async () => {
    core = await startCore(home);
    const created = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Analysed change', scope: ['src/**'] })).body as { taskId: string };
    taskId = created.taskId;
  });
  afterEach(() => {
    mcp?.close();
    mcp = null;
  });
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const hook = (event: Record<string, unknown>) => runBridge(event['hook_event_name'] === 'PreToolUse' ? 'pre-tool-use' : 'event', { session_id: 'session-a', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', ...event }, env);
  const detail = async (): Promise<TaskDetail> => (await api(core, 'GET', `/api/v1/tasks/${taskId}`)).body as TaskDetail;
  const report = (evidence: string[]): AnalysisReport => ({
    role: 'jerry-risk-analyst',
    scope: 'answer constant',
    filesRead: ['src/app.ts'],
    observations: [{ statement: 'The answer is a hard-coded constant', evidence }],
    risks: [{ risk: 'Callers depend on the literal', severity: 'low', scenario: '' }],
    recommendations: ['Keep the export name'],
    confidence: { level: 'high', reason: 'one small file' },
    gaps: [],
  });

  it('records a subagent run and ties the analyst’s report to it through the hook', async () => {
    // The subagent starts, then calls the MCP tool; the hook sees the call with the subagent's ID.
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, tool_use_id: 'toolu_spawn1' }).exitCode).toBe(0);
    expect(hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-risk', agent_type: 'jerry:jerry-risk-analyst' }).exitCode).toBe(0);
    expect(hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_jerry_guardian__submit_analysis_report', tool_input: {}, tool_use_id: 'toolu_report1', agent_id: 'agent-risk' }).exitCode).toBe(0);

    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 'session-a' });
    const submitted = await mcp.call('submit_analysis_report', { taskId, report: report(['src/app.ts:1']) }, 'toolu_report1');
    expect(submitted.isError, submitted.text).toBe(false);
    expect(submitted.structured).toMatchObject({ saved: true, citations: { checked: 1, problems: [] } });

    expect(hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-risk', agent_type: 'jerry:jerry-risk-analyst' }).exitCode).toBe(0);
    const task = await detail();
    expect(task.analyses).toMatchObject([{ agentId: 'agent-risk', sessionId: 'session-a', report: { role: 'jerry-risk-analyst' }, citations: { checked: 1, missingFiles: [], outOfRange: [] } }]);
    expect(task.agentRuns).toMatchObject([{ agentId: 'agent-risk', status: 'completed', reportId: task.analyses[0]!.id }]);
  });

  it('flags citations of files that do not exist or lines beyond the end', async () => {
    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 'session-a' });
    const submitted = await mcp.call('submit_analysis_report', { taskId, report: report(['src/app.ts:1', 'src/ghost.ts:3', 'src/app.ts:400', path.join(repo, 'src', 'app.ts') + ':1']) });
    expect(submitted.structured).toMatchObject({ citations: { checked: 4, problems: [expect.stringContaining('src/ghost.ts'), expect.stringContaining('src/app.ts:400')] } });
    expect(submitted.text).toContain('Correct these citations');
  });

  it('rejects a report without evidence for an observation', async () => {
    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo });
    const result = await mcp.call('submit_analysis_report', { taskId, report: { ...report([]), observations: [{ statement: 'no proof', evidence: [] }] } });
    expect(result.isError).toBe(true);
    expect((await mcp.call('submit_analysis_report', { taskId, report: report(['src/app.ts']) })).text).toContain('path:line');
  });

  it('marks an analyst that stopped without a report as a gap', async () => {
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, tool_use_id: 'toolu_spawn2' });
    hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-quality', agent_type: 'jerry:jerry-quality-analyst' });
    hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-quality', agent_type: 'jerry:jerry-quality-analyst' });
    expect((await detail()).agentRuns.find((run) => run.agentId === 'agent-quality')).toMatchObject({ status: 'no-report', reportId: null });
  });

  it('warns Claude before a fourth subagent runs at the same time', () => {
    for (let index = 0; index < 3; index += 1) {
      expect(hook({ session_id: 'session-b', hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, tool_use_id: `toolu_b${index}` })).toMatchObject({ exitCode: 0, stdout: '' });
    }
    const fourth = hook({ session_id: 'session-b', hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, tool_use_id: 'toolu_b3' });
    expect(fourth.exitCode).toBe(0);
    expect(JSON.parse(fourth.stdout).hookSpecificOutput.additionalContext).toContain('monitor.subagent-cap');
    // One finishes: room again.
    hook({ session_id: 'session-b', hook_event_name: 'SubagentStop', agent_id: 'b-1', agent_type: 'jerry:jerry-risk-analyst' });
    hook({ session_id: 'session-b', hook_event_name: 'SubagentStop', agent_id: 'b-2', agent_type: 'jerry:jerry-risk-analyst' });
    expect(hook({ session_id: 'session-b', hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {}, tool_use_id: 'toolu_b4' })).toMatchObject({ exitCode: 0, stdout: '' });
  });
});
