import fs from 'node:fs';
import path from 'node:path';
import type { PlanDrift } from '@jerry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';

/** Up to three implementers on disjoint files, conflicting writes and plan drift. */
describe('implementers (bundled bridge + MCP + Core)', () => {
  const base = tempDir('implementers');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  let core: RunningCore;
  let mcp: McpClient;
  let taskId: string;

  beforeAll(async () => {
    core = await startCore(home);
    const plan = samplePlan(repo, ['src/**', 'tests/**']);
    const created = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Greeting', scope: plan.scope.include, document: plan })).body as { taskId: string };
    taskId = created.taskId;
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).status).toBe(201);
    mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 'session-i' });
  });
  afterAll(async () => {
    mcp.close();
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const hook = (event: Record<string, unknown>) =>
    runBridge(event['hook_event_name'] === 'PreToolUse' ? 'pre-tool-use' : 'event', { session_id: 'session-i', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', ...event }, env);
  const write = (agentId: string | null, file: string) => {
    const result = hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, file) }, tool_use_id: `toolu_${Math.random()}`, ...(agentId === null ? {} : { agent_id: agentId, agent_type: 'jerry:jerry-implementer' }) });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim() === '' ? 'PASS' : (/\[(monitor\.[\w-]+)\]/.exec(result.stdout)?.[1] ?? result.stdout);
  };

  it('refuses overlapping files, unknown steps and more than three implementers', async () => {
    const overlap = await mcp.call('jerry_assign_work', { taskId, assignments: [{ label: 'a', steps: [1], files: ['src/greeting/**'] }, { label: 'b', steps: [2], files: ['src/greeting/greet.ts'] }] });
    expect(overlap.isError).toBe(true);
    expect(overlap.text).toContain('would share files');
    expect((await mcp.call('jerry_assign_work', { taskId, assignments: [{ label: 'a', steps: [7] }] })).text).toContain('no step 7');
    const four = await mcp.call('jerry_assign_work', { taskId, assignments: ['a', 'b', 'c', 'd'].map((label, index) => ({ label, steps: [1], files: [`src/${index}.ts`] })) });
    expect(four.isError).toBe(true);
    expect((await mcp.call('jerry_assign_work', { taskId, assignments: [{ label: 'a', steps: [1], files: ['README.md'] }] })).text).toContain('outside the approved scope');
  });

  it('splits the plan and answers with the steps that may run in parallel', async () => {
    const assigned = await mcp.call('jerry_assign_work', { taskId, assignments: [{ label: 'code', steps: [1] }, { label: 'tests', steps: [2] }] });
    expect(assigned.isError, assigned.text).toBe(false);
    expect(assigned.structured).toMatchObject({
      assignments: [
        { label: 'code', steps: [1], files: ['src/greeting/greet.ts'] },
        { label: 'tests', steps: [2], files: ['tests/greeting/greet.test.ts'] },
      ],
      stepLayers: [[1], [2]],
    });
    // Implementers read their work order from the state: the steps and the assignments.
    const state = await mcp.call('jerry_get_state', {});
    expect(state.structured['currentTask']).toMatchObject({
      taskId,
      plan: { steps: [{ number: 1, step: 'Write greet with input trimming', files: ['src/greeting/greet.ts'] }, { number: 2 }], definitionOfDone: ['greet implemented', 'unit tests pass'] },
      assignments: [
        { label: 'code', steps: [1], started: false },
        { label: 'tests', steps: [2], started: false },
      ],
    });
  });

  it('binds an implementer by its first edit and warns outside its files or on a file another one writes', () => {
    hook({ hook_event_name: 'SubagentStart', agent_id: 'impl-a', agent_type: 'jerry:jerry-implementer' });
    hook({ hook_event_name: 'SubagentStart', agent_id: 'impl-b', agent_type: 'jerry:jerry-implementer' });
    expect(write('impl-a', 'src/greeting/greet.ts')).toBe('PASS');
    expect(write('impl-a', 'tests/greeting/greet.test.ts')).toBe('monitor.implementer-scope');
    // The warning did not stop impl-a, so the test file now has a running writer: impl-b must wait.
    expect(write('impl-b', 'tests/greeting/greet.test.ts')).toBe('monitor.concurrent-write');
    expect(write('impl-b', 'tests/greeting/greet.test.ts')).toBe('PASS');
    // impl-a is still running and wrote greet.ts: a second writer must wait.
    expect(write('impl-b', 'src/greeting/greet.ts')).toBe('monitor.concurrent-write');
    expect(write(null, 'src/greeting/greet.ts')).toBe('monitor.concurrent-write');
    hook({ hook_event_name: 'SubagentStop', agent_id: 'impl-a', agent_type: 'jerry:jerry-implementer' });
    // impl-a finished: no conflict any more, but greet.ts is still not impl-b's file.
    expect(write('impl-b', 'src/greeting/greet.ts')).toBe('monitor.implementer-scope');
    // impl-b wrote greet.ts too and still runs; once it stops, the main session may edit it.
    expect(write(null, 'src/greeting/greet.ts')).toBe('monitor.concurrent-write');
    hook({ hook_event_name: 'SubagentStop', agent_id: 'impl-b', agent_type: 'jerry:jerry-implementer' });
    expect(write(null, 'src/greeting/greet.ts')).toBe('PASS');
  });

  it('reports drift: changed files no step names, and steps not started', async () => {
    fs.mkdirSync(path.join(repo, 'src', 'greeting'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'greeting', 'greet.ts'), 'export const greet = (name: string) => `Hello, ${name}!`;\n');
    fs.writeFileSync(path.join(repo, 'src', 'extra.ts'), 'export const extra = 1;\n');
    const drift = (await api(core, 'GET', `/api/v1/tasks/${taskId}/drift`)).body as PlanDrift;
    expect(drift.unplannedFiles).toEqual(['src/extra.ts']);
    expect(drift.untouchedSteps).toEqual([{ number: 2, step: 'Add unit tests' }]);
    expect(drift.layers).toEqual([[1], [2]]);
    expect(drift.assignments.map((assignment) => `${assignment.label}:${assignment.agentId}`)).toEqual(['code:impl-a', 'tests:impl-b']);
  });
});
