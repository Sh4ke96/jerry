import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, preToolUse, runBridge, snapshotRepo, startCore, tempDir, type RunningCore } from '../helpers/harness.js';

/**
 * M0 acceptance: the shipped bridge + Core decide correctly for a real Git repository,
 * fail closed when Core is unavailable, and never modify the repository.
 */
describe('JERRY approval gate (bundled bridge + Core)', () => {
  let home: string;
  let repo: string;
  let outside: string;
  let core: RunningCore;
  let before: ReturnType<typeof snapshotRepo>;
  let env: Record<string, string>;

  beforeAll(async () => {
    home = tempDir('home');
    repo = createFixtureRepo(tempDir('repo'));
    outside = tempDir('outside');
    before = snapshotRepo(repo);
    // CLAUDE_CONFIG_DIR is pointed at a temp dir so protected-path rules never reference the real profile.
    env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(outside, '.claude') };
    core = await startCore(home);
  });

  afterAll(async () => {
    await core?.stop();
    for (const dir of [home, repo, outside]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const bridge = (toolName: string, toolInput: Record<string, unknown>, cwd = repo) => runBridge('pre-tool-use', preToolUse(cwd, toolName, toolInput), env);
  const write = (relativePath: string) => bridge('Write', { file_path: path.join(repo, relativePath), content: 'SECRET-CONTENT-MUST-NOT-BE-LOGGED' });

  it('blocks Write, Edit and write-capable shell commands before any plan exists', () => {
    const result = write('src/app.ts');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('write.no-approved-plan');

    expect(bridge('Edit', { file_path: path.join(repo, 'src/app.ts'), old_string: 'a', new_string: 'b' }).exitCode).toBe(2);
    expect(bridge('Bash', { command: 'rm -rf src' }).stderr).toContain('shell.no-approved-plan');
    expect(bridge('PowerShell', { command: 'Remove-Item -Recurse src' }).stderr).toContain('shell.no-approved-plan');
  });

  it('tells a new session that its repository has no approved plan yet', () => {
    const result = runBridge('session-start', { session_id: 'test-session', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }, env);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('There is no approved JERRY plan');
  });

  it('lets read-only shell commands through without a plan', () => {
    for (const [tool, command] of [
      ['Bash', 'git status --porcelain'],
      ['PowerShell', 'Get-ChildItem -Recurse'],
    ] as const) {
      const result = bridge(tool, { command });
      expect(result).toMatchObject({ exitCode: 0, stdout: '' });
    }
  });

  let taskId: string;

  it('keeps blocking while the plan is waiting for approval or rejected', async () => {
    const created = await api(core, 'POST', '/api/v1/tasks', { repoPath: path.join(repo, 'src'), title: 'Change answer', scope: ['src/**'] });
    expect(created.status).toBe(201);
    const task = created.body as { taskId: string; repoRoot: string; plan: { version: number } };
    taskId = task.taskId;
    expect(path.resolve(task.repoRoot)).toBe(path.resolve(repo));
    expect(write('src/app.ts').exitCode).toBe(2);

    const rejected = await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: 'not yet' });
    expect(rejected.status).toBe(201);
    expect(write('src/app.ts').stderr).toContain('write.no-approved-plan');
  });

  it('after approval, passes writes only inside the approved scope', async () => {
    const approved = await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    expect(approved.status).toBe(201);

    expect(write('src/app.ts')).toMatchObject({ exitCode: 0, stdout: '' });
    expect(write('src/new/module.ts').exitCode).toBe(0);
    expect(write('README.md').stderr).toContain('write.out-of-scope');
    expect(write('.git/config').stderr).toContain('write.git-metadata');
    expect(bridge('Write', { file_path: path.join(home, 'state', 'core-state.json') }).stderr).toContain('write.protected-path');
  });

  it('asks the user before write-capable shell commands in an approved repository', () => {
    const result = bridge('Bash', { command: 'npm test' });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } });
  });

  it('blocks agents from approving through the CLI or the API', () => {
    expect(bridge('Bash', { command: `jerry approve ${taskId} --stage plan --version 1` }).stderr).toContain('shell.self-approval');
    expect(bridge('PowerShell', { command: 'Get-Content $env:LOCALAPPDATA\\JERRY\\run\\core.json' }).stderr).toContain('shell.protected-path');
  });

  it('invalidates the approval when the plan changes, and refuses decisions on stale versions', async () => {
    const revised = await api(core, 'POST', `/api/v1/tasks/${taskId}/plan`, { scope: ['src/**', 'test/**'] });
    expect(revised.status).toBe(200);
    expect((revised.body as { plan: { version: number } }).plan.version).toBe(2);
    expect(write('src/app.ts').stderr).toContain('write.no-approved-plan');

    const stale = await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    expect(stale.status).toBe(409);
  });

  it('rejects API calls without the local token', async () => {
    const response = await api(core, 'GET', '/api/v1/tasks', undefined, 'f'.repeat(64));
    expect(response.status).toBe(401);
  });

  it('keeps task and approval state across a Core restart', async () => {
    await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 2, decision: 'APPROVED' });
    await core.stop();
    core = await startCore(home);
    const tasks = await api(core, 'GET', '/api/v1/tasks');
    expect(tasks.body).toMatchObject([{ taskId, plan: { version: 2 }, planDecision: { decision: 'APPROVED', version: 2 } }]);
    expect(write('src/app.ts').exitCode).toBe(0);
  });

  it('logs every decision without file contents', () => {
    const lines = fs.readFileSync(path.join(home, 'logs', 'gate-decisions.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(10);
    const raw = lines.join('\n');
    expect(raw).not.toContain('SECRET-CONTENT-MUST-NOT-BE-LOGGED');
    expect(JSON.parse(lines[0]!)).toMatchObject({ sessionId: 'test-session', toolName: 'Write', verdict: 'DENY' });
  });

  it('tells a new session which plan and scope are approved for its repository', () => {
    const result = runBridge('session-start', { session_id: 'test-session', cwd: path.join(repo, 'src'), hook_event_name: 'SessionStart', source: 'startup' }, env);
    expect(result.exitCode).toBe(0);
    const context: string = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain('GUARDED');
    expect(context).toContain(`${taskId} v2 (scope: src/**, test/**)`);
  });

  it('fails closed when Core is stopped, but keeps read-only commands working', async () => {
    await core.stop();
    const blocked = write('src/app.ts');
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain('core.unavailable');
    expect(bridge('Bash', { command: 'npm test' }).stderr).toContain('core.unavailable');
    expect(bridge('Bash', { command: 'git log --oneline' })).toMatchObject({ exitCode: 0, stdout: '' });

    const session = runBridge('session-start', { session_id: 's', cwd: repo, hook_event_name: 'SessionStart' }, env);
    expect(session.exitCode).toBe(0);
    expect(session.stdout).toContain('Core unavailable');
  });

  it('fails closed when Core hangs, within the bridge timeout', async () => {
    const hung = http.createServer(() => {
      /* never responds */
    });
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const address = hung.address() as { port: number };
    fs.writeFileSync(
      path.join(home, 'run', 'core.json'),
      JSON.stringify({ pid: process.pid, port: address.port, token: 'a'.repeat(64), startedAt: new Date().toISOString(), version: 'fake' }),
    );
    try {
      const result = write('src/app.ts');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('did not respond');
      expect(result.durationMs).toBeLessThan(7000);
    } finally {
      hung.closeAllConnections();
      hung.close();
      fs.rmSync(path.join(home, 'run', 'core.json'), { force: true });
    }
  });

  it('fails closed on malformed or unexpected hook input', () => {
    expect(runBridge('pre-tool-use', 'not json', env).exitCode).toBe(2);
    expect(runBridge('pre-tool-use', { hook_event_name: 'PreToolUse' }, env).exitCode).toBe(2);
    expect(runBridge('pre-tool-use', '', env).exitCode).toBe(2);
  });

  it('left the fixture repository byte-for-byte unchanged (zero footprint)', () => {
    expect(snapshotRepo(repo)).toEqual(before);
  });
});
