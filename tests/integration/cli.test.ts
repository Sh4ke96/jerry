import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { JERRY_VERSION } from '@jerry/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, startCore, tempDir, TEST_CORE_ENV } from '../helpers/harness.js';

const CLI = path.join(ROOT, 'dist', 'cli', 'jerry.mjs');
const base = tempDir('cli');
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function jerry(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...TEST_CORE_ENV, JERRY_HOME: path.join(base, 'home'), ...env }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('jerry CLI (Commander)', () => {
  it('prints its version and help', () => {
    expect(jerry(['--version']).stdout.trim()).toBe(JERRY_VERSION);
    const help = jerry(['--help']);
    expect(help.exitCode).toBe(0);
    for (const command of ['status', 'doctor', 'install', 'ui', 'core', 'task', 'approve', 'events', 'db']) expect(help.stdout).toContain(command);
  });

  it('treats --version after approve as the plan version, not the program version', () => {
    // Without a terminal the approval stops before contacting Core: proof the options were parsed.
    const result = jerry(['approve', 'JRY-0001', '--stage', 'plan', '--version', '2']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(JERRY_VERSION);
    expect(result.stderr).toContain('interactive terminal');
  });

  it('validates arguments before doing anything', () => {
    expect(jerry(['approve', 'JRY-0001', '--stage', 'review', '--version', '1']).stderr).toContain('only "plan" is supported');
    expect(jerry(['approve', 'JRY-0001', '--stage', 'plan', '--version', 'two']).stderr).toContain('must be a positive integer');
    expect(jerry(['task', 'create', '--repo', '.', '--title', 'x']).stderr).toContain("required option '--scope <glob>' not specified");
    expect(jerry(['events', '--limit', '0']).stderr).toContain('must be a positive integer');
    expect(jerry(['no-such-command']).exitCode).toBe(1);
  });

  it('jerry status: UNGUARDED when not installed, and a summary when Core runs', async () => {
    const notInstalled = jerry(['status'], { JERRY_HOME: path.join(base, 'empty-home') });
    expect(notInstalled.exitCode).toBe(0);
    expect(notInstalled.stdout).toContain('UNGUARDED');

    const home = path.join(base, 'running-home');
    const core = await startCore(home);
    try {
      fs.mkdirSync(path.join(home, 'config'), { recursive: true });
      fs.writeFileSync(path.join(home, 'config', 'install-manifest.json'), '{}');
      const summary = jerry(['status'], { JERRY_HOME: home });
      expect(summary.stdout).toContain('GUARDED (monitoring on, hard rules enforced)');
      expect(summary.stdout).toMatch(/Tasks:\s+0 in implementation, 0 waiting/);
      expect(summary.stdout).toContain(`127.0.0.1:${core.info.port}`);
    } finally {
      await core.stop();
    }
  });

  it('jerry task: lists open tasks with their state, shows history, and keeps pause/resume/cancel for a terminal', async () => {
    const home = path.join(base, 'task-home');
    const repo = path.join(base, 'task-repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const core = await startCore(home);
    try {
      const created = jerry(['task', 'create', '--repo', repo, '--title', 'CLI flow', '--scope', 'src/**'], { JERRY_HOME: home });
      expect(created.stdout).toContain('Created JRY-0001');
      expect(jerry(['task', 'list'], { JERRY_HOME: home }).stdout).toMatch(/JRY-0001\s+plan v1\s+Waiting for plan approval/);

      const shown = jerry(['task', 'show', 'JRY-0001'], { JERRY_HOME: home });
      expect(shown.stdout).toContain('JRY-0001  Waiting for plan approval (WAIT_PLAN_APPROVAL)');
      expect(shown.stdout).toMatch(/new\s+-> WAIT_PLAN_APPROVAL\s+plan\.submitted by user/);

      for (const verb of ['pause', 'resume', 'cancel']) {
        const refused = jerry(['task', verb, 'JRY-0001'], { JERRY_HOME: home });
        expect(refused.exitCode, verb).toBe(1);
        expect(refused.stderr, verb).toContain('interactive terminal');
      }
      expect(jerry(['task', 'show', 'JRY-0001'], { JERRY_HOME: home }).stdout).toContain('(WAIT_PLAN_APPROVAL)');
    } finally {
      await core.stop();
    }
  });
});
