import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read-only Git access for Core (ADR 0017). JERRY never modifies a repository (ADR 0002), and that
 * includes `.git`: every call runs with `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`, so even
 * `git status` does not refresh the index; fsmonitor is off, so no user hook runs; only commands
 * that read are used. Commands run without a shell.
 */

export interface GitSnapshot {
  /** Commit ID, or null in a repository without commits. */
  head: string | null;
  /** Branch name, or null when HEAD is detached. */
  branch: string | null;
  upstream: string | null;
  /** origin's URL without credentials, or null. */
  remoteUrl: string | null;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** The status listing was cut at MAX_STATUS_ENTRIES. */
  truncated: boolean;
}

export interface GitReader {
  snapshot(repoRoot: string): Promise<GitSnapshot>;
  /** Repo-relative files that differ from `baseHead` (working tree and index), plus untracked files. */
  changedSince(repoRoot: string, baseHead: string | null): Promise<string[]>;
  /**
   * Zero-context diff of one repo-relative file against HEAD (ADR 0029), or null when there is
   * nothing to compare with (untracked file, no commit yet). External diff drivers and textconv
   * filters are switched off: JERRY never runs programs the repository configures.
   */
  fileDiff(repoRoot: string, file: string): Promise<string | null>;
}

const MAX_STATUS_ENTRIES = 5000;
const TIMEOUT_MS = 4000;
const GIT_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];

export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitUnavailableError';
  }
}

function git(repoRoot: string, args: readonly string[], timeoutMs = TIMEOUT_MS): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_ARGS, '-C', repoRoot, ...args],
      {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ code: 0, stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (code === 'ENOENT') reject(new GitUnavailableError('git is not installed or not on PATH'));
        else if (typeof code === 'number') resolve({ code, stdout });
        else reject(new GitUnavailableError(`git did not answer (${error.message})`));
      },
    );
  });
}

/** Removes user:password@ from URLs, so a token in a remote never reaches JERRY's data. */
export function stripCredentials(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** Parses `git status --porcelain=v1 -z`. */
export function parseStatus(output: string): { staged: string[]; unstaged: string[]; untracked: string[]; truncated: boolean } {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const entries = output.split('\0').filter((entry) => entry.length > 3);
  for (const entry of entries.slice(0, MAX_STATUS_ENTRIES)) {
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === '?' && y === '?') {
      untracked.push(file);
      continue;
    }
    if (x !== ' ' && x !== '!') staged.push(file);
    if (y !== ' ' && y !== '!') unstaged.push(file);
  }
  return { staged, unstaged, untracked, truncated: entries.length > MAX_STATUS_ENTRIES };
}

export const gitReader: GitReader = {
  async snapshot(repoRoot) {
    const [head, branch, upstream, remote, status] = await Promise.all([
      git(repoRoot, ['rev-parse', '-q', '--verify', 'HEAD']),
      git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD']),
      git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
      git(repoRoot, ['config', '--get', 'remote.origin.url']),
      git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
    ]);
    if (status.code !== 0) throw new GitUnavailableError(`git status failed in ${repoRoot}`);
    return {
      head: head.code === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : null,
      branch: branch.code === 0 && branch.stdout.trim() !== '' ? branch.stdout.trim() : null,
      upstream: upstream.code === 0 && upstream.stdout.trim() !== '' ? upstream.stdout.trim() : null,
      remoteUrl: remote.code === 0 && remote.stdout.trim() !== '' ? stripCredentials(remote.stdout) : null,
      ...parseStatus(status.stdout),
    };
  },

  async changedSince(repoRoot, baseHead) {
    const status = await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    if (status.code !== 0) throw new GitUnavailableError(`git status failed in ${repoRoot}`);
    const parsed = parseStatus(status.stdout);
    const changed = new Set<string>([...parsed.staged, ...parsed.unstaged, ...parsed.untracked]);
    if (baseHead !== null) {
      const diff = await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', baseHead, '--']);
      if (diff.code === 0) for (const file of diff.stdout.split('\0')) if (file !== '') changed.add(file);
    }
    return [...changed].sort();
  },

  async fileDiff(repoRoot, file) {
    const diff = await git(repoRoot, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', file]);
    if (diff.code !== 0) return null;
    if (diff.stdout.trim() !== '') return diff.stdout;
    // No difference: a tracked, unchanged file, or an untracked one (diff does not show those).
    const tracked = await git(repoRoot, ['ls-files', '--error-unmatch', '--', file]);
    return tracked.code === 0 ? '' : null;
  },
};

/** Content hashes of repo-relative files ("missing" for deleted ones); read with plain file reads. */
export function fingerprintFiles(repoRoot: string, files: readonly string[], maxBytes = 8 * 1024 * 1024): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) continue;
      result[file] = stat.size > maxBytes ? `size:${stat.size}:${stat.mtimeMs}` : createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    } catch {
      result[file] = 'missing';
    }
  }
  return result;
}
