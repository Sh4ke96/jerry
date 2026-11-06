import fs from 'node:fs';
import path from 'node:path';

/**
 * ADR 0002: JERRY never writes to, or deletes from, any repository. JERRY_HOME is the only place
 * JERRY writes, so it must not lie inside a Git working tree. Called before anything is created.
 */
export function assertJerryHomeOutsideRepositories(home: string): void {
  let current = path.resolve(home);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(
        `JERRY_HOME (${home}) is inside the Git repository ${current}. JERRY never writes into repositories; set JERRY_HOME to a directory outside any repository.`,
      );
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Every top-level entry JERRY creates in JERRY_HOME. Purge removes exactly these, never anything else. */
export const JERRY_HOME_ENTRIES = ['run', 'state', 'logs', 'config', 'marketplace'] as const;
