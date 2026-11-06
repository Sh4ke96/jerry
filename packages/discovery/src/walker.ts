import fs from 'node:fs';
import path from 'node:path';

/**
 * Bounded, read-only walk of a repository (ADR 0018). It lists files; it never opens them, never
 * follows links, and never descends into dependency, build or VCS directories. Discovery is
 * about what the project is, not about every byte it contains.
 */

/** Directory names never entered: VCS data, dependencies, build output, caches, IDE state. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'obj',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.gradle',
  '.idea',
  '.vs',
  '.vscode-test',
  '.terraform',
]);

export interface WalkedFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** The walk stopped at a limit; detections may be incomplete. */
  truncated: boolean;
  /** Skipped directories that were present (repo-relative). */
  skipped: string[];
}

export interface WalkOptions {
  maxFiles?: number;
  maxDepth?: number;
}

export function walkRepository(root: string, options: WalkOptions = {}): WalkResult {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxDepth = options.maxDepth ?? 12;
  const files: WalkedFile[] = [];
  const skipped: string[] = [];
  let truncated = false;

  const visit = (directory: string, relative: string, depth: number): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      // Links are never followed: they could lead outside the repository or loop.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          skipped.push(childRelative);
          continue;
        }
        if (depth >= maxDepth) {
          truncated = true;
          continue;
        }
        visit(path.join(directory, entry.name), childRelative, depth + 1);
        if (truncated) return;
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        try {
          const stat = fs.statSync(path.join(directory, entry.name));
          files.push({ path: childRelative, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };

  visit(root, '', 0);
  return { files, truncated, skipped };
}

/** Reads a small text file of the repository; null when missing, too large or unreadable. */
export function readSmallFile(root: string, relative: string, maxBytes = 1024 * 1024): string | null {
  try {
    const full = path.join(root, ...relative.split('/'));
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}
