import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { autostartCore, isProcessAlive, jerryPaths, readCoreHeartbeat, readCoreRuntimeInfo, requestCore, spawnDetachedCore } from '@jerry/platform';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CORE, ROOT, createFixtureRepo, preToolUse, runBridge, startCore, tempDir, type RunningCore } from '../helpers/harness.js';

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor<T>(probe: () => T | null, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Stops a Core that the test did not spawn itself (an autostarted one) through its API. */
async function shutdownCoreOf(home: string): Promise<void> {
  try {
    const info = readCoreRuntimeInfo(home);
    await requestCore(info, { method: 'POST', path: '/api/v1/shutdown', body: { requestedBy: 'tests', reason: 'test cleanup' }, timeoutMs: 2000 });
    await waitFor(() => (isProcessAlive(info.pid) ? null : true));
  } catch {
    // not running
  }
}

function installRuntimeCopy(home: string): void {
  const runtimeCore = jerryPaths(home).runtimeCoreFile;
  fs.mkdirSync(path.dirname(runtimeCore), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist', 'core', 'core.mjs'), runtimeCore);
}

describe('Core lifecycle: port, single instance, autostart', () => {
  const base = tempDir('lifecycle');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const homes: string[] = [];
  const running: RunningCore[] = [];
  const newHome = (): string => {
    const home = path.join(base, `home-${homes.length}`);
    homes.push(home);
    return home;
  };

  afterEach(async () => {
    for (const core of running.splice(0)) await core.stop();
    for (const home of homes) await shutdownCoreOf(home);
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('listens on the configured fixed port', async () => {
    const port = await freePort();
    const core = await startCore(newHome(), { JERRY_CORE_PORT: String(port) });
    running.push(core);
    expect(core.info).toMatchObject({ port, configuredPort: port });
  });

  it('falls back to a random port when another program holds the configured one', async () => {
    const occupant = http.createServer();
    await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', resolve));
    const { port } = occupant.address() as { port: number };
    try {
      const core = await startCore(newHome(), { JERRY_CORE_PORT: String(port) });
      running.push(core);
      expect(core.info.configuredPort).toBe(port);
      expect(core.info.port).not.toBe(port);
    } finally {
      occupant.close();
    }
  });

  it('runs one Core per JERRY_HOME: a second start exits and leaves the first in place', async () => {
    const home = newHome();
    const first = await startCore(home);
    running.push(first);
    const second = spawnSync(process.execPath, [CORE], { env: { ...process.env, JERRY_HOME: home, JERRY_CORE_PORT: '0' }, encoding: 'utf8', timeout: 10_000 });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already running');
    expect(readCoreRuntimeInfo(home).pid).toBe(first.info.pid);
  });

  it('takes over a stale lock left by a crashed Core', async () => {
    const home = newHome();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
    fs.writeFileSync(jerryPaths(home).coreLockFile, dead.stdout);
    const core = await startCore(home);
    running.push(core);
    expect(fs.readFileSync(jerryPaths(home).coreLockFile, 'utf8')).toBe(String(core.info.pid));
  });

  it('SessionStart starts the installed Core and registers the session', async () => {
    const home = newHome();
    // The repository is a project of this home (Core wrote projects.json); then Core is down.
    await (await startCore(home)).stop();
    fs.rmSync(jerryPaths(home).coreInfoFile, { force: true });
    installRuntimeCopy(home);
    const result = runBridge('session-start', { session_id: 'autostart-session', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }, { JERRY_HOME: home });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('JERRY: monitoring this session');
    const info = readCoreRuntimeInfo(home);
    expect(isProcessAlive(info.pid)).toBe(true);
    // Started from JERRY_HOME, never from the session's repository.
    expect(fs.readFileSync(path.join(home, 'logs', 'core.log'), 'utf8')).toContain('listening on 127.0.0.1');
  });

  it('PreToolUse starts Core in the background without making the tool call wait', async () => {
    const home = newHome();
    installRuntimeCopy(home);
    const result = runBridge('pre-tool-use', preToolUse(repo, 'Write', { file_path: path.join(repo, 'src', 'app.ts') }), { JERRY_HOME: home });
    expect(result).toMatchObject({ exitCode: 0, stdout: '' });
    expect(result.durationMs).toBeLessThan(3000);
    const info = await waitFor(() => (fs.existsSync(jerryPaths(home).coreInfoFile) ? readCoreRuntimeInfo(home) : null));
    expect(isProcessAlive(info.pid)).toBe(true);
  });

  it('throttles repeated automatic starts', () => {
    const home = newHome();
    installRuntimeCopy(home);
    fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
    fs.writeFileSync(jerryPaths(home).autostartStampFile, String(Date.now()));
    expect(autostartCore(home)).toBe('throttled');
  });

  it('does not restart Core after the user stopped it', () => {
    const home = newHome();
    installRuntimeCopy(home);
    fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
    fs.writeFileSync(jerryPaths(home).autostartDisabledFile, new Date().toISOString());
    const result = runBridge('session-start', { session_id: 's', cwd: repo, hook_event_name: 'SessionStart' }, { JERRY_HOME: home });
    expect(result.stdout).toContain('Core unavailable');
    expect(fs.existsSync(jerryPaths(home).coreInfoFile)).toBe(false);
  });

  it('does not start anything without an installed runtime (development sessions)', () => {
    const home = newHome();
    expect(autostartCore(home)).toBe('unavailable');
  });
});

describe('Core diagnostics in core.log', () => {
  const base = tempDir('diagnostics');
  const homes: string[] = [];
  const newHome = (): string => {
    const home = path.join(base, `home-${homes.length}`);
    homes.push(home);
    return home;
  };
  const coreLog = (home: string): string => fs.readFileSync(jerryPaths(home).coreLogFile, 'utf8');
  /** Starts Core the way hooks and the CLI do: detached, output appended to core.log. */
  const spawnLogged = async (home: string, startedBy: string) => {
    spawnDetachedCore(home, CORE, { ...process.env, JERRY_CORE_PORT: '0' }, startedBy);
    return waitFor(() => (fs.existsSync(jerryPaths(home).coreInfoFile) ? readCoreRuntimeInfo(home) : null));
  };
  const stopWith = async (home: string, body: unknown) => {
    const info = readCoreRuntimeInfo(home);
    const answer = await requestCore(info, { method: 'POST', path: '/api/v1/shutdown', body, timeoutMs: 2000 });
    await waitFor(() => (isProcessAlive(info.pid) ? null : true));
    return { info, answer };
  };

  afterEach(async () => {
    for (const home of homes) await shutdownCoreOf(home);
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('timestamps every line and names who started and who stopped Core, then the exit code', async () => {
    const home = newHome();
    const info = await spawnLogged(home, 'integration test');
    // The heartbeat names this Core while it runs.
    expect(readCoreHeartbeat(jerryPaths(home).coreAliveFile)).toMatchObject({ pid: info.pid });
    await stopWith(home, { requestedBy: 'tests', reason: 'diagnostics test' });
    const lines = coreLog(home).trimEnd().split('\n');
    for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    const order = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(order(`starting JERRY Core (integration test, from pid ${process.pid})`)).toBe(0);
    expect(order('listening on 127.0.0.1')).toBeGreaterThan(0);
    expect(order('JERRY Core stopping: shutdown requested via API by tests: diagnostics test')).toBeGreaterThan(order('listening on'));
    expect(lines.at(-1)).toContain('JERRY Core exited with code 0');
    // A clean stop removes the heartbeat.
    expect(fs.existsSync(jerryPaths(home).coreAliveFile)).toBe(false);
  });

  it('still stops on an empty request from an older client, and refuses a malformed one', async () => {
    const home = newHome();
    const info = await spawnLogged(home, 'integration test');
    await expect(requestCore(info, { method: 'POST', path: '/api/v1/shutdown', body: { requestedBy: 'someone' }, timeoutMs: 2000 })).rejects.toThrow(/400/);
    expect(isProcessAlive(info.pid)).toBe(true);
    await stopWith(home, {});
    expect(coreLog(home)).toContain('shutdown requested via API (requester not given)');
  });

  it('reports at the next start a Core that ended without a clean stop, with when it was last seen', async () => {
    const home = newHome();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const lastSeen = '2026-11-10T09:58:00.000Z';
    fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
    fs.writeFileSync(jerryPaths(home).coreAliveFile, JSON.stringify({ pid: Number(dead.stdout), version: '0.1.0', startedAt: '2026-11-10T08:00:00.000Z', aliveAt: lastSeen }));
    await spawnLogged(home, 'integration test');
    expect(coreLog(home)).toContain(`the previous JERRY Core (pid ${dead.stdout}, 0.1.0, started 2026-11-10T08:00:00.000Z, last seen alive ${lastSeen}) ended without a clean stop`);
    // After a clean stop the next start has nothing to report.
    await stopWith(home, { requestedBy: 'tests' });
    await spawnLogged(home, 'integration test');
    expect(coreLog(home).split('ended without a clean stop')).toHaveLength(2);
  });
});
