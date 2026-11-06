import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findClaudeBinary } from '@jerry/platform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureRepo, ROOT, tempDir } from '../helpers/harness.js';

const claude = findClaudeBinary();
const CURRENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version as string;
const NEXT = `${CURRENT}-next.1`;

/** A package directory like the release: cli, core, plugin, evals; optionally stamped with another version. */
function makePackage(target: string, version: string): string {
  for (const part of ['cli', 'core', 'plugin', 'evals']) fs.cpSync(path.join(ROOT, 'dist', part), path.join(target, part), { recursive: true });
  if (version !== CURRENT) {
    // The version is a literal in the bundles and the plugin manifest; stamp them as a newer build would be.
    let stamped = 0;
    for (const file of ['cli/jerry.mjs', 'core/core.mjs', 'plugin/.claude-plugin/plugin.json']) {
      const full = path.join(target, file);
      const before = fs.readFileSync(full, 'utf8');
      const after = before.replaceAll(`"${CURRENT}"`, `"${version}"`).replaceAll(`'${CURRENT}'`, `'${version}'`);
      stamped += before === after ? 0 : 1;
      fs.writeFileSync(full, after);
    }
    expect(stamped).toBe(3);
  }
  return path.join(target, 'cli', 'jerry.mjs');
}

/**
 * ADR 0043: installing a newer package over an older one, and rolling back, keeps JERRY's data and
 * the guard. Runs through the official Claude Code CLI against an isolated Claude profile.
 */
describe.skipIf(claude === null)('update and rollback across two versions (isolated Claude profile)', () => {
  const base = tempDir('update');
  const env = { ...process.env, JERRY_HOME: path.join(base, 'jerry-home'), CLAUDE_CONFIG_DIR: path.join(base, 'claude-config'), JERRY_CORE_PORT: '0' };
  const repo = createFixtureRepo(path.join(base, 'repo'));
  let older: string;
  let newer: string;

  beforeAll(() => {
    fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'opus' }));
    older = makePackage(path.join(base, 'pkg-a'), CURRENT);
    newer = makePackage(path.join(base, 'pkg-b'), NEXT);
  });
  afterAll(() => {
    spawnSync(process.execPath, [older, 'core', 'stop'], { env, windowsHide: true });
    fs.rmSync(base, { recursive: true, force: true });
  });

  const jerry = (cli: string, args: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 180_000, windowsHide: true });
    return { exitCode: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
  };
  const coreVersion = (cli: string): string => /JERRY Core (\S+):/.exec(jerry(cli, ['core', 'status']).output)?.[1] ?? '?';

  it('installs the older version and creates data', () => {
    expect(jerry(older, ['install']).exitCode).toBe(0);
    expect(jerry(older, ['core', 'start']).exitCode).toBe(0);
    expect(coreVersion(older)).toBe(CURRENT);
    expect(jerry(older, ['task', 'create', '--repo', repo, '--title', 'Survives updates', '--scope', 'src/**']).output).toContain('Created JRY-0001');
    expect(jerry(older, ['core', 'stop']).exitCode).toBe(0);
  });

  it('updates to the newer version with the data kept', () => {
    const installed = jerry(newer, ['install']);
    expect(installed.exitCode, installed.output).toBe(0);
    expect(jerry(newer, ['core', 'start']).exitCode).toBe(0);
    expect(coreVersion(newer)).toBe(NEXT);
    expect(jerry(newer, ['task', 'list']).output).toMatch(/JRY-0001\s+plan v1\s+Waiting for plan approval.*Survives updates/);
    expect(jerry(newer, ['status']).output).toContain('GUARDED');
    expect(jerry(newer, ['core', 'stop']).exitCode).toBe(0);
  });

  it('rolls back to the older version with the data kept', () => {
    expect(jerry(older, ['install']).exitCode).toBe(0);
    expect(jerry(older, ['core', 'start']).exitCode).toBe(0);
    expect(coreVersion(older)).toBe(CURRENT);
    expect(jerry(older, ['task', 'list']).output).toContain('Survives updates');
    expect(jerry(older, ['status']).output).toContain('GUARDED');
    expect(jerry(older, ['uninstall']).exitCode).toBe(0);
    // Uninstall keeps the data unless asked otherwise.
    expect(fs.existsSync(path.join(env.JERRY_HOME, 'database', 'jerry.sqlite'))).toBe(true);
  });
});
