import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, ROOT, runBridge, startCore, tempDir, TEST_CORE_ENV, type RunningCore } from '../helpers/harness.js';

/**
 * A Claude Code session in a workspace, end to end: the real Core and hook bridge. In one of its
 * repositories the start context names the workspace and its other repositories; in their common
 * parent folder (not a repository) the session is a workspace session instead of "not a project".
 */
describe('workspace sessions (Core + bridge)', () => {
  const base = tempDir('workspace-session');
  const home = path.join(base, 'home');
  const work = path.join(base, 'work');
  let apiRepo: string;
  let shopRepo: string;
  let core: RunningCore;

  beforeAll(async () => {
    apiRepo = createFixtureRepo(path.join(work, 'api'));
    shopRepo = createFixtureRepo(path.join(work, 'shop'));
    core = await startCore(home, {}, { projects: [] });
    const created = await api(core, 'POST', '/api/v1/workspaces', { name: 'Sklep', paths: [apiRepo, shopRepo] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const contextAt = (cwd: string, sessionId: string): string => {
    const result = runBridge('session-start', { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' }, { JERRY_HOME: home });
    expect(result.exitCode, result.stderr).toBe(0);
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
  };

  it('names the workspace and its repositories in a session in one of them', () => {
    const context = contextAt(shopRepo, 'ws-shop');
    expect(context).toContain('JERRY: monitoring this session');
    expect(context).toContain('Workspace "Sklep"');
    expect(context).toContain(`${shopRepo} (this session): no open task`);
    expect(context).toContain(`${apiRepo}: no open task`);
  });

  it('treats a session in their common parent folder as a workspace session', () => {
    const context = contextAt(work, 'ws-parent');
    expect(context).not.toContain('this project is not added');
    expect(context).toContain('This folder holds the repositories of a JERRY workspace');
    expect(context).toContain('Workspace "Sklep"');
  });

  it('keeps a folder outside any workspace "not a project"', () => {
    expect(contextAt(base, 'ws-outside')).toContain('this project is not added');
  });

  it('lists workspaces in the CLI, and refuses every change without an interactive terminal', () => {
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'cli', 'jerry.mjs'), ...args], { env: { ...process.env, ...TEST_CORE_ENV, JERRY_HOME: home, JERRY_NO_EMOJI: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
      return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    };
    const listed = run(['workspace', 'list']);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('Sklep: 2 repositories');
    expect(run(['workspace', 'show', 'sklep']).stdout).toContain(apiRepo);
    for (const args of [['workspace', 'create', 'X', apiRepo], ['workspace', 'add', 'Sklep', apiRepo], ['workspace', 'remove', 'Sklep', apiRepo], ['workspace', 'rename', 'Sklep', 'Y'], ['workspace', 'delete', 'Sklep']]) {
      const refused = run(args);
      expect(refused.exitCode, args.join(' ')).toBe(1);
      expect(refused.stderr, args.join(' ')).toContain('interactive terminal');
    }
  });
});
