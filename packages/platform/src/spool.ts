import fs from 'node:fs';
import path from 'node:path';
import type { EventEnvelope } from '@jerry/contracts';
import { writeFileAtomic } from './fs-atomic.js';
import { jerryPaths } from './jerry-home.js';

/** Upper bound on spooled events, so a Core that never comes back cannot fill the disk. */
export const SPOOL_LIMIT = 5000;

export type SpoolResult = 'spooled' | 'paused' | 'full';

/**
 * Keeps an event while Core is unreachable (spec §11.5). One file per event, written atomically,
 * so concurrent hook processes never interleave. Nothing is kept while the user has paused JERRY
 * with "jerry core stop".
 */
export function spoolEvent(home: string, event: EventEnvelope): SpoolResult {
  const paths = jerryPaths(home);
  if (fs.existsSync(paths.autostartDisabledFile)) return 'paused';
  fs.mkdirSync(paths.spoolDir, { recursive: true });
  if (countSpooled(home) >= SPOOL_LIMIT) return 'full';
  writeFileAtomic(path.join(paths.spoolDir, `${event.eventId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`), JSON.stringify(event));
  return 'spooled';
}

export function countSpooled(home: string): number {
  try {
    return fs.readdirSync(jerryPaths(home).spoolDir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

export interface SpooledFile {
  file: string;
  content: string;
}

/** Oldest first (by modification time), at most `limit` files. */
export function readSpool(home: string, limit: number): SpooledFile[] {
  const { spoolDir } = jerryPaths(home);
  let names: string[];
  try {
    names = fs.readdirSync(spoolDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const file = path.join(spoolDir, name);
      try {
        return { file, mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { file: string; mtime: number } => entry !== null)
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, limit)
    .flatMap(({ file }) => {
      try {
        return [{ file, content: fs.readFileSync(file, 'utf8') }];
      } catch {
        return [];
      }
    });
}

/** Moves an unreadable spool file aside so it is not retried forever, but is kept for inspection. */
export function quarantineSpoolFile(home: string, file: string): void {
  const rejected = path.join(jerryPaths(home).spoolDir, 'rejected');
  fs.mkdirSync(rejected, { recursive: true });
  fs.renameSync(file, path.join(rejected, path.basename(file)));
}
