import fs from 'node:fs';
import path from 'node:path';
import type { StoredEvent } from '@jerry/contracts';
import { countSpooled, jerryPaths } from '@jerry/platform';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../apps/core/src/state-store.js';
import { api, createFixtureRepo, preToolUse, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';

const base = tempDir('events');
const repo = createFixtureRepo(path.join(base, 'repo'));
let homeCounter = 0;
const newHome = (): string => path.join(base, `home-${(homeCounter += 1)}`);
const running: RunningCore[] = [];

afterEach(async () => {
  for (const core of running.splice(0)) await core.stop();
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

async function start(home: string, env: Record<string, string> = {}): Promise<RunningCore> {
  const core = await startCore(home, env);
  running.push(core);
  return core;
}

async function events(core: RunningCore, query = ''): Promise<StoredEvent[]> {
  return (await api(core, 'GET', `/api/v1/events?limit=500${query}`)).body as StoredEvent[];
}

async function waitForEvents(core: RunningCore, predicate: (events: StoredEvent[]) => boolean): Promise<StoredEvent[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const current = await events(core);
    if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error(`events did not arrive: ${JSON.stringify(current.map((event) => event.eventType))}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const postToolUse = (sessionId: string) => ({
  session_id: sessionId,
  cwd: repo,
  hook_event_name: 'PostToolUse',
  tool_name: 'Write',
  tool_use_id: `toolu_${sessionId}`,
  tool_input: { file_path: path.join(repo, 'src', 'new.ts'), content: 'FILE-CONTENT-NEVER-STORED' },
  tool_response: { success: true },
});

describe('session events', () => {
  it('records telemetry events through the bridge, without contents, and never blocks', async () => {
    const home = newHome();
    const core = await start(home);
    const result = runBridge('event', postToolUse('live'), { JERRY_HOME: home });
    expect(result).toMatchObject({ exitCode: 0, stdout: '' });
    expect(runBridge('event', { session_id: 'live', cwd: repo, hook_event_name: 'UserPromptSubmit', prompt: 'my secret prompt text' }, { JERRY_HOME: home }).exitCode).toBe(0);

    const recorded = await events(core, '&sessionId=live');
    expect(recorded.map((event) => event.eventType).sort()).toEqual(['PostToolUse', 'UserPromptSubmit']);
    expect(recorded.find((event) => event.eventType === 'PostToolUse')).toMatchObject({ toolName: 'Write', spooled: false, payload: { input: { path: path.join(repo, 'src', 'new.ts') }, response: { success: true } } });
    expect(JSON.stringify(recorded)).not.toMatch(/FILE-CONTENT-NEVER-STORED|my secret prompt text/);
  });

  it('records SessionStart and every gate decision as events', async () => {
    const home = newHome();
    const core = await start(home);
    runBridge('session-start', { session_id: 'gate', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }, { JERRY_HOME: home });
    runBridge('pre-tool-use', preToolUse(repo, 'Write', { file_path: path.join(repo, 'README.md') }), { JERRY_HOME: home });
    runBridge('pre-tool-use', preToolUse(repo, 'Bash', { command: 'git push' }), { JERRY_HOME: home });
    const all = await events(core);
    expect(all.some((event) => event.eventType === 'SessionStart' && event.sessionId === 'gate')).toBe(true);
    expect(all.filter((event) => event.eventType === 'PreToolUse').map((event) => `${event.verdict}:${event.ruleId}`).sort()).toEqual([
      'DENY:hard.git-mutation',
      'WARN:monitor.no-approved-plan',
    ]);
  });

  it('spools events while Core is down and ingests them, evaluated against the plan, when it starts', async () => {
    const home = newHome();
    const env = { JERRY_HOME: home };
    // The repository is a project of this home; then Core goes down.
    await (await startCore(home)).stop();
    fs.rmSync(jerryPaths(home).coreInfoFile, { force: true });
    expect(runBridge('session-start', { session_id: 'outage', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }, env).exitCode).toBe(0);
    expect(runBridge('pre-tool-use', preToolUse(repo, 'Write', { file_path: path.join(repo, 'README.md') }), env)).toMatchObject({ exitCode: 0, stdout: '' });
    expect(runBridge('pre-tool-use', preToolUse(repo, 'Bash', { command: 'git commit -m x' }), env).exitCode).toBe(2);
    expect(runBridge('event', postToolUse('outage'), env).exitCode).toBe(0);
    expect(countSpooled(home)).toBe(4);

    const core = await start(home);
    const ingested = await waitForEvents(core, (current) => current.length >= 4);
    expect(countSpooled(home)).toBe(0);
    expect(ingested.every((event) => event.spooled)).toBe(true);
    const lateWrite = ingested.find((event) => event.eventType === 'PreToolUse' && event.toolName === 'Write');
    expect(lateWrite).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.no-approved-plan', payload: { evaluatedLate: true } });
    expect(ingested.find((event) => event.toolName === 'Bash')).toMatchObject({ verdict: 'DENY', ruleId: 'hard.git-mutation' });
    // The spooled SessionStart registered the session.
    expect((await api(core, 'GET', '/api/v1/status')).body).toMatchObject({ sessionCount: 1 });
  });

  it('stores a replayed event only once', async () => {
    const home = newHome();
    const core = await start(home);
    const event = { eventId: 'evt_fixed-id-0001', schemaVersion: 1, source: 'claude-code-hook', eventType: 'Stop', timestamp: new Date().toISOString(), sessionId: 's', agentId: null, agentType: null, cwd: repo, toolName: null, toolUseId: null, taskId: null, repoRoot: null, verdict: null, ruleId: null, payload: {}, redaction: { applied: false, reasons: [] }, pendingEvaluation: false };
    expect((await api(core, 'POST', '/api/v1/events', { events: [event] })).body).toMatchObject({ inserted: 1 });
    expect((await api(core, 'POST', '/api/v1/events', { events: [event] })).body).toMatchObject({ inserted: 0 });
    expect((await events(core)).filter((stored) => stored.eventId === 'evt_fixed-id-0001')).toHaveLength(1);
  });

  it('keeps nothing while the user has paused JERRY with "jerry core stop"', () => {
    const home = newHome();
    fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
    fs.writeFileSync(jerryPaths(home).autostartDisabledFile, 'x');
    expect(runBridge('event', postToolUse('paused'), { JERRY_HOME: home }).exitCode).toBe(0);
    expect(countSpooled(home)).toBe(0);
  });

  it('imports the pre-database gate log once', async () => {
    const home = newHome();
    const paths = jerryPaths(home);
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.writeFileSync(
      paths.gateLogFile,
      `${JSON.stringify({ at: '2026-11-06T10:00:00.000Z', sessionId: 'old', agentId: null, toolUseId: 't1', toolName: 'Write', cwd: repo, paths: ['a.ts'], verdict: 'WARN', ruleId: 'monitor.no-approved-plan', reason: 'r', taskId: null, repoRoot: repo })}\n`,
    );
    const core = await start(home);
    const imported = await waitForEvents(core, (current) => current.some((event) => event.sessionId === 'old'));
    expect(imported.find((event) => event.sessionId === 'old')).toMatchObject({ eventType: 'PreToolUse', verdict: 'WARN', payload: { importedFrom: 'gate-decisions.jsonl' } });
    expect(fs.existsSync(paths.gateLogFile)).toBe(false);
  });
});

describe('retention', () => {
  it('deletes events and sessions older than the retention period and keeps governance records', async () => {
    const dir = newHome();
    const store = await StateStore.open({ databaseFile: path.join(dir, 'jerry.sqlite'), backupsDir: path.join(dir, 'backups'), legacyStateFile: path.join(dir, 'none.json') });
    const now = new Date('2026-11-06T12:00:00.000Z');
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);
    const event = (id: string, daysAgo: number) => ({ eventId: id, schemaVersion: 1 as const, source: 'claude-code-hook' as const, eventType: 'Stop' as const, timestamp: at(daysAgo).toISOString(), sessionId: null, agentId: null, agentType: null, cwd: null, toolName: null, toolUseId: null, taskId: null, repoRoot: null, verdict: null, ruleId: null, payload: {}, redaction: { applied: false, reasons: [] }, pendingEvaluation: false });
    await store.recordEvents([event('evt_old_000001', 120), event('evt_new_000001', 10)], now, false);
    await store.registerSession({ sessionId: 'old-session', cwd: repo, source: null }, at(100));
    await store.registerSession({ sessionId: 'new-session', cwd: repo, source: null }, at(1));
    const task = await store.createTask({ repoRoot: repo, title: 'Kept', scope: ['**'] }, at(200));

    expect(await store.applyRetention(now, 90)).toEqual({ events: 1, sessions: 1, usage: 0 });
    expect((await store.listEvents({ limit: 10 })).map((stored) => stored.eventId)).toEqual(['evt_new_000001']);
    expect(store.snapshot().sessions.map((session) => session.sessionId)).toEqual(['new-session']);
    expect(store.snapshot().tasks.map((kept) => kept.taskId)).toEqual([task.taskId]);
    await store.close();
  });
});
