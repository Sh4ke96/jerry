import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { jerryPaths, readStatuslineConfig, writeProjectsFile, writeStatuslineConfig } from '@jerry/platform';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStatusline, isJerryStatusLine, removeStatusline } from '../../apps/cli/src/statusline-commands.js';
import { ROOT, tempDir, TEST_CORE_ENV } from '../helpers/harness.js';

const SCRIPT = path.join(ROOT, 'dist', 'plugin', 'statusline', 'statusline.mjs');
const CLI = path.join(ROOT, 'dist', 'cli', 'jerry.mjs');
const base = tempDir('statusline');
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;
function freshDir(name: string): string {
  counter += 1;
  const dir = path.join(base, `${name}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A documented status-line payload (Max plan, after the first response). */
function payload(cwd: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: path.join(cwd, 'never-read.jsonl'),
    cwd,
    version: '2.1.90',
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    workspace: { current_dir: cwd, project_dir: cwd },
    cost: { total_cost_usd: 1.2 },
    context_window: { total_input_tokens: 100, total_output_tokens: 50, used_percentage: 10 },
    rate_limits: { five_hour: { used_percentage: 23, resets_at: 1_794_009_600 }, seven_day: { used_percentage: 41, resets_at: 1_794_441_600 } },
    ...overrides,
  });
}

/** Runs the built script the way Claude Code does: JSON on stdin, one status line on stdout. */
function scriptEnv(home: string, extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...TEST_CORE_ENV, JERRY_HOME: home, CLAUDE_CODE_ENTRYPOINT: 'cli', ...extraEnv };
  delete env['JERRY_STATUSLINE_CHAINED'];
  if (extraEnv['JERRY_NO_EMOJI'] === undefined) delete env['JERRY_NO_EMOJI'];
  return env;
}

function runScript(home: string, input: string, extraEnv: Record<string, string> = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [SCRIPT], { input, env: scriptEnv(home, extraEnv), encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, ms: performance.now() - started };
}

/** Like runScript, without blocking this process: the fake Core below runs in it. */
function runScriptAsync(home: string, input: string): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env: scriptEnv(home, {}), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout }));
    child.stdin.end(input);
  });
}

function readLast(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(jerryPaths(home).statuslineLastFile, 'utf8')) as Record<string, unknown>;
}

function spooled(home: string): Array<Record<string, unknown>> {
  const file = jerryPaths(home).usageSpoolFile;
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface FakeCore {
  requests: Array<{ method: string; url: string; authorization: string | undefined; body: unknown }>;
  close(): Promise<void>;
}

/** A stand-in for Core on a free loopback port that answers every request with `status`; never the real Core. */
async function fakeCore(home: string, status: number): Promise<FakeCore> {
  const requests: FakeCore['requests'] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { accepted: 1 } : { error: 'not found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const info = { pid: process.pid, port: (server.address() as AddressInfo).port, token: randomBytes(32).toString('hex'), startedAt: new Date().toISOString(), version: 'test' };
  fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
  fs.writeFileSync(jerryPaths(home).coreInfoFile, JSON.stringify(info));
  return { requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('status-line script (built bundle)', () => {
  it('prints JERRY\'s segment and records the sighting, but keeps no usage outside the projects', () => {
    const home = freshDir('home');
    const project = freshDir('project');
    const elsewhere = freshDir('elsewhere');
    writeProjectsFile(home, [project]);

    const result = runScript(home, payload(elsewhere));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('🛡️ JERRY · 5h 23% · week 41% · $1.20\n');
    expect(readLast(home)).toMatchObject({ entrypoint: 'cli', sessionId: 'session-1', version: '2.1.90', hasRateLimits: true, byEntrypoint: { cli: { hasRateLimits: true } } });
    expect(JSON.stringify(readLast(home))).not.toMatch(/pct|cost|fiveHour|sevenDay/i);
    expect(spooled(home)).toEqual([]);
  });

  it('spools the snapshot when Core is not running (projects.json missing: every directory counts)', () => {
    const home = freshDir('home');
    const cwd = freshDir('repo');
    const result = runScript(home, payload(cwd));
    expect(result.exitCode).toBe(0);
    const [snapshot, ...rest] = spooled(home);
    expect(rest).toEqual([]);
    expect(snapshot).toMatchObject({
      sessionId: 'session-1',
      cwd,
      model: 'Opus',
      version: '2.1.90',
      fiveHour: { pct: 23, resetsAt: '2026-11-07T00:00:00.000Z' },
      sevenDay: { pct: 41, resetsAt: '2026-11-12T00:00:00.000Z' },
      costUsd: 1.2,
      inputTokens: 100,
      outputTokens: 50,
      contextUsedPct: 10,
      entrypoint: 'cli',
    });
    expect(Date.parse(String(snapshot?.['at']))).not.toBeNaN();
  });

  it('spools the snapshot when Core has no usage route yet (404), and posts it with the Core token', async () => {
    const home = freshDir('home');
    const cwd = freshDir('repo');
    const core = await fakeCore(home, 404);
    try {
      const result = await runScriptAsync(home, payload(cwd));
      expect(result.exitCode).toBe(0);
      expect(core.requests).toHaveLength(1);
      expect(core.requests[0]).toMatchObject({ method: 'POST', url: '/api/v1/usage/snapshots', body: { snapshots: [{ sessionId: 'session-1', cwd }] } });
      const token = (JSON.parse(fs.readFileSync(jerryPaths(home).coreInfoFile, 'utf8')) as { token: string }).token;
      expect(core.requests[0]?.authorization).toBe(`Bearer ${token}`);
      expect(spooled(home)).toHaveLength(1);
    } finally {
      await core.close();
    }
  });

  it('does not spool what Core accepted', async () => {
    const home = freshDir('home');
    const cwd = freshDir('repo');
    const core = await fakeCore(home, 200);
    try {
      expect((await runScriptAsync(home, payload(cwd))).exitCode).toBe(0);
      expect(core.requests).toHaveLength(1);
      expect(spooled(home)).toEqual([]);
    } finally {
      await core.close();
    }
  });

  it('keeps nothing while the user has paused JERRY', () => {
    const home = freshDir('home');
    fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
    fs.writeFileSync(jerryPaths(home).autostartDisabledFile, '');
    expect(runScript(home, payload(freshDir('repo'))).exitCode).toBe(0);
    expect(spooled(home)).toEqual([]);
  });

  it('never fails: garbage input still prints JERRY and records that it ran', () => {
    const home = freshDir('home');
    for (const input of ['', 'not json', '[1,2,3]', '{"rate_limits":{"five_hour":"x"}}']) {
      const result = runScript(home, input, { JERRY_NO_EMOJI: '1' });
      expect(result.exitCode, input).toBe(0);
      expect(result.stdout, input).toBe('JERRY\n');
    }
    expect(readLast(home)).toMatchObject({ entrypoint: 'cli', hasRateLimits: false });
    expect(spooled(home)).toEqual([]);
  });

  it('shows the window before the first API response as absent', () => {
    const home = freshDir('home');
    writeProjectsFile(home, []);
    const result = runScript(home, payload(freshDir('repo'), { rate_limits: undefined, cost: { total_cost_usd: 0 } }), { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
    expect(result.stdout).toBe('🛡️ JERRY · $0.00\n');
    expect(readLast(home)).toMatchObject({ entrypoint: 'claude-vscode', hasRateLimits: false });
  });

  describe('chaining the previous status line', () => {
    let home: string;
    let scripts: string;
    beforeEach(() => {
      home = freshDir('home');
      scripts = freshDir('scripts');
      writeProjectsFile(home, []);
    });
    afterEach(() => fs.rmSync(scripts, { recursive: true, force: true }));

    function previous(source: string): void {
      const file = path.join(scripts, 'previous.mjs');
      fs.writeFileSync(file, source);
      writeStatuslineConfig(home, { previous: { type: 'command', command: `node "${file.replaceAll('\\', '/')}"` }, enabledAt: new Date().toISOString() });
    }

    it('prints the previous status line first, fed the same input', () => {
      previous("let raw = ''; process.stdin.on('data', (c) => (raw += c)); process.stdin.on('end', () => console.log('previous for ' + JSON.parse(raw).session_id));");
      const result = runScript(home, payload(freshDir('repo')));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('previous for session-1\n🛡️ JERRY · 5h 23% · week 41% · $1.20\n');
    });

    it('cuts off a previous status line that hangs, and still prints JERRY\'s', () => {
      previous("console.log('too late'); setTimeout(() => {}, 4000);");
      const result = runScript(home, payload(freshDir('repo')));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('🛡️ JERRY · 5h 23% · week 41% · $1.20\n');
      expect(result.ms).toBeLessThan(3500);
    });

    it('ignores a previous command that fails to run', () => {
      writeStatuslineConfig(home, { previous: { type: 'command', command: 'no-such-command-for-jerry-tests' }, enabledAt: new Date().toISOString() });
      const result = runScript(home, payload(freshDir('repo')), { JERRY_NO_EMOJI: '1' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('JERRY · 5h 23% · week 41% · $1.20\n');
    });
  });
});

describe('turning JERRY\'s status line on and off (isolated Claude config)', () => {
  const USER_STATUS_LINE = { type: 'command', command: 'bash ~/.claude/my-status.sh', padding: 1 };
  const OTHER_SETTINGS = { model: 'opus', permissions: { allow: ['Bash(git status)'] }, enabledPlugins: { 'other@elsewhere': true }, env: { FOO: 'bar' } };

  function setup(settings: Record<string, unknown> | null) {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const settingsFile = path.join(claudeConfigDir, 'settings.json');
    if (settings !== null) fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    const locations = { home, claudeConfigDir, payload: SCRIPT };
    const read = (): Record<string, unknown> => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
    const backups = (): string[] => (fs.existsSync(jerryPaths(home).backupsDir) ? fs.readdirSync(jerryPaths(home).backupsDir).filter((name) => name.startsWith('claude-settings-')) : []);
    return { home, settingsFile, locations, read, backups };
  }

  it('enables with a backup, keeps every other key and the previous status line, then restores it', () => {
    const original = { ...OTHER_SETTINGS, statusLine: USER_STATUS_LINE };
    const { home, settingsFile, locations, read, backups } = setup(original);
    const before = fs.readFileSync(settingsFile, 'utf8');

    const enabled = applyStatusline(locations);
    expect(enabled.change).toBe('enabled');
    expect(enabled.backupFile).not.toBeNull();
    expect(fs.readFileSync(enabled.backupFile!, 'utf8')).toBe(before);
    const runtime = jerryPaths(home).runtimeStatuslineFile;
    expect(fs.readFileSync(runtime)).toEqual(fs.readFileSync(SCRIPT));
    const { statusLine, ...rest } = read();
    expect(rest).toEqual(OTHER_SETTINGS);
    expect(statusLine).toEqual({ type: 'command', command: `node "${runtime.replaceAll('\\', '/')}"`, padding: 0 });
    expect(String((statusLine as { command: string }).command)).not.toContain('\\');
    expect(isJerryStatusLine(statusLine, home)).toBe(true);
    expect(readStatuslineConfig(home)?.previous).toEqual(USER_STATUS_LINE);

    // Idempotent: nothing written, no new backup.
    expect(applyStatusline(locations).change).toBe('unchanged');
    expect(backups()).toHaveLength(1);
    expect(readStatuslineConfig(home)?.previous).toEqual(USER_STATUS_LINE);

    const disabled = removeStatusline(locations);
    expect(disabled.change).toBe('restored');
    expect(disabled.backupFile).not.toBeNull();
    expect(read()).toEqual(original);
    expect(fs.existsSync(jerryPaths(home).statuslineConfigFile)).toBe(false);
    expect(removeStatusline(locations).change).toBe('not-enabled');
    expect(read()).toEqual(original);
  });

  it('removes the key when there was no status line before, and creates settings.json when missing', () => {
    const plain = setup(OTHER_SETTINGS);
    expect(applyStatusline(plain.locations).change).toBe('enabled');
    expect(readStatuslineConfig(plain.home)?.previous).toBeNull();
    expect(removeStatusline(plain.locations).change).toBe('removed');
    expect(plain.read()).toEqual(OTHER_SETTINGS);

    const missing = setup(null);
    const enabled = applyStatusline(missing.locations);
    expect(enabled).toMatchObject({ change: 'enabled', backupFile: null });
    expect(Object.keys(missing.read())).toEqual(['statusLine']);
    expect(removeStatusline(missing.locations).change).toBe('removed');
    expect(missing.read()).toEqual({});
  });

  it('leaves a status line the user set after JERRY\'s alone', () => {
    const { settingsFile, locations, read } = setup(OTHER_SETTINGS);
    applyStatusline(locations);
    const mine = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(settingsFile, JSON.stringify({ ...read(), statusLine: mine }));
    expect(removeStatusline(locations).change).toBe('not-jerry');
    expect(read()['statusLine']).toEqual(mine);
  });

  it('changes nothing when settings.json is not valid JSON', () => {
    const { home, settingsFile, locations } = setup(null);
    fs.writeFileSync(settingsFile, '{ "model": "opus", ');
    expect(() => applyStatusline(locations)).toThrow(/not valid JSON/);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ "model": "opus", ');
    expect(fs.existsSync(jerryPaths(home).statuslineConfigFile)).toBe(false);
  });
});

describe('jerry statusline (CLI)', () => {
  function jerry(args: string[], env: Record<string, string>) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...TEST_CORE_ENV, ...env }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it('refuses enable and disable without an interactive terminal, and changes nothing', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const settingsFile = path.join(claudeConfigDir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus' }));
    for (const verb of ['enable', 'disable']) {
      const refused = jerry(['statusline', verb], { JERRY_HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir });
      expect(refused.exitCode, verb).toBe(1);
      expect(refused.stderr, verb).toContain('interactive terminal');
    }
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual({ model: 'opus' });
    expect(fs.existsSync(path.join(home, 'config'))).toBe(false);
  });

  it('status is read-only and shows the state, the chained command and the last run per client', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir, JERRY_NO_EMOJI: '1' };
    fs.writeFileSync(path.join(claudeConfigDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));

    const off = jerry(['statusline', 'status'], env);
    expect(off.exitCode, off.stderr).toBe(0);
    expect(off.stdout).toContain('JERRY status line: off');
    expect(off.stdout).toContain('last run      never');

    applyStatusline({ home, claudeConfigDir, payload: SCRIPT });
    runScript(home, payload(freshDir('repo')), { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
    const on = jerry(['statusline'], env);
    expect(on.exitCode, on.stderr).toBe(0);
    expect(on.stdout).toContain('JERRY status line: on');
    expect(on.stdout).toContain('chained       echo mine');
    expect(on.stdout).toMatch(/entrypoint claude-vscode, Claude Code 2\.1\.90, rate limits present/);

    const json = JSON.parse(jerry(['statusline', 'status', '--json'], env).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ enabled: true, previous: { command: 'echo mine' }, scriptInstalled: true, last: { entrypoint: 'claude-vscode', hasRateLimits: true } });
  });
});
