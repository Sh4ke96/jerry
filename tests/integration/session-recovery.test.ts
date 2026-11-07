import fs from 'node:fs';
import path from 'node:path';
import type { TaskDetail } from '@jerry/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';

/**
 * JERRY knows which Claude Code session worked on which task, keeps Claude's progress
 * checkpoints, and gives a new, resumed or compacted session what it needs to continue.
 */
describe('session ↔ task correlation and session recovery (bundled bridge + MCP + Core)', () => {
  const base = tempDir('recovery');
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

  /** The MCP server as Claude Code starts it; the env session ID may be stale (e.g. after /clear). */
  const connect = async (sessionId: string): Promise<McpClient> => {
    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: sessionId });
    return mcp;
  };
  const hook = (sessionId: string, event: Record<string, unknown>) => ({ session_id: sessionId, cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', ...event });
  /** What Claude Code does before every MCP call: the PreToolUse hook, with the tool-use ID. */
  const preToolUse = (sessionId: string, toolName: string, toolUseId: string, toolInput: Record<string, unknown> = {}) =>
    runBridge('pre-tool-use', hook(sessionId, { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId }), env);
  const sessionStart = (sessionId: string, source: string): string => {
    const result = runBridge('session-start', hook(sessionId, { hook_event_name: 'SessionStart', source }), env);
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
  };
  const detail = async (): Promise<TaskDetail> => (await api(core, 'GET', `/api/v1/tasks/${taskId}`)).body as TaskDetail;

  it('starts a session with nothing to resume', () => {
    const context = sessionStart('session-a', 'startup');
    expect(context).toContain('There is no approved JERRY plan');
    expect(context).not.toContain('Open JERRY tasks');
  });

  it('links a submitted plan to the session the hook saw for that tool use, not the MCP server’s env', async () => {
    const client = await connect('stale-session-from-env');
    expect(preToolUse('session-a', 'mcp__plugin_jerry_guardian__submit_plan', 'toolu_submit').exitCode).toBe(0);
    const submitted = await client.call('submit_plan', { title: 'Greeting helper', plan: samplePlan(repo) }, 'toolu_submit');
    expect(submitted.isError, submitted.text).toBe(false);
    taskId = submitted.structured['taskId'] as string;
    expect((await detail()).sessions).toMatchObject([{ sessionId: 'session-a', lastActivity: 'plan.submitted', endedAt: null }]);
  });

  it('links in-scope edits to the task and keeps Claude’s checkpoint', async () => {
    await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    const write = runBridge('pre-tool-use', hook('session-a', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src', 'greeting', 'greet.ts') }, tool_use_id: 'toolu_write' }), env);
    expect(write).toMatchObject({ exitCode: 0, stdout: '' });
    expect((await detail()).sessions[0]).toMatchObject({ sessionId: 'session-a', lastActivity: 'edit' });

    // No tool-use ID (an older Claude Code): the session ID from the server's environment is used.
    const client = await connect('session-a');
    const saved = await client.call('save_checkpoint', { taskId, summary: 'Added greet() in src/greeting/greet.ts.', nextSteps: ['Write the unit test', 'Update the README'] });
    expect(saved.isError, saved.text).toBe(false);
    const task = await detail();
    expect(task.checkpoints).toMatchObject([{ sessionId: 'session-a', summary: 'Added greet() in src/greeting/greet.ts.', nextSteps: ['Write the unit test', 'Update the README'] }]);
    expect(task.lastCheckpoint?.summary).toBe('Added greet() in src/greeting/greet.ts.');
    expect(task.activity).toMatchObject({ sessionCount: 1, lastSessionId: 'session-a', lastSessionEndedAt: null });
  });

  it('refuses an invalid checkpoint with the reason', async () => {
    const client = await connect('session-a');
    expect((await client.call('save_checkpoint', { taskId, summary: '' })).isError).toBe(true);
    const unknown = await client.call('save_checkpoint', { taskId: 'JRY-9999', summary: 'x' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Unknown task');
  });

  it('records the end of the session and gives the next session the task and its checkpoint', async () => {
    expect(runBridge('event', hook('session-a', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }), env).exitCode).toBe(0);
    expect((await detail()).sessions[0]).toMatchObject({ endReason: 'prompt_input_exit', endedAt: expect.any(String) });

    const context = sessionStart('session-b', 'startup');
    expect(context).toContain(`Approved plan: ${taskId} v1`);
    expect(context).toContain(`Open JERRY tasks: 🛠️ ${taskId} "Greeting helper": in implementation, last worked on`);
    expect(context).toContain('last checkpoint: Added greet() in src/greeting/greet.ts. 💡 Next: Write the unit test; Update the README');
    expect(context).toContain('check them against the current code (git status, git diff)');
    expect(context).toContain('Save progress with the save_checkpoint tool');
    // The hard-rule statement is untouched.
    expect(context).toContain('you may not run any Git command that changes anything');
  });

  it('tells a resumed session that it worked on the task, and reopens the session', async () => {
    const context = sessionStart('session-a', 'resume');
    expect(context).toContain(`${taskId} "Greeting helper": in implementation, you worked on it in this session`);
    expect((await detail()).sessions.find((session) => session.sessionId === 'session-a')).toMatchObject({ endedAt: null, endReason: null });

    const client = await connect('session-a');
    const state = (await client.call('get_state')).structured;
    expect(state['currentTask']).toMatchObject({ taskId, workedInThisSession: true, lastCheckpoint: { summary: 'Added greet() in src/greeting/greet.ts.' } });
  });

  it('warns the next session not to continue a paused task', async () => {
    await api(core, 'POST', `/api/v1/tasks/${taskId}/transitions`, { event: 'task.paused' });
    const context = sessionStart('session-c', 'startup');
    expect(context).toContain(`There is no approved JERRY plan`);
    expect(context).toContain(`${taskId} "Greeting helper": paused, do not continue it until the user resumes it`);
    expect(context).not.toContain('Save progress with the save_checkpoint tool');
  });

  it('keeps finished work out of the start context, and refuses checkpoints on it', async () => {
    await api(core, 'POST', `/api/v1/tasks/${taskId}/transitions`, { event: 'task.cancelled' });
    expect(sessionStart('session-d', 'startup')).not.toContain('Open JERRY tasks');
    const client = await connect('session-d');
    const refused = await client.call('save_checkpoint', { taskId, summary: 'too late' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('CANCELLED');
  });
});
