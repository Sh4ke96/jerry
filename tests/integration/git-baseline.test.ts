import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { StoredEvent, TaskDetail } from '@jerry/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, runBridge, snapshotRepo, startCore, tempDir, type RunningCore } from '../helpers/harness.js';
import { sampleReport } from '../helpers/report-fixture.js';

const IDENTITY = ['-c', 'user.name=JERRY Test', '-c', 'user.email=jerry-test@example.invalid', '-c', 'commit.gpgsign=false'];

/**
 * ADR 0017: Core takes read-only Git baselines, protects the user's uncommitted work, sees changes
 * made by shell commands, and tells a resumed session what moved since its checkpoint.
 */
describe('Git baseline, user changes and Git-based evidence (bundled bridge + Core)', () => {
  const base = tempDir('baseline');
  // src/app.ts carries the user's uncommitted change and notes.txt is untracked (fixture).
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') };
  let core: RunningCore;
  let taskId: string;

  beforeAll(async () => {
    core = await startCore(home);
  });
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const hook = (event: Record<string, unknown>) => ({ session_id: 'session-g', cwd: repo, transcript_path: 'C:/nowhere/t.jsonl', ...event });
  const write = (relative: string) => runBridge('pre-tool-use', hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, relative) }, tool_use_id: `toolu_${relative}` }), env);
  const detail = async (): Promise<TaskDetail> => (await api(core, 'GET', `/api/v1/tasks/${taskId}`)).body as TaskDetail;
  const gitBytes = () => Object.fromEntries(Object.entries(snapshotRepo(repo).files).filter(([file]) => file.startsWith('.git/')));

  it('records the user’s uncommitted files when the plan is approved, without touching .git', async () => {
    const created = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Greeting', scope: ['src/**'] })).body as { taskId: string };
    taskId = created.taskId;
    const before = gitBytes();
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).status).toBe(201);
    expect(gitBytes()).toEqual(before);

    const { baseline } = await detail();
    expect(baseline).toMatchObject({ branch: 'main', userFiles: ['notes.txt', 'src/app.ts'], truncated: false, error: null });
    expect(baseline?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('warns once when Claude edits a file with the user’s uncommitted changes', () => {
    const first = write('src/app.ts');
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain("had the user's uncommitted changes");
    expect(write('src/app.ts')).toMatchObject({ exitCode: 0, stdout: '' });
    expect(write('src/other.ts')).toMatchObject({ exitCode: 0, stdout: '' });
  });

  it('attributes hard-rule blocks to the repository, so repository views list them', async () => {
    expect(runBridge('pre-tool-use', hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'toolu_push' }), env).exitCode).toBe(2);
    const blocked = (await api(core, 'GET', `/api/v1/events?verdict=DENY&repoPath=${encodeURIComponent(repo)}`)).body as StoredEvent[];
    expect(blocked.map((event) => event.ruleId)).toContain('hard.git-mutation');
  });

  it('puts shell-made changes into the report evidence, and counts the user’s files only when they changed again', async () => {
    // As if a shell command or a generator did it: JERRY's hooks never saw these writes.
    fs.writeFileSync(path.join(repo, 'src', 'generated.ts'), 'export const generated = true;\n');
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const answer = 44; // changed again after the baseline\n');
    const report = await api(core, 'POST', `/api/v1/tasks/${taskId}/reports`, { report: sampleReport(['src/other.ts']) });
    expect(report.status).toBe(201);
    const { evidence } = report.body as { evidence: { git: { changed: string[]; userChanged: string[] } | null; unreportedEdits: string[] } };
    expect(evidence.git).toMatchObject({ changed: ['src/app.ts', 'src/generated.ts'], userChanged: ['src/app.ts'] });
    // notes.txt was the user's and did not change: it is not Claude's change.
    expect(evidence.git?.changed).not.toContain('notes.txt');
    expect(evidence.unreportedEdits).toEqual(['src/app.ts', 'src/generated.ts']);
  });

  it('refuses DONE when a shell command changed a file after the report', async () => {
    fs.writeFileSync(path.join(repo, 'src', 'generated.ts'), 'export const generated = false;\n');
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'APPROVED' })).status).toBe(201);
    const task = await detail();
    expect(task.state).toBe('FINAL_REPORT');
    expect(task.finalCheck?.conditions.find((condition) => condition.id === 'code.unchanged-since-report')).toMatchObject({ passed: false, detail: expect.stringContaining('src/generated.ts') });
  });

  it('tells a new session that HEAD moved and files changed since the checkpoint', async () => {
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/approvals`, { stage: 'IMPLEMENTATION', version: 1, decision: 'REJECTED', comment: 'again' })).status).toBe(201);
    expect((await api(core, 'POST', `/api/v1/tasks/${taskId}/checkpoints`, { summary: 'Generated module in place.', nextSteps: ['Report again'] })).status).toBe(201);
    // The user commits (their Git operation), then a new session starts.
    execFileSync('git', [...IDENTITY, '-C', repo, 'add', 'src/generated.ts']);
    execFileSync('git', [...IDENTITY, '-C', repo, 'commit', '-q', '-m', 'user commit']);
    const result = runBridge('session-start', hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'session-h' }), env);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toMatch(/Since then: HEAD moved from [0-9a-f]{7} to [0-9a-f]{7}, \d+ file\(s\) changed \(check git log and git diff first\)\./);
  });
});
