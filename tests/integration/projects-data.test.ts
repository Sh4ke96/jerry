import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_CATEGORIES, type DataUsage, type ForgetPreview, type ForgetResult, type PrunePreview, type PruneResult, type StoredEvent } from '@jerry/contracts';
import { listBackups } from '@jerry/database';
import { countSpooled, jerryPaths, readProjectsFile, writeProjectsFile } from '@jerry/platform';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { addProject, api, BRIDGE, createFixtureRepo, CORE, preToolUse, runBridge, startCore, tempDir, TEST_CORE_ENV, type RunningCore } from '../helpers/harness.js';
import { McpClient } from '../helpers/mcp-client.js';
import { samplePlan } from '../helpers/plan-fixture.js';

/**
 * JERRY monitors only the projects the user adds: elsewhere the hard rules still hold, but nothing
 * is recorded and Core is neither asked nor started. And the user can see what JERRY stores and
 * delete old data safely.
 */
const base = tempDir('projects');
const added = createFixtureRepo(path.join(base, 'added'));
const notAdded = createFixtureRepo(path.join(base, 'not-added'));
const running: RunningCore[] = [];
let homeCounter = 0;
const newHome = (): string => path.join(base, `home-${(homeCounter += 1)}`);

afterEach(async () => {
  for (const core of running.splice(0)) await core.stop();
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

async function start(home: string, projects: readonly string[]): Promise<RunningCore> {
  const core = await startCore(home, {}, { projects });
  running.push(core);
  return core;
}

async function events(core: RunningCore, query = ''): Promise<StoredEvent[]> {
  return (await api(core, 'GET', `/api/v1/events?limit=500${query}`)).body as StoredEvent[];
}

const env = (home: string): Record<string, string> => ({ JERRY_HOME: home, CLAUDE_CONFIG_DIR: path.join(base, '.claude') });
const write = (repo: string, sessionId: string) => ({ ...preToolUse(repo, 'Write', { file_path: path.join(repo, 'src', 'new.ts'), content: 'x' }), session_id: sessionId });
const commit = (repo: string, sessionId: string) => ({ ...preToolUse(repo, 'Bash', { command: 'git commit -am wip' }), session_id: sessionId });
const sessionStart = (repo: string, sessionId: string) => ({ session_id: sessionId, cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
const postToolUse = (repo: string, sessionId: string) => ({ session_id: sessionId, cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: `toolu_${sessionId}`, tool_input: { file_path: path.join(repo, 'src', 'new.ts') }, tool_response: { success: true } });

/** The bridge without blocking this process, so a stand-in Core in this process can answer it. */
function runBridgeAsync(event: 'pre-tool-use' | 'event', input: unknown, extraEnv: Record<string, string>): Promise<{ exitCode: number; stderr: string; durationMs: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, event], { env: { ...process.env, ...TEST_CORE_ENV, ...extraEnv }, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stderr, durationMs: performance.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

const HARD_RULES_START = 'Hard rules, always enforced: you may not run any Git command that changes anything';

describe('only projects are monitored', () => {
  it('outside a project: an edit passes and a Git commit is blocked, both without asking Core; Core is never started', async () => {
    // A stand-in Core that counts every request it gets.
    const home = newHome();
    let requests = 0;
    const fake = http.createServer((_request, response) => {
      requests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ verdict: 'PASS', ruleId: 'monitor.in-approved-scope', reason: 'fake', taskId: null, repoRoot: null }));
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = fake.address() as { port: number };
      fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
      fs.writeFileSync(jerryPaths(home).coreInfoFile, JSON.stringify({ pid: process.pid, port, token: 'b'.repeat(64), startedAt: new Date().toISOString(), version: 'fake' }));
      writeProjectsFile(home, [process.platform === 'win32' ? added.toUpperCase() : added]);

      const edit = await runBridgeAsync('pre-tool-use', write(notAdded, 'outside'), env(home));
      expect(edit.exitCode).toBe(0);
      const blocked = await runBridgeAsync('pre-tool-use', commit(notAdded, 'outside'), env(home));
      expect(blocked.exitCode).toBe(2);
      expect(blocked.stderr).toContain('hard.git-mutation');
      expect((await runBridgeAsync('event', postToolUse(notAdded, 'outside'), env(home))).exitCode).toBe(0);
      expect(requests).toBe(0);
      // An edit whose target lies in a project counts as inside, wherever the session runs.
      expect((await runBridgeAsync('pre-tool-use', { ...write(added, 'inside'), cwd: notAdded }, env(home))).exitCode).toBe(0);
      expect(requests).toBe(1);
      // Inside a project (any case on Windows) Core is asked as before.
      await runBridgeAsync('pre-tool-use', write(added, 'inside'), env(home));
      expect(requests).toBe(2);
      console.log(`bridge outside a project: edit ${edit.durationMs.toFixed(0)} ms, blocked commit ${blocked.durationMs.toFixed(0)} ms`);
    } finally {
      fake.close();
    }

    // With Core installed but down, nothing outside a project starts it, and nothing is spooled.
    const quiet = newHome();
    fs.mkdirSync(path.join(quiet, 'runtime', 'core'), { recursive: true });
    fs.copyFileSync(CORE, path.join(quiet, 'runtime', 'core', 'core.mjs'));
    writeProjectsFile(quiet, [added]);
    expect(runBridge('pre-tool-use', write(notAdded, 'quiet'), env(quiet)).exitCode).toBe(0);
    expect(runBridge('pre-tool-use', commit(notAdded, 'quiet'), env(quiet)).exitCode).toBe(2);
    expect(runBridge('session-start', sessionStart(notAdded, 'quiet'), env(quiet)).exitCode).toBe(0);
    expect(runBridge('event', postToolUse(notAdded, 'quiet'), env(quiet)).exitCode).toBe(0);
    expect(fs.existsSync(jerryPaths(quiet).coreInfoFile)).toBe(false);
    expect(fs.existsSync(jerryPaths(quiet).autostartStampFile)).toBe(false);
    expect(countSpooled(quiet)).toBe(0);
  });

  it('tells a session outside a project exactly one line, then the unchanged hard rules', () => {
    const home = newHome();
    writeProjectsFile(home, [added]);
    const result = runBridge('session-start', sessionStart(path.join(notAdded, 'src'), 'outside-start'), env(home));
    expect(result.exitCode).toBe(0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    const lines = context.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('🛡️ JERRY: this project is not added; only hard rules apply. The user can add it with jerry project add.');
    expect(lines[1]!.startsWith(HARD_RULES_START)).toBe(true);
    expect(lines[1]).toContain('or call the JERRY API or dashboard.');
  });

  it('a path that only shares a prefix with a project is not inside it', () => {
    const home = newHome();
    const sibling = createFixtureRepo(`${added}-sibling`);
    writeProjectsFile(home, [added]);
    const context = JSON.parse(runBridge('session-start', sessionStart(sibling, 'sibling'), env(home)).stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain('this project is not added');
  });

  it('records nothing from a repository that is not added, and monitors it once added', async () => {
    const home = newHome();
    const core = await start(home, [added]);
    expect(readProjectsFile(home)).toEqual([added]);

    runBridge('session-start', sessionStart(notAdded, 'later'), env(home));
    expect(runBridge('pre-tool-use', write(notAdded, 'later'), env(home))).toMatchObject({ exitCode: 0, stdout: '' });
    expect(runBridge('pre-tool-use', commit(notAdded, 'later'), env(home)).exitCode).toBe(2);
    runBridge('event', postToolUse(notAdded, 'later'), env(home));
    expect(await events(core, '&sessionId=later')).toEqual([]);
    expect((await api(core, 'GET', '/api/v1/status')).body).toMatchObject({ sessionCount: 0 });

    // Core refuses the same on its own, for any caller.
    const gate = await api(core, 'POST', '/api/v1/gate/check', { sessionId: 'direct', cwd: notAdded, toolName: 'Write', toolInput: { file_path: path.join(notAdded, 'a.ts') }, toolUseId: null, agentId: null });
    expect(gate.body).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.not-a-project' });
    const denied = await api(core, 'POST', '/api/v1/gate/check', { sessionId: 'direct', cwd: notAdded, toolName: 'Bash', toolInput: { command: 'git push' }, toolUseId: null, agentId: null });
    expect(denied.body).toMatchObject({ verdict: 'DENY', ruleId: 'hard.git-mutation' });
    const event = { eventId: 'evt_outside-000001', schemaVersion: 1, source: 'claude-code-hook', eventType: 'Stop', timestamp: new Date().toISOString(), sessionId: 'direct', agentId: null, agentType: null, cwd: notAdded, toolName: null, toolUseId: null, taskId: null, repoRoot: null, verdict: null, ruleId: null, payload: {}, redaction: { applied: false, reasons: [] }, pendingEvaluation: false };
    expect((await api(core, 'POST', '/api/v1/events', { events: [event] })).body).toMatchObject({ accepted: 1, inserted: 0 });
    expect((await api(core, 'POST', '/api/v1/sessions', { sessionId: 'direct', cwd: notAdded, source: null })).body).toMatchObject({ excluded: true, monitored: false, approvedPlans: [], openTasks: [] });
    expect(await events(core, '&sessionId=direct')).toEqual([]);
    const refused = await api(core, 'POST', '/api/v1/tasks', { repoPath: notAdded, title: 'Nope', scope: ['src/**'] });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain('jerry project add');
    expect((await api(core, 'GET', `/api/v1/repositories/state?path=${encodeURIComponent(notAdded)}`)).body).toMatchObject({ monitored: false, excluded: true });

    // Added: monitored from the next tool call on.
    expect((await api(core, 'POST', '/api/v1/projects', { path: notAdded })).body).toMatchObject({ added: true, project: { repoRoot: notAdded, addedBy: 'cli' } });
    expect(readProjectsFile(home)?.sort()).toEqual([added, notAdded].sort());
    const warned = runBridge('pre-tool-use', write(notAdded, 'later'), env(home));
    expect(JSON.parse(warned.stdout).systemMessage).toContain('monitor.no-approved-plan');
    expect((await events(core, '&sessionId=later')).map((stored) => stored.ruleId)).toEqual(['monitor.no-approved-plan']);
    expect((await api(core, 'GET', `/api/v1/repositories/state?path=${encodeURIComponent(notAdded)}`)).body).toMatchObject({ monitored: true, excluded: false });
    // Adding it again changes nothing.
    expect((await api(core, 'POST', '/api/v1/projects', { path: notAdded })).body).toMatchObject({ added: false });
  });

  it('adds only Git repository roots outside JERRY_HOME, and lists projects with their tasks', async () => {
    const home = newHome();
    const core = await start(home, []);
    expect((await api(core, 'POST', '/api/v1/projects', { path: path.join(added, 'src') })).status).toBe(400);
    expect((await api(core, 'POST', '/api/v1/projects', { path: base })).status).toBe(400);
    expect((await api(core, 'POST', '/api/v1/projects', { path: path.join(base, 'missing') })).status).toBe(400);
    const inHome = path.join(home, 'logs', 'repo');
    fs.mkdirSync(path.join(inHome, '.git'), { recursive: true });
    const refused = await api(core, 'POST', '/api/v1/projects', { path: inHome });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toContain("JERRY's data directory");

    await addProject(core, added);
    const created = (await api(core, 'POST', '/api/v1/tasks', { repoPath: added, title: 'Open work', scope: ['src/**'] })).body as { taskId: string };
    const listed = (await api(core, 'GET', '/api/v1/projects')).body as Array<Record<string, unknown>>;
    expect(listed).toEqual([{ repoRoot: added, addedAt: expect.any(String), addedBy: 'cli', note: null, reviewMode: null, effectiveReviewMode: 'optional', tasks: 1, openTasks: 1, lastActivityAt: expect.any(String), exists: true }]);

    // Removing a project keeps its open tasks, and says so.
    const removed = await api(core, 'POST', '/api/v1/projects/remove', { path: added });
    expect(removed.body).toMatchObject({ repoRoot: added, removed: true, openTasks: [created.taskId], warning: expect.stringContaining('no longer monitors') });
    expect((await api(core, 'GET', '/api/v1/tasks')).body).toMatchObject([{ taskId: created.taskId }]);
    expect(readProjectsFile(home)).toEqual([]);
    expect((await api(core, 'POST', '/api/v1/projects/remove', { path: added })).status).toBe(404);
  });

  it('MCP: get_state says the project is not added; submit_plan and start_task refuse there', async () => {
    const home = newHome();
    await start(home, [added]);
    const mcp = await McpClient.connect({ ...env(home), CLAUDE_PROJECT_DIR: notAdded });
    try {
      const state = await mcp.call('get_state');
      expect(state.isError).toBe(false);
      expect(state.summary).toMatch(/^ℹ️ This project is not added to JERRY · only hard rules apply · .*jerry project add/);
      expect(state.structured).toMatchObject({ monitored: false, approved: [], open: [], currentTask: null, next: { action: 'none' } });
      const plan = await mcp.call('submit_plan', { title: 'Not here', plan: samplePlan(notAdded) });
      expect(plan.isError).toBe(true);
      expect(plan.text).toContain('jerry project add');
      const intake = await mcp.call('start_task', { title: 'Not here', goal: 'g', focus: ['src/**'] });
      expect(intake.isError).toBe(true);
      expect(intake.text).toContain('jerry project add');
      expect((await mcp.call('get_state', { path: added })).summary).toMatch(/^🛡️ GUARDED/);
    } finally {
      mcp.close();
    }
  });
});

// --- Data ---------------------------------------------------------------------------------------

function openDatabase(home: string): DatabaseSync {
  return new DatabaseSync(jerryPaths(home).databaseFile, { readOnly: true });
}

/** Every text value in every table, with its table and column. */
function everyText(home: string): Array<{ table: string; column: string; value: string }> {
  const db = openDatabase(home);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
    const found: Array<{ table: string; column: string; value: string }> = [];
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>) {
        for (const [column, value] of Object.entries(row)) if (typeof value === 'string') found.push({ table, column, value });
      }
    }
    return found;
  } finally {
    db.close();
  }
}

function rowsWithTask(home: string, taskId: string): string[] {
  const db = openDatabase(home);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
    return tables.filter((table) => {
      const columns = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((column) => column.name);
      return (columns.includes('task_id') && db.prepare(`SELECT 1 FROM "${table}" WHERE task_id = ?`).get(taskId) !== undefined) || (table === 'audit_log' && db.prepare('SELECT 1 FROM audit_log WHERE subject = ?').get(taskId) !== undefined);
    });
  } finally {
    db.close();
  }
}

const normalized = (value: string): string => value.replaceAll('\\\\', '/').replaceAll('\\', '/').toLowerCase();

const evalRun = (startedAt: string) => ({
  startedAt,
  finishedAt: startedAt,
  jerryVersion: '0.0.0-test',
  fingerprint: { total: 't', components: { skills: 's', agents: 'a', hooks: 'h', rules: 'r' } },
  label: 'test',
  results: [{ caseId: 'case-a', suite: 'regression', kind: 'safety', critical: false, outcome: 'PASS', attempts: [{ attempt: 1, outcome: 'PASS', harnessError: null, durationMs: 1, costUsd: null, sessionId: null, output: '', graders: [] }] }],
});

describe('what JERRY stores, and deleting old data', () => {
  /** A task with a plan, an approval, a Git baseline, a checkpoint and session links, then cancelled. */
  async function finishedTask(core: RunningCore, home: string, repo: string, sessionId: string): Promise<string> {
    runBridge('session-start', sessionStart(repo, sessionId), env(home));
    const task = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Finished work', scope: ['src/**'] })).body as { taskId: string };
    expect((await api(core, 'POST', `/api/v1/tasks/${task.taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' })).status).toBe(201);
    runBridge('pre-tool-use', write(repo, sessionId), env(home));
    expect((await api(core, 'POST', `/api/v1/tasks/${task.taskId}/checkpoints`, { summary: 'halfway', nextSteps: ['finish'], origin: { sessionId } })).status).toBe(201);
    expect((await api(core, 'POST', `/api/v1/tasks/${task.taskId}/transitions`, { event: 'task.cancelled', reason: 'test' })).status).toBe(201);
    return task.taskId;
  }

  it('shows usage per kind of data, per repository, with backups and logs', async () => {
    const home = newHome();
    const core = await start(home, [added]);
    await finishedTask(core, home, added, 'usage');
    await api(core, 'POST', '/api/v1/database/backups', {});
    const usage = (await api(core, 'GET', '/api/v1/data/usage')).body as DataUsage;
    expect(usage.categories.map((category) => category.category)).toEqual([...DATA_CATEGORIES]);
    const tasks = usage.categories.find((category) => category.category === 'tasks')!;
    expect(tasks.tables.find((table) => table.table === 'tasks')).toMatchObject({ rows: 1 });
    expect(tasks.bytes).toBeGreaterThan(0);
    expect(usage.categories.find((category) => category.category === 'events')!.rows).toBeGreaterThan(0);
    expect(usage.database.bytes).toBeGreaterThan(0);
    // Table pages cannot add up to more than the database file holds.
    expect(usage.categories.reduce((sum, category) => sum + category.bytes, 0)).toBeLessThanOrEqual(usage.database.bytes);
    expect(usage.backups).toMatchObject({ count: listBackups(jerryPaths(home).backupsDir).length, dir: jerryPaths(home).backupsDir });
    expect(usage.backups.count).toBe(1);
    expect(usage.totalBytes).toBe(usage.database.bytes + usage.backups.bytes + usage.logs.bytes);
    expect(usage.retentionDays).toBe(90);
    expect(usage.projects).toEqual([{ repoRoot: added, project: true, tasks: 1, openTasks: 0, events: expect.any(Number), lastActivityAt: expect.any(String) }]);
    expect(usage.projects[0]!.events).toBeGreaterThan(0);
  });

  it('prunes exactly what the preview showed, after a backup, and keeps open tasks and eval baselines', async () => {
    const home = newHome();
    const core = await start(home, [added]);
    const finished = await finishedTask(core, home, added, 'prune');
    const open = (await api(core, 'POST', '/api/v1/tasks', { repoPath: added, title: 'Still open', scope: ['src/**'] })).body as { taskId: string };
    const old = new Date(Date.now() - 60_000).toISOString();
    for (let index = 0; index < 3; index += 1) expect((await api(core, 'POST', '/api/v1/evals/runs', evalRun(old))).status).toBe(201);
    expect((await api(core, 'POST', '/api/v1/evals/baseline', { runId: 'EVR-1', note: 'kept' })).status).toBe(200);
    for (let index = 0; index < 3; index += 1) await api(core, 'POST', '/api/v1/database/backups', {});
    const backupsBefore = listBackups(jerryPaths(home).backupsDir);
    expect(backupsBefore).toHaveLength(3);

    // Nothing is deleted without saying what.
    expect((await api(core, 'POST', '/api/v1/data/prune/preview', {})).status).toBe(400);
    expect((await api(core, 'POST', '/api/v1/data/prune', {})).status).toBe(400);
    expect((await api(core, 'POST', '/api/v1/data/prune', { doneOlderThanDays: -1 })).status).toBe(400);

    const options = { doneOlderThanDays: 0, eventsOlderThanDays: 0, evalsOlderThanDays: 0, backupsKeep: 1 };
    const preview = (await api(core, 'POST', '/api/v1/data/prune/preview', options)).body as PrunePreview;
    expect(preview.tasks).toEqual([finished]);
    expect(preview.rows).toMatchObject({ tasks: 1, plans: 1, approvals: 1, workflow_transitions: expect.any(Number), task_checkpoints: 1, git_snapshots: expect.any(Number), session_tasks: expect.any(Number), eval_runs: 2 });
    expect(preview.rows['hook_events']).toBeGreaterThan(0);
    expect(preview.backups).toMatchObject({ count: 2, files: backupsBefore.slice(0, 2).map((backup) => backup.file).reverse() });
    // The preview deleted nothing.
    expect(rowsWithTask(home, finished)).not.toEqual([]);

    const result = (await api(core, 'POST', '/api/v1/data/prune', options)).body as PruneResult;
    expect(result.rows).toEqual(preview.rows);
    expect(result.totalRows).toBe(preview.totalRows);
    expect(result.tasks).toEqual(preview.tasks);
    expect(result.backups).toEqual(preview.backups);
    expect(path.basename(result.backupFile)).toMatch(/-pre-prune\.sqlite$/);
    expect(fs.existsSync(result.backupFile)).toBe(true);
    // The newest older backup and the one taken before the prune remain.
    expect(listBackups(jerryPaths(home).backupsDir).map((backup) => backup.file).sort()).toEqual([backupsBefore[2]!.file, result.backupFile].sort());

    // Nothing of the finished task is left in any table; the open task and the baseline run are.
    expect(rowsWithTask(home, finished)).toEqual([]);
    expect(((await api(core, 'GET', '/api/v1/tasks')).body as Array<{ taskId: string }>).map((task) => task.taskId)).toEqual([open.taskId]);
    expect(((await api(core, 'GET', '/api/v1/evals/runs')).body as Array<{ runId: string; isBaseline: boolean }>).map((run) => run.runId)).toEqual(['EVR-1']);
    expect(await events(core)).toEqual([]);
    const db = openDatabase(home);
    try {
      expect(db.prepare("SELECT action, subject FROM audit_log WHERE action = 'data.prune'").all()).toEqual([{ action: 'data.prune', subject: null }]);
    } finally {
      db.close();
    }
    // The backup holds the data as it was before.
    const backup = new DatabaseSync(result.backupFile, { readOnly: true });
    try {
      expect(backup.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(finished)).toEqual({ task_id: finished });
    } finally {
      backup.close();
    }
  });

  it('forgets everything about a repository, refuses while it has open tasks', async () => {
    const home = newHome();
    const core = await start(home, [added, notAdded]);
    const kept = await finishedTask(core, home, added, 'kept-session');
    const forgotten = await finishedTask(core, home, notAdded, 'forgotten-session');
    const open = (await api(core, 'POST', '/api/v1/tasks', { repoPath: notAdded, title: 'Still open', scope: ['src/**'] })).body as { taskId: string };
    await api(core, 'GET', `/api/v1/repositories/profile?path=${encodeURIComponent(notAdded)}`);

    const blocked = (await api(core, 'POST', '/api/v1/data/forget/preview', { path: notAdded })).body as ForgetPreview;
    expect(blocked).toMatchObject({ repoRoot: notAdded, project: true, openTasks: [open.taskId] });
    const refused = await api(core, 'POST', '/api/v1/data/forget', { path: notAdded });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain(open.taskId);
    expect(everyText(home).some((entry) => normalized(entry.value).includes(normalized(notAdded)))).toBe(true);

    expect((await api(core, 'POST', `/api/v1/tasks/${open.taskId}/transitions`, { event: 'task.cancelled', reason: 'test' })).status).toBe(201);
    const preview = (await api(core, 'POST', '/api/v1/data/forget/preview', { path: path.join(notAdded, 'src') })).body as ForgetPreview;
    expect(preview).toMatchObject({ repoRoot: notAdded, project: true, tasks: [forgotten, open.taskId], openTasks: [] });
    const result = (await api(core, 'POST', '/api/v1/data/forget', { path: notAdded })).body as ForgetResult;
    expect(result.rows).toEqual(preview.rows);
    expect(result.rows).toMatchObject({ tasks: 2, projects: 1, repositories: 1, sessions: 1 });
    expect(fs.existsSync(result.backupFile)).toBe(true);

    // No row of any table names the repository or its tasks.
    const leftovers = everyText(home).filter((entry) => normalized(entry.value).includes(normalized(notAdded)) || entry.value.includes(forgotten) || entry.value.includes(open.taskId));
    expect(leftovers).toEqual([]);
    // The other repository is untouched; the forgotten one is no longer a project.
    expect(((await api(core, 'GET', '/api/v1/tasks')).body as Array<{ taskId: string }>).map((task) => task.taskId)).toEqual([kept]);
    expect(rowsWithTask(home, kept).length).toBeGreaterThan(3);
    expect(readProjectsFile(home)).toEqual([added]);
    expect(runBridge('pre-tool-use', write(notAdded, 'after-forget'), env(home))).toMatchObject({ exitCode: 0, stdout: '' });
    expect(await events(core, '&sessionId=after-forget')).toEqual([]);
  });

  it('starts with an existing database: projects.json is written at start', async () => {
    const home = newHome();
    const first = await start(home, [added]);
    await first.stop();
    fs.rmSync(jerryPaths(home).projectsFile, { force: true });
    await start(home, []);
    expect(readProjectsFile(home)).toEqual([added]);
  });
});
