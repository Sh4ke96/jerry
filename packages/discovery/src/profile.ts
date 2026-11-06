import fs from 'node:fs';
import path from 'node:path';
import type { RepositoryScanResult } from './index.js';

/**
 * Freshness of a stored project profile. The profile is a cache, never the
 * source of truth; changes in the repository invalidate the parts of it they affect. Each part
 * remembers the files it was derived from (size and mtime); a part is stale when one of them
 * changed, appeared or vanished. Checking costs a few stat calls, no walk.
 */

export type ProfilePart = 'stack' | 'docs' | 'instructions' | 'ci' | 'apiSchemas' | 'migrations' | 'layout';

export interface ProfileFingerprints {
  /** Repo-relative path (or directory) → "size:mtime", "dir:mtime" or "missing". */
  files: Record<string, string>;
  /** Which part each fingerprinted path belongs to. */
  parts: Record<string, ProfilePart[]>;
}

/** A profile older than this is refreshed even when no fingerprint changed (new files appear). */
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function stamp(root: string, relative: string): string {
  try {
    const stat = fs.statSync(relative === '' ? root : path.join(root, ...relative.split('/')));
    return stat.isDirectory() ? `dir:${Math.trunc(stat.mtimeMs)}` : `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return 'missing';
  }
}

export function fingerprintScan(root: string, scan: RepositoryScanResult): ProfileFingerprints {
  const parts: Record<string, ProfilePart[]> = {};
  const add = (relative: string, part: ProfilePart): void => {
    const list = parts[relative] ?? [];
    if (!list.includes(part)) list.push(part);
    parts[relative] = list;
  };
  // The root listing changes when top-level files appear or vanish (a new manifest, a README).
  add('', 'layout');
  for (const manifest of scan.manifests) {
    add(manifest.path, 'stack');
    if (manifest.lockfile !== null) add(manifest.lockfile, 'stack');
  }
  for (const doc of scan.docs) add(doc.path, 'docs');
  for (const entry of scan.instructions) add(entry.path, 'instructions');
  for (const entry of [...scan.ci, ...scan.containers]) add(entry.path, 'ci');
  for (const schema of scan.apiSchemas) add(schema.path, 'apiSchemas');
  for (const migration of scan.migrations) add(migration.path, 'migrations');
  for (const directory of ['.claude', '.claude/rules', '.claude/skills', 'docs', '.github/workflows']) add(directory, directory.startsWith('.claude') ? 'instructions' : directory === 'docs' ? 'docs' : 'ci');
  const files = Object.fromEntries(Object.keys(parts).map((relative) => [relative, stamp(root, relative)]));
  return { files, parts };
}

/** Parts whose sources changed since the fingerprints were taken; "age" when the profile is old. */
export function staleParts(root: string, fingerprints: ProfileFingerprints, scannedAt: string, now: Date = new Date()): Array<ProfilePart | 'age'> {
  const stale = new Set<ProfilePart | 'age'>();
  for (const [relative, recorded] of Object.entries(fingerprints.files)) {
    if (stamp(root, relative) !== recorded) for (const part of fingerprints.parts[relative] ?? []) stale.add(part);
  }
  if (now.getTime() - Date.parse(scannedAt) > PROFILE_MAX_AGE_MS) stale.add('age');
  return [...stale].sort();
}
