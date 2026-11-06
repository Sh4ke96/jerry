import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Finding, TaskSummary } from '@jerry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, ROOT, runBridge, snapshotRepo, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { sampleReport } from '../helpers/report-fixture.js';

const CLI = path.join(ROOT, 'dist', 'cli', 'jerry.mjs');

const GIT_IDENTITY = ['-c', 'user.name=JERRY Test', '-c', 'user.email=jerry-test@example.invalid', '-c', 'commit.gpgsign=false'];
const COMMITTED = ['export function load(read: () => string): string {', '  try {', '    return read();', '  } catch {}', "  return '';", '}', ''].join('\n');

/** Edits → debounced checks of the changed lines → findings with a lifecycle. */
describe('continuous quality findings (bundled bridge + Core)', () => {
  const base = tempDir('quality');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  const service = path.join(repo, 'src', 'service.ts');
  let core: RunningCore;
  let taskId: string;

  beforeAll(async () => {
    // A committed file that already has an empty catch: old lines are not this change's findings.
    fs.writeFileSync(service, COMMITTED);
    execFileSync('git', [...GIT_IDENTITY, '-C', repo, 'add', 'src/service.ts']);
    execFileSync('git', [...GIT_IDENTITY, '-C', repo, 'commit', '-q', '-m', 'service']);
    core = await startCore(home, { JERRY_QUALITY_DEBOUNCE_MS: '100' });
    const created = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Quality', scope: ['src/**'] })).body as { taskId: string };
    taskId = created.taskId;
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).status).toBe(201);
  });
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const edited = (file: string, tool = 'Edit') =>
    runBridge('event', { session_id: 'session-q', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: file }, tool_response: {}, tool_use_id: `toolu_${Math.random()}` }, env);

  const findings = async (query = ''): Promise<Finding[]> => (await api(core, 'GET', `/api/v1/findings?taskId=${taskId}${query}`)).body as Finding[];
  /** Polls until the condition holds (the checks run after the debounce). */
  const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return read();
  };

  it('records findings on the changed lines only, after the quiet period', async () => {
    const before = snapshotRepo(repo);
    fs.writeFileSync(service, `${COMMITTED}export async function save(write: () => Promise<void>): Promise<void> {\n  await write().catch(() => {});\n  // TODO\n}\n`);
    const after = snapshotRepo(repo);
    expect(edited(service).exitCode).toBe(0);

    const open = await until(() => findings(), (list) => list.length >= 2);
    expect(open.map((finding) => `${finding.ruleId}@${finding.lineStart}`).sort()).toEqual(['errors.promise-catch-noop@8', 'prose.vague-todo@9']);
    expect(open[0]).toMatchObject({ taskId, file: 'src/service.ts', status: 'OPEN', source: 'static', planRelated: false });
    // The committed empty catch on line 4 is not part of this change.
    expect(open.some((finding) => finding.ruleId === 'errors.empty-catch')).toBe(false);
    // JERRY only read: the repository (including .git) is exactly as the edit left it.
    expect(snapshotRepo(repo)).toEqual(after);
    expect(after).not.toEqual(before);

    const summary = ((await api(core, 'GET', '/api/v1/tasks')).body as TaskSummary[]).find((task) => task.taskId === taskId)!;
    expect(summary.findings).toMatchObject({ open: 2, bySeverity: { P2: 1, P3: 1 }, fixed: 0 });
  });

  it('tells Claude about new findings once, with its next guarded call, and lists them over MCP', async () => {
    // The session works on the task (an in-scope edit links it), then makes another call.
    const call = (toolUseId: string) =>
      runBridge('pre-tool-use', { session_id: 'session-q', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: service }, tool_use_id: toolUseId }, env);
    const first = call('toolu_fb1');
    expect(first.exitCode).toBe(0);
    const context = (JSON.parse(first.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(context).toContain('JERRY quality: 2 new finding(s)');
    expect(context).toMatch(/FND-\d+ P2 src\/service\.ts:8 Promise rejection swallowed/);
    expect(context).toContain('The user dismisses findings, not you.');
    // Told once: the next call carries no feedback.
    expect(call('toolu_fb2').stdout.trim()).toBe('');

    const mcp = await McpClient.connect({ ...env, CLAUDE_PROJECT_DIR: repo });
    try {
      const listed = await mcp.call('jerry_list_findings', {});
      expect(listed.isError, listed.text).toBe(false);
      expect(listed.structured).toMatchObject({ count: 2, findings: [{ severity: 'P2', at: 'src/service.ts:8', rule: 'errors.promise-catch-noop' }, { severity: 'P3', rule: 'prose.vague-todo' }] });
      const state = await mcp.call('jerry_get_state', {});
      expect((state.structured['next'] as { details: string }).details).toContain('1 open P1/P2 quality finding(s)');
    } finally {
      mcp.close();
    }
  });

  it('marks a finding FIXED when a later check no longer sees it, and reopens it when it returns', async () => {
    fs.writeFileSync(service, `${COMMITTED}export async function save(write: () => Promise<void>): Promise<void> {\n  await write();\n  // TODO\n}\n`);
    edited(service);
    const fixed = await until(() => findings('&status=FIXED'), (list) => list.length === 1);
    expect(fixed[0]).toMatchObject({ ruleId: 'errors.promise-catch-noop', status: 'FIXED', statusReason: expect.stringContaining('no longer found in src/service.ts') });

    fs.writeFileSync(service, `${COMMITTED}export async function save(write: () => Promise<void>): Promise<void> {\n  await write().catch(() => {});\n  // TODO\n}\n`);
    edited(service, 'Write');
    const reopened = await until(() => findings('&status=OPEN'), (list) => list.length === 2);
    expect(reopened.map((finding) => finding.ruleId).sort()).toEqual(['errors.promise-catch-noop', 'prose.vague-todo']);
    const detail = (await api(core, 'GET', `/api/v1/findings/${fixed[0]!.findingId}`)).body as { history: Array<{ from: string | null; to: string; actor: string }> };
    expect(detail.history.map((step) => `${step.from ?? 'new'}>${step.to}:${step.actor}`)).toEqual(['new>OPEN:core', 'OPEN>FIXED:core', 'FIXED>OPEN:core']);
  });

  it('lets only a decision with a reason dismiss a finding, and keeps it dismissed', async () => {
    const [todo] = await findings('&status=OPEN').then((list) => list.filter((finding) => finding.ruleId === 'prose.vague-todo'));
    expect((await api(core, 'POST', `/api/v1/findings/${todo!.findingId}/status`, { status: 'FALSE_POSITIVE', reason: '' })).status).toBe(400);
    expect((await api(core, 'POST', `/api/v1/findings/${todo!.findingId}/status`, { status: 'FIXED', reason: 'I fixed it' })).status).toBe(400);
    const dismissed = await api(core, 'POST', `/api/v1/findings/${todo!.findingId}/status`, { status: 'FALSE_POSITIVE', reason: 'placeholder kept on purpose for the demo' });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({ status: 'FALSE_POSITIVE', statusReason: 'placeholder kept on purpose for the demo' });
    expect((await api(core, 'POST', `/api/v1/findings/${todo!.findingId}/status`, { status: 'FALSE_POSITIVE', reason: 'again' })).status).toBe(409);
    expect((await api(core, 'POST', '/api/v1/findings/FND-99999/status', { status: 'OPEN', reason: 'x' })).status).toBe(404);

    // A later check sees the TODO again but does not reopen what the user dismissed.
    edited(service);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await findings()).find((finding) => finding.findingId === todo!.findingId)).toMatchObject({ status: 'FALSE_POSITIVE' });
  });

  it('jerry findings lists and shows them, and changing a status needs a terminal', () => {
    const cli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, JERRY_HOME: home }, encoding: 'utf8', windowsHide: true });
    const listed = cli(['findings', '--task', taskId]);
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/FND-\d+\s+P2 OPEN\s+src\/service\.ts:8/);
    expect(listed.stdout).not.toContain('FALSE_POSITIVE');
    expect(cli(['findings', 'list', '--task', taskId, '--all']).stdout).toContain('FALSE_POSITIVE');
    const id = /(FND-\d+)/.exec(listed.stdout)![1]!;
    const shown = cli(['findings', 'show', id]);
    expect(shown.stdout).toContain('why:');
    expect(shown.stdout).toMatch(/new\s+-> OPEN\s+by core/);
    const refused = cli(['findings', 'set', id, 'false_positive', '--reason', 'agent tries']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('interactive terminal');
  });

  it('records how Claude’s test runs end and suggests the tests for the changes', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'service.test.ts'), "import { expect, it } from 'vitest';\nit('loads text', () => expect(1).toBe(1));\n");
    const shell = (event: 'PostToolUse' | 'PostToolUseFailure', command: string, extra: Record<string, unknown>) =>
      runBridge('event', { session_id: 'session-q', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', hook_event_name: event, tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_${Math.random()}`, ...extra }, env);
    shell('PostToolUseFailure', 'npx vitest run src/service.test.ts', { error: 'Exit code 1\n FAIL src/service.test.ts' });
    shell('PostToolUse', 'npx vitest run src/service.test.ts', { tool_response: { stdout: 'ok\n      Tests  1 passed (1)\n', stderr: '' } });
    shell('PostToolUse', 'git status', { tool_response: { stdout: '', stderr: '' } });

    const summary = await until(
      async () => ((await api(core, 'GET', '/api/v1/tasks')).body as TaskSummary[]).find((task) => task.taskId === taskId)!,
      (task) => task.lastTestRun?.result === 'PASS',
    );
    expect(summary.lastTestRun).toMatchObject({ command: 'npx vitest run src/service.test.ts', result: 'PASS', exitCode: 0, summary: 'Tests 1 passed (1)', sessionId: 'session-q' });

    const targeted = (await api(core, 'GET', `/api/v1/tasks/${taskId}/targeted-tests`)).body as { files: string[]; lastRuns: Array<{ result: string; exitCode: number | null }> };
    expect(targeted.files).toEqual(['src/service.test.ts']);
    expect(targeted.lastRuns.map((run) => `${run.result}:${run.exitCode}`)).toEqual(['PASS:0', 'FAIL:1']);
  });

  it('puts open findings and contradicted check claims into the report evidence', async () => {
    runBridge('event', { session_id: 'session-q', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_npmtest', error: 'Exit code 1' }, env);
    await until(async () => ((await api(core, 'GET', '/api/v1/tasks')).body as TaskSummary[]).find((task) => task.taskId === taskId)!.lastTestRun?.command, (command) => command === 'npm test');
    const report = { ...sampleReport(['src/service.ts']), checks: [{ kind: 'test' as const, command: 'npm test', result: 'PASS' as const, details: '' }] };
    const submitted = await api(core, 'POST', `/api/v1/tasks/${taskId}/reports`, { report, submittedBy: 'user' });
    expect(submitted.status).toBe(201);
    const quality = (submitted.body as { evidence: { quality: { openFindings: number; serious: string[]; claimedVsObserved: string[]; lastTestRun: { result: string } } } }).evidence.quality;
    expect(quality.serious).toEqual([expect.stringMatching(/^FND-\d+ P2 src\/service\.ts:8 Promise rejection swallowed$/)]);
    expect(quality.claimedVsObserved).toEqual([expect.stringContaining('npm test: the report says PASS, JERRY saw FAIL')]);
    expect(quality.lastTestRun.result).toBe('FAIL');
    // Back to implementation for the remaining checks of this file.
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'REJECTED', comment: 'fix the findings' })).status).toBe(201);
  });

  it('ignores edits outside an approved plan and files outside the repository', async () => {
    const readme = path.join(repo, 'README.md');
    fs.appendFileSync(readme, '\n<!-- TODO -->\n');
    edited(readme);
    edited(path.join(base, 'elsewhere.ts'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await findings()).some((finding) => finding.file === 'README.md')).toBe(false);
  });
});
