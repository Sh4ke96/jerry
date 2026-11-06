import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertJerryHomeOutsideRepositories } from './home-safety.js';
import type { Env } from './jerry-home.js';
import { jerryPaths } from './jerry-home.js';

/**
 * Fixed default port, so the dashboard keeps one origin and can be installed as an app (PWA).
 * If it is taken by another program, Core falls back to a random port and still guards.
 */
export const DEFAULT_CORE_PORT = 47823;

/** Minimum gap between automatic Core starts, so a crashing Core cannot cause a spawn storm. */
export const AUTOSTART_THROTTLE_MS = 30_000;

/** JERRY_CORE_PORT overrides the default; 0 means "any free port" (used by tests). */
export function resolveCorePort(env: Env = process.env): number {
  const raw = env['JERRY_CORE_PORT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_CORE_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`JERRY_CORE_PORT must be an integer between 0 and 65535, got "${raw}"`);
  }
  return port;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult = { acquired: true; release: () => void } | { acquired: false; heldBy: number };

/**
 * One Core per JERRY_HOME. The lock file holds the owner's PID; a lock whose owner is gone is
 * stale and taken over. Exclusive creation makes concurrent starts (two sessions at once) safe.
 */
export function acquireSingleInstanceLock(lockFile: string): LockResult {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return {
        acquired: true,
        release: () => {
          try {
            if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) fs.rmSync(lockFile, { force: true });
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(lockFile, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && isProcessAlive(holder)) {
        return { acquired: false, heldBy: holder };
      }
      fs.rmSync(lockFile, { force: true }); // stale: owner crashed
    }
  }
  throw new Error(`Could not acquire the JERRY Core lock ${lockFile}`);
}

/**
 * Starts Core as a detached background process with JERRY_HOME as working directory and output
 * appended to logs/core.log. Returns the child PID.
 */
export function spawnDetachedCore(home: string, coreScript: string, env: Env = process.env): number {
  const paths = jerryPaths(home);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  rotateLog(paths.coreLogFile);
  const log = fs.openSync(paths.coreLogFile, 'a');
  try {
    const child = spawn(process.execPath, [coreScript], {
      cwd: home,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
      env: { ...env, JERRY_HOME: home },
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`Failed to start JERRY Core from ${coreScript}`);
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

/** core.log is rotated at start once it exceeds this size; one previous generation is kept. */
export const CORE_LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateLog(file: string): void {
  try {
    if (fs.statSync(file).size > CORE_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // no log yet, or another start rotated it first
  }
}

/**
 * Automatic start used by the hooks. Only the installed runtime copy is started, and at most
 * once per AUTOSTART_THROTTLE_MS.
 *   started      a Core process was spawned
 *   throttled    a start was attempted recently; it may still be coming up
 *   unavailable  no installed runtime copy (e.g. a --plugin-dir development session), or the
 *                user stopped Core with "jerry core stop"
 */
export function autostartCore(home: string, now: number = Date.now()): 'started' | 'throttled' | 'unavailable' {
  const paths = jerryPaths(home);
  if (!fs.existsSync(paths.runtimeCoreFile) || fs.existsSync(paths.autostartDisabledFile)) return 'unavailable';
  try {
    const last = Number(fs.readFileSync(paths.autostartStampFile, 'utf8'));
    if (Number.isFinite(last) && now - last < AUTOSTART_THROTTLE_MS) return 'throttled';
  } catch {
    // no previous attempt
  }
  assertJerryHomeOutsideRepositories(home);
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(paths.autostartStampFile, String(now));
  spawnDetachedCore(home, paths.runtimeCoreFile);
  return 'started';
}
