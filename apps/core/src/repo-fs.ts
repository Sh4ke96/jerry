import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves symlinks and junctions of the nearest existing ancestor, so a write through a
 * link is judged by where it really lands. Missing trailing segments are appended as-is.
 */
export function realPathOfNearestExisting(target: string): string {
  const missingSegments: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const resolved = fs.realpathSync.native(current);
      return missingSegments.length === 0 ? resolved : path.join(resolved, ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/** Nearest ancestor (inclusive) that contains a ".git" entry (directory, or file for worktrees/submodules). */
export function findGitRoot(target: string): string | null {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
