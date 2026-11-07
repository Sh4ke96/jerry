import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { JERRY_VERSION } from '@jerry/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { addProject, createFixtureRepo, ROOT, snapshotRepo, startCore, tempDir, TEST_CORE_ENV } from '../helpers/harness.js';

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
    expect(jerry(['approve', 'JRY-0001', '--stage', 'review', '--version', '1']).stderr).toContain('must be "plan", "implementation" or "review-fix"');
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

  it('jerry repo scan: reports what the scanner detects and leaves the repository untouched', () => {
    const repo = createFixtureRepo(path.join(base, 'scan-repo'));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '5' } }));
    const before = snapshotRepo(repo);
    const result = jerry(['repo', 'scan', repo, '--json']);
    expect(result.exitCode, result.stderr).toBe(0);
    const scan = JSON.parse(result.stdout) as { root: string; commands: Array<{ command: string }>; frameworks: Array<{ name: string }> };
    expect(path.resolve(scan.root)).toBe(path.resolve(repo));
    expect(scan.commands.map((command) => command.command)).toEqual(['npm run test', 'npm run lint']);
    expect(scan.frameworks.map((framework) => framework.name)).toEqual(['Vitest']);
    expect(jerry(['repo', 'scan', path.join(repo, 'src')]).stdout).toContain('test      npm run test');
    expect(snapshotRepo(repo)).toEqual(before);
  });

  it('jerry task: lists open tasks with their state, shows history, and keeps pause/resume/cancel for a terminal', async () => {
    const home = path.join(base, 'task-home');
    const repo = path.join(base, 'task-repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const core = await startCore(home);
    try {
      await addProject(core, repo);
      const created = jerry(['task', 'create', '--repo', repo, '--title', 'CLI flow', '--scope', 'src/**'], { JERRY_HOME: home });
      expect(created.stdout).toContain('Created JRY-0001');
      expect(jerry(['task', 'list'], { JERRY_HOME: home }).stdout).toMatch(/JRY-0001\s+plan v1\s+Waiting for plan approval/);

      const shown = jerry(['task', 'show', 'JRY-0001'], { JERRY_HOME: home });
      expect(shown.stdout).toContain('JRY-0001  Waiting for plan approval (WAIT_PLAN_APPROVAL)');
      expect(shown.stdout).toMatch(/new\s+-> WAIT_PLAN_APPROVAL\s+plan\.submitted by user/);

      // Re-running the final checks can set DONE: a terminal too.
      for (const verb of ['pause', 'resume', 'cancel', 'recheck']) {
        const refused = jerry(['task', verb, 'JRY-0001'], { JERRY_HOME: home });
        expect(refused.exitCode, verb).toBe(1);
        expect(refused.stderr, verb).toContain('interactive terminal');
      }
      expect(jerry(['task', 'show', 'JRY-0001'], { JERRY_HOME: home }).stdout).toContain('(WAIT_PLAN_APPROVAL)');
      // A scope-only plan is graded as such, for information.
      expect(shown.stdout).toContain('completeness: scope-only (0/100, informational)');
    } finally {
      await core.stop();
    }
  });

  it('jerry project and jerry data: show without a terminal, change only in one', async () => {
    const home = path.join(base, 'projects-home');
    const repo = createFixtureRepo(path.join(base, 'projects-repo'));
    const core = await startCore(home, {}, { projects: [] });
    try {
      const run = (args: string[]) => jerry(args, { JERRY_HOME: home, JERRY_NO_EMOJI: '1' });
      expect(run(['project', 'list']).stdout).toContain('No projects yet');
      // Adding, removing and deleting are the user's decisions: no terminal, no change.
      for (const args of [['project', 'add', repo], ['project', 'remove', repo], ['repo', 'include', repo], ['repo', 'exclude', repo], ['data', 'prune', '--events-older-than', '30'], ['data', 'forget', repo]]) {
        const refused = run(args);
        expect(refused.exitCode, args.join(' ')).toBe(1);
        expect(refused.stderr, args.join(' ')).toContain('interactive terminal');
      }
      expect(run(['data', 'prune', '--events-older-than', 'soon']).stderr).toContain('must be a whole number');
      expect(run(['project', 'list']).stdout).toContain('No projects yet');

      await addProject(core, repo);
      const listed = run(['project', 'list']);
      expect(listed.exitCode, listed.stderr).toBe(0);
      expect(listed.stdout).toMatch(new RegExp(`${repo.replaceAll('\\', '\\\\')}  0 open task\\(s\\) of 0 · no activity yet · added \\d{4}-\\d{2}-\\d{2} \\(cli\\)`));
      expect(run(['repo', 'list']).stdout).toBe(listed.stdout);
      expect(JSON.parse(run(['project', 'list', '--json']).stdout)).toMatchObject([{ repoRoot: repo, openTasks: 0 }]);

      const usage = run(['data']);
      expect(usage.exitCode, usage.stderr).toBe(0);
      expect(usage.stdout).toMatch(/^JERRY stores [\d.]+ (B|KiB|MiB) on this computer/);
      expect(usage.stdout).toContain('Events and sessions older than 90 days are removed automatically.');
      expect(usage.stdout).not.toMatch(/\p{Extended_Pictographic}/u);
      const json = JSON.parse(run(['data', '--json']).stdout) as { totalBytes: number; categories: unknown[] };
      expect(json.totalBytes).toBeGreaterThan(0);
      expect(json.categories).toHaveLength(10);
    } finally {
      await core.stop();
    }
  });

  it('jerry settings: shows them without a terminal, changes them only in one', async () => {
    const home = path.join(base, 'settings-home');
    const repo = createFixtureRepo(path.join(base, 'settings-repo'));
    const core = await startCore(home, {}, { projects: [repo] });
    try {
      const run = (args: string[]) => jerry(args, { JERRY_HOME: home, JERRY_NO_EMOJI: '1' });
      const shown = run(['settings']);
      expect(shown.exitCode, shown.stderr).toBe(0);
      expect(shown.stdout).toMatch(/review\.mode\s+optional/);
      expect(shown.stdout).toMatch(/qa\.language\s+pl/);
      expect(JSON.parse(run(['settings', '--json']).stdout)).toMatchObject({ reviewMode: 'optional', qaLanguage: 'pl', projects: [{ repoRoot: repo, reviewMode: null, effectiveReviewMode: 'optional' }] });

      // Changing a setting is the user's decision: no terminal, no change.
      for (const args of [['settings', 'set', 'review.mode', 'required'], ['settings', 'set', 'qa.language', 'en'], ['settings', 'set', 'review.mode', 'inherit', '--project', repo]]) {
        const refused = run(args);
        expect(refused.exitCode, args.join(' ')).toBe(1);
        expect(refused.stderr, args.join(' ')).toContain('interactive terminal');
      }
      // Invalid values are refused before anything else.
      expect(run(['settings', 'set', 'review.mode', 'sometimes']).stderr).toContain('review.mode must be "optional" or "required"');
      expect(run(['settings', 'set', 'qa.language', 'de']).stderr).toContain('qa.language must be "pl" or "en"');
      expect(run(['settings', 'set', 'qa.language', 'en', '--project', repo]).stderr).toContain('no per-project value');
      expect(run(['settings', 'set', 'theme', 'dark']).stderr).toContain('Unknown setting "theme"');
      expect(JSON.parse(run(['settings', '--json']).stdout)).toMatchObject({ reviewMode: 'optional', qaLanguage: 'pl' });

      // The review choice belongs to accepting an implementation, which needs a terminal too.
      expect(run(['approve', 'JRY-0001', '--stage', 'plan', '--version', '1', '--review']).stderr).toContain('apply only to accepting an implementation');
      for (const flag of ['--review', '--no-review']) {
        const refused = run(['approve', 'JRY-0001', '--stage', 'implementation', '--version', '1', flag]);
        expect(refused.exitCode, flag).toBe(1);
        expect(refused.stderr, flag).toContain('interactive terminal');
      }
      expect(run(['reject', 'JRY-0001', '--stage', 'implementation', '--version', '1', '--review']).stderr).toContain("unknown option '--review'");
    } finally {
      await core.stop();
    }
  });

  it('jerry plan diff: shows what changed between plan versions', async () => {
    const home = path.join(base, 'diff-home');
    const repo = path.join(base, 'diff-repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const core = await startCore(home);
    try {
      await addProject(core, repo);
      jerry(['task', 'create', '--repo', repo, '--title', 'Diff flow', '--scope', 'src/**'], { JERRY_HOME: home });
      expect(jerry(['plan', 'diff', 'JRY-0001'], { JERRY_HOME: home }).stdout).toContain('there is nothing to compare');
      expect(jerry(['plan', 'revise', 'JRY-0001', '--scope', 'src/**', '--scope', 'tests/**'], { JERRY_HOME: home }).exitCode).toBe(0);
      jerry(['plan', 'revise', 'JRY-0001', '--scope', 'tests/**'], { JERRY_HOME: home });

      const latest = jerry(['plan', 'diff', 'jry-0001'], { JERRY_HOME: home });
      expect(latest.exitCode, latest.stderr).toBe(0);
      expect(latest.stdout).toContain('JRY-0001 plan v2 → v3');
      expect(latest.stdout).toContain('    - src/**');
      expect(latest.stdout).not.toContain('+ tests/**');

      const first = jerry(['plan', 'diff', 'JRY-0001', '--from', '1', '--to', '2'], { JERRY_HOME: home });
      expect(first.stdout).toContain('JRY-0001 plan v1 → v2');
      expect(first.stdout).toContain('    + tests/**');

      const wrong = jerry(['plan', 'diff', 'JRY-0001', '--from', '3', '--to', '1'], { JERRY_HOME: home });
      expect(wrong.exitCode).toBe(1);
      expect(wrong.stderr).toContain('--from older --to newer');
    } finally {
      await core.stop();
    }
  });
});
