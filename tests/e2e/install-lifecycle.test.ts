import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findClaudeBinary } from '@jerry/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureRepo, ROOT, snapshotRepo, tempDir } from '../helpers/harness.js';

const JERRY_CLI = path.join(ROOT, 'dist', 'cli', 'jerry.mjs');
const claude = findClaudeBinary();

/** Unrelated user configuration that install/uninstall must preserve. */
const EXISTING_SETTINGS = {
  model: 'opus',
  permissions: { allow: ['Bash(git status)'], deny: ['Read(./.env)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
  env: { FOO: 'bar' },
  enabledPlugins: { 'other@elsewhere': false },
};

function fingerprintRealProfile(): string {
  const claudeDir = path.join(os.homedir(), '.claude');
  const hash = createHash('sha256');
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(claudeDir, name);
    hash.update(fs.existsSync(file) ? fs.readFileSync(file) : `missing:${name}`);
  }
  for (const name of ['installed_plugins.json', 'known_marketplaces.json']) {
    const file = path.join(claudeDir, 'plugins', name);
    hash.update(fs.existsSync(file) ? fs.readFileSync(file) : `missing:${name}`);
  }
  return hash.digest('hex');
}

/**
 * M0 acceptance for install/uninstall through the official Claude Code CLI, against an
 * isolated CLAUDE_CONFIG_DIR that already contains user settings. The real profile must not change.
 */
describe.skipIf(claude === null)('jerry install / doctor / uninstall (isolated Claude profile)', () => {
  let env: NodeJS.ProcessEnv;
  let claudeConfigDir: string;
  let jerryHome: string;
  let repo: string;
  let repoBefore: ReturnType<typeof snapshotRepo>;
  let realProfileBefore: string;
  let base: string;

  beforeAll(() => {
    base = tempDir('install');
    jerryHome = path.join(base, 'jerry-home');
    claudeConfigDir = path.join(base, 'claude-config');
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    fs.writeFileSync(path.join(claudeConfigDir, 'settings.json'), JSON.stringify(EXISTING_SETTINGS, null, 2));
    env = { ...process.env, JERRY_HOME: jerryHome, CLAUDE_CONFIG_DIR: claudeConfigDir, JERRY_CORE_PORT: '0' };
    repo = createFixtureRepo(path.join(base, 'repo'));
    repoBefore = snapshotRepo(repo);
    realProfileBefore = fingerprintRealProfile();
  });

  afterAll(() => {
    jerry(['core', 'stop']);
    fs.rmSync(base, { recursive: true, force: true });
  });

  function jerry(args: string[], cwd = repo) {
    const result = spawnSync(process.execPath, [JERRY_CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 180_000, windowsHide: true });
    return { exitCode: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
  }

  function claudeJson(args: string[]): unknown {
    const result = spawnSync(claude!.path, args, { env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  function settings(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(claudeConfigDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
  }

  it('installs the plugin in user scope from the local marketplace in JERRY_HOME', () => {
    const result = jerry(['install']);
    expect(result.exitCode, result.output).toBe(0);

    const plugins = claudeJson(['plugin', 'list', '--json']) as Array<{ id: string; enabled: boolean; scope: string; readFromFolder?: string }>;
    const jerryPlugin = plugins.find((plugin) => plugin.id === 'jerry@jerry-local');
    expect(jerryPlugin).toMatchObject({ enabled: true, scope: 'user' });
    expect(path.resolve(jerryPlugin!.readFromFolder!)).toBe(path.resolve(jerryHome, 'marketplace', 'plugins', 'jerry'));
    expect(fs.existsSync(path.join(jerryHome, 'runtime', 'core', 'core.mjs'))).toBe(true);
  });

  it('produces a plugin that passes official validation', () => {
    const result = spawnSync(claude!.path, ['plugin', 'validate', path.join(jerryHome, 'marketplace', 'plugins', 'jerry')], { env, encoding: 'utf8' });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('preserves unrelated Claude settings', () => {
    const current = settings();
    const { enabledPlugins, extraKnownMarketplaces, ...rest } = current;
    const { enabledPlugins: originalPlugins, ...originalRest } = EXISTING_SETTINGS;
    expect(rest).toEqual(originalRest);
    expect(enabledPlugins).toEqual({ ...originalPlugins, 'jerry@jerry-local': true });
    expect(extraKnownMarketplaces).toHaveProperty('jerry-local');
  });

  it('is idempotent', () => {
    const result = jerry(['install']);
    expect(result.exitCode, result.output).toBe(0);
  });

  it('doctor reports UNGUARDED-equivalent failure without Core, GUARDED with Core', () => {
    const withoutCore = jerry(['doctor']);
    expect(withoutCore.exitCode).toBe(1);
    expect(withoutCore.output).toContain('Guard status: DEGRADED');

    const started = jerry(['core', 'start']);
    expect(started.exitCode, started.output).toBe(0);
    const healthy = jerry(['doctor']);
    expect(healthy.exitCode, healthy.output).toBe(0);
    expect(healthy.output).toContain('Guard status: GUARDED');
    expect(healthy.output).toMatch(/PASS\s+core-autostart/);
    expect(healthy.output).toMatch(/PASS\s+disk-usage\s+[\d.]+ MiB/);
    for (const check of ['node-for-hooks', 'claude-cli', 'plugin', 'marketplace', 'plugin-build', 'settings', 'core-build', 'api-auth', 'database']) {
      expect(healthy.output, check).toMatch(new RegExp(`PASS\\s+${check}\\s`));
    }
    expect(jerry(['status']).output).toContain('GUARDED (monitoring on, hard rules enforced)');
    const login = jerry(['ui', '--print-url']);
    expect(login.exitCode, login.output).toBe(0);
    expect(login.output.trim()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ui\/login\?code=[0-9a-f]{64}$/);
    expect(jerry(['core', 'stop']).exitCode).toBe(0);
  });

  it('uninstalls only what JERRY added and keeps JERRY data by default', () => {
    const result = jerry(['uninstall']);
    expect(result.exitCode, result.output).toBe(0);

    const plugins = claudeJson(['plugin', 'list', '--json']) as Array<{ id: string }>;
    expect(plugins.map((plugin) => plugin.id)).not.toContain('jerry@jerry-local');
    expect(fs.existsSync(path.join(jerryHome, 'marketplace'))).toBe(false);
    expect(fs.existsSync(path.join(jerryHome, 'runtime'))).toBe(false);
    expect(fs.existsSync(path.join(jerryHome, 'database', 'jerry.sqlite'))).toBe(true);

    const { enabledPlugins, extraKnownMarketplaces, ...rest } = settings();
    const { enabledPlugins: originalPlugins, ...originalRest } = EXISTING_SETTINGS;
    expect(rest).toEqual(originalRest);
    expect(enabledPlugins).toEqual(originalPlugins);
    expect(extraKnownMarketplaces ?? {}).not.toHaveProperty('jerry-local');
  });

  it('uninstall is idempotent', () => {
    expect(jerry(['uninstall']).exitCode).toBe(0);
  });

  it('--purge-data deletes only what JERRY created in JERRY_HOME', () => {
    const foreign = path.join(jerryHome, 'not-created-by-jerry.txt');
    fs.writeFileSync(foreign, 'keep me');

    const result = jerry(['uninstall', '--purge-data']);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain('JERRY did not create');
    expect(fs.existsSync(foreign)).toBe(true);
    for (const entry of ['run', 'state', 'database', 'backups', 'logs', 'config', 'marketplace', 'runtime']) {
      expect(fs.existsSync(path.join(jerryHome, entry))).toBe(false);
    }
  });

  it('never touched the project repository or the real Claude profile', () => {
    expect(snapshotRepo(repo)).toEqual(repoBefore);
    expect(fingerprintRealProfile()).toBe(realProfileBefore);
  });
});
