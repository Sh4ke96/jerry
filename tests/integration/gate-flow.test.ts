import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, preToolUse, runBridge, snapshotRepo, startCore, tempDir, type BridgeResult, type RunningCore } from '../helpers/harness.js';

/**
 * The shipped bridge + Core monitor a real Git repository (warn, never
 * block edits), enforce the hard rules with or without Core, and never modify the repository.
 */
describe('JERRY guard (bundled bridge + Core)', () => {
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
  const sessionContext = (cwd = repo): string => {
    const result = runBridge('session-start', { session_id: 'test-session', cwd, hook_event_name: 'SessionStart', source: 'startup' }, env);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
  };

  function expectWarned(result: BridgeResult, ruleId: string): void {
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.systemMessage).toContain(ruleId);
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
    expect(output.hookSpecificOutput.additionalContext).toContain(ruleId);
    expect(output.hookSpecificOutput).not.toHaveProperty('permissionDecision');
  }
  /** A repeated warning: the user's line only; nothing goes into Claude's context. */
  function expectWarnedQuietly(result: BridgeResult, ruleId: string): void {
    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.systemMessage).toContain(ruleId);
    expect(output).not.toHaveProperty('hookSpecificOutput');
  }
  function expectPassed(result: BridgeResult): void {
    expect(result, result.stderr).toMatchObject({ exitCode: 0, stdout: '' });
  }
  function expectBlocked(result: BridgeResult, ruleId: string): void {
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(ruleId);
  }

  it('tells a new session that monitoring is on, there is no plan yet, and what the hard rules are', () => {
    const context = sessionContext();
    expect(context).toContain('it never blocks edits');
    expect(context).toContain('There is no approved JERRY plan');
    expect(context).toContain('the user does all Git operations manually');
    // No finished task yet: no history line.
    expect(context).not.toContain('get_history');
  });

  it('lets edits through without a plan, warns Claude once per session and the user every time', async () => {
    const deviations = async (): Promise<number> => ((await api(core, 'GET', '/api/v1/events?verdict=WARN&limit=100')).body as unknown[]).length;
    expectWarned(write('src/app.ts'), 'monitor.no-approved-plan');
    expectWarnedQuietly(bridge('Edit', { file_path: path.join(repo, 'src/app.ts'), old_string: 'a', new_string: 'b' }), 'monitor.no-approved-plan');
    expectWarnedQuietly(bridge('Bash', { command: 'npm install' }), 'monitor.no-approved-plan');
    expectWarnedQuietly(bridge('PowerShell', { command: 'Remove-Item -Recurse dist' }), 'monitor.no-approved-plan');
    // Every one is still a recorded deviation.
    expect(await deviations()).toBe(4);
    // Another session, and a subagent of this one, each get the warning once more.
    expectWarned(runBridge('pre-tool-use', { ...preToolUse(repo, 'Bash', { command: 'npm install' }), session_id: 'other-session' }, env), 'monitor.no-approved-plan');
    expectWarned(runBridge('pre-tool-use', { ...preToolUse(repo, 'Bash', { command: 'npm install' }), agent_id: 'agent-1', agent_type: 'general-purpose' }, env), 'monitor.no-approved-plan');
    expect(await deviations()).toBe(6);
  });

  it('passes read-only commands silently', () => {
    expectPassed(bridge('Bash', { command: 'git status --porcelain' }));
    expectPassed(bridge('PowerShell', { command: 'Get-ChildItem -Recurse' }));
  });

  it('blocks the hard rules: Git changes, .git writes, JERRY data, user-only commands', () => {
    expectBlocked(bridge('Bash', { command: 'git commit -am "wip"' }), 'hard.git-mutation');
    expectBlocked(bridge('PowerShell', { command: 'git push origin main' }), 'hard.git-mutation');
    expectBlocked(bridge('Bash', { command: 'npm run build && git add .' }), 'hard.git-mutation');
    expectBlocked(write('.git/config'), 'hard.git-metadata');
    expectBlocked(bridge('Write', { file_path: path.join(home, 'state', 'core-state.json') }), 'hard.protected-path');
    expectBlocked(bridge('Bash', { command: 'jerry approve JRY-0001 --stage plan --version 1' }), 'hard.user-only-command');
    expectBlocked(bridge('PowerShell', { command: 'Get-Content $env:LOCALAPPDATA\\JERRY\\run\\core.json' }), 'hard.protected-path');
    expectBlocked(bridge('mcp__github__push_files', { owner: 'o', repo: 'r', branch: 'main', files: [] }), 'hard.git-mutation');
    expectPassed(bridge('mcp__github__get_file_contents', { owner: 'o', repo: 'r', path: 'README.md' }));
  });

  let taskId: string;

  it('keeps warning while the plan is waiting for approval or rejected', async () => {
    const created = await api(core, 'POST', '/api/v1/tasks', { repoPath: path.join(repo, 'src'), title: 'Change answer', scope: ['src/**'] });
    expect(created.status).toBe(201);
    const task = created.body as { taskId: string; repoRoot: string };
    taskId = task.taskId;
    expect(path.resolve(task.repoRoot)).toBe(path.resolve(repo));
    expectWarnedQuietly(write('src/app.ts'), 'monitor.no-approved-plan');

    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'REJECTED', comment: 'not yet' })).status).toBe(201);
    expectWarnedQuietly(write('src/app.ts'), 'monitor.no-approved-plan');
  });

  it('after approval, is silent inside the scope and warns outside it; hard rules still apply', async () => {
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).status).toBe(201);

    // src/app.ts holds the user's uncommitted change (fixture): one warning, then silence.
    expectWarned(write('src/app.ts'), 'monitor.user-uncommitted-file');
    expectPassed(write('src/app.ts'));
    expectPassed(write('src/new/module.ts'));
    expectWarned(write('README.md'), 'monitor.out-of-scope');
    expectPassed(bridge('Bash', { command: 'npm test' }));
    expectBlocked(bridge('Bash', { command: 'git commit -m "done"' }), 'hard.git-mutation');
  });

  it('treats a revised plan as unapproved and refuses decisions on stale versions', async () => {
    const revised = await api(core, 'POST', `/api/v1/tasks/${taskId}/plan`, { scope: ['src/**', 'test/**'] });
    expect((revised.body as { plan: { version: number } }).plan.version).toBe(2);
    // The session worked under the approved plan since its last warning: losing it is told again, once.
    expectWarned(write('src/app.ts'), 'monitor.no-approved-plan');
    expectWarnedQuietly(write('src/app.ts'), 'monitor.no-approved-plan');
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).status).toBe(409);
  });

  it('stops monitoring a removed project but keeps enforcing the hard rules there', async () => {
    const removed = await api(core, 'POST', '/api/v1/projects/remove', { path: repo });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ removed: true, openTasks: [taskId], warning: expect.stringContaining(`${taskId} stay open`) });
    expectPassed(write('README.md'));
    expect(sessionContext()).toContain('this project is not added');
    expectBlocked(bridge('Bash', { command: 'git push' }), 'hard.git-mutation');
    expectBlocked(write('.git/HEAD'), 'hard.git-metadata');

    expect((await api(core, 'POST', '/api/v1/projects', { path: repo })).status).toBe(201);
    expectWarnedQuietly(write('README.md'), 'monitor.no-approved-plan');
    // The former exclusion switch is a synonym: excluding removes the project, including adds it.
    expect((await api(core, 'POST', '/api/v1/repositories/exclusions', { repoPath: repo, excluded: true })).status).toBe(200);
    expectPassed(write('README.md'));
    expect((await api(core, 'POST', '/api/v1/repositories/exclusions', { repoPath: repo, excluded: false })).status).toBe(200);
    expectWarnedQuietly(write('README.md'), 'monitor.no-approved-plan');
  });

  it('rejects API calls without the local token', async () => {
    expect((await api(core, 'GET', '/api/v1/tasks', undefined, 'f'.repeat(64))).status).toBe(401);
  });

  it('keeps task and approval state across a Core restart', async () => {
    await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 2, decision: 'APPROVED' });
    await core.stop();
    core = await startCore(home);
    const tasks = await api(core, 'GET', '/api/v1/tasks');
    expect(tasks.body).toMatchObject([{ taskId, plan: { version: 2 }, planDecision: { decision: 'APPROVED', version: 2 } }]);
    // The new approval took a new baseline; the user's change in src/app.ts is still uncommitted.
    expectWarned(write('src/app.ts'), 'monitor.user-uncommitted-file');
    expectPassed(write('src/app.ts'));
  });

  it('tells a new session which plan and scope are approved for its repository', () => {
    expect(sessionContext(path.join(repo, 'src'))).toContain(`${taskId} v2 (scope: src/**, test/**)`);
  });

  it('records warnings and blocked attempts as events without file contents', async () => {
    const response = await api(core, 'GET', '/api/v1/events?limit=500');
    const events = response.body as Array<{ eventType: string; verdict: string | null; ruleId: string | null }>;
    expect(JSON.stringify(events)).not.toContain('SECRET-CONTENT-MUST-NOT-BE-LOGGED');
    expect(events.some((event) => event.eventType === 'PreToolUse' && event.verdict === 'WARN' && event.ruleId === 'monitor.out-of-scope')).toBe(true);
    expect(events.some((event) => event.eventType === 'PreToolUse' && event.verdict === 'DENY' && event.ruleId === 'hard.git-mutation')).toBe(true);
    expect(fs.existsSync(path.join(home, 'logs', 'gate-decisions.jsonl'))).toBe(false);
  });

  it('when Core is stopped: edits proceed unrecorded, hard rules still block', async () => {
    await core.stop();
    expectPassed(write('src/app.ts'));
    expectPassed(bridge('Bash', { command: 'npm test' }));
    expectBlocked(bridge('Bash', { command: 'git push' }), 'hard.git-mutation');
    expectBlocked(write('.git/config'), 'hard.git-metadata');
    expectBlocked(bridge('mcp__gitlab__create_merge_request', {}), 'hard.git-mutation');
    const context = sessionContext();
    expect(context).toContain('Core unavailable');
    expect(context).toContain('the user does all Git operations manually');
  });

  it('when Core hangs: edits proceed within the timeout, hard rules still block', async () => {
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
      const edit = write('src/app.ts');
      expectPassed(edit);
      expect(edit.durationMs).toBeLessThan(5000);
      expectBlocked(bridge('Bash', { command: 'git commit -m x' }), 'hard.git-mutation');
    } finally {
      hung.closeAllConnections();
      hung.close();
      fs.rmSync(path.join(home, 'run', 'core.json'), { force: true });
    }
  });

  it('blocks when the hook input cannot be parsed, because the hard rules cannot be checked', () => {
    expect(runBridge('pre-tool-use', 'not json', env).exitCode).toBe(2);
    expect(runBridge('pre-tool-use', { hook_event_name: 'PreToolUse' }, env).exitCode).toBe(2);
    expect(runBridge('pre-tool-use', '', env).exitCode).toBe(2);
  });

  it('left the fixture repository byte-for-byte unchanged (zero footprint)', () => {
    expect(snapshotRepo(repo)).toEqual(before);
  });
});
