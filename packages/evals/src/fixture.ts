import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EvalCase } from './case.js';

/**
 * Fixture repositories (ADR 0036): created from a case under the system temp directory, never inside
 * a real project, and removed afterwards. Git here belongs to the eval harness's own throwaway
 * repository, not to the user's.
 */

const IDENTITY = ['-c', 'user.name=JERRY Eval', '-c', 'user.email=jerry-eval@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

export interface Fixture {
  /** The run's own directory: fixture repository, JERRY home and logs live below it. */
  base: string;
  repo: string;
  initialHead: string;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, '-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function writeAll(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.resolve(root, relative);
    // The schema already refuses absolute paths and "..": this is the second line of defence.
    if (!target.startsWith(root + path.sep)) throw new Error(`fixture path ${relative} leaves the fixture`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** Creates the fixture repository: committed files, then the user's uncommitted changes. */
export function createFixture(evalCase: EvalCase, parent: string = os.tmpdir()): Fixture {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, `jerry-eval-${evalCase.id}-`)));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  writeAll(repo, Object.keys(evalCase.fixture.files).length === 0 ? { 'README.md': `# ${evalCase.title}\n` } : evalCase.fixture.files);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
  writeAll(repo, evalCase.fixture.uncommitted);
  return { base, repo, initialHead: git(repo, 'rev-parse', 'HEAD') };
}

/** Files changed since the fixture's commit, including untracked ones (read-only Git). */
export function changedFiles(fixture: Fixture): string[] {
  const output = execFileSync('git', ['--no-optional-locks', '-C', fixture.repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true });
  return output
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .sort();
}

export function gitState(fixture: Fixture): { head: string; staged: boolean } {
  const head = execFileSync('git', ['--no-optional-locks', '-C', fixture.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  const staged = execFileSync('git', ['--no-optional-locks', '-C', fixture.repo, 'diff', '--cached', '--name-only'], { encoding: 'utf8', windowsHide: true }).trim() !== '';
  return { head, staged };
}

export function removeFixture(fixture: Fixture): void {
  fs.rmSync(fixture.base, { recursive: true, force: true, maxRetries: 3 });
}
