import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * appended to logs/core.log, after a line saying who started it. Returns the child PID.
 */
export function spawnDetachedCore(home: string, coreScript: string, env: Env = process.env, startedBy = 'unknown starter'): number {
  const paths = jerryPaths(home);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  rotateLog(paths.coreLogFile);
  const log = fs.openSync(paths.coreLogFile, 'a');
  try {
    fs.writeSync(log, `${new Date().toISOString()} starting JERRY Core (${startedBy}, from pid ${process.pid})\n`);
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

/**
 * Identifies a Core build by its bundle file: Core reports it in its status, and doctor compares it
 * with the installed runtime and the CLI's own build to spot a Core that needs a restart.
 */
export function buildHash(coreScript: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(coreScript)).digest('hex').slice(0, 12);
  } catch {
    return null;
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
  spawnDetachedCore(home, paths.runtimeCoreFile, process.env, 'automatic start by a Claude Code hook or JERRY MCP server');
  return 'started';
}

/** Core's heartbeat in run/core-alive.json: written at start and every minute, removed on a clean stop. */
export interface CoreHeartbeat {
  pid: number;
  version: string;
  startedAt: string;
  aliveAt: string;
}

/** The heartbeat a Core left behind, or null when there is none or it is unreadable. */
export function readCoreHeartbeat(file: string): CoreHeartbeat | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CoreHeartbeat>;
    if (!Number.isInteger(value.pid) || typeof value.startedAt !== 'string' || typeof value.aliveAt !== 'string') return null;
    return { pid: value.pid!, version: typeof value.version === 'string' ? value.version : 'unknown', startedAt: value.startedAt, aliveAt: value.aliveAt };
  } catch {
    return null;
  }
}

/**
 * What a new Core logs about the previous one: a heartbeat it left behind means it never stopped
 * cleanly (a clean stop removes it). Null when there is nothing to say: no heartbeat, our own, or
 * one of a Core that is still alive.
 */
export function describeUncleanEnd(previous: CoreHeartbeat | null, ownPid: number, alive: (pid: number) => boolean = isProcessAlive): string | null {
  if (previous === null || previous.pid === ownPid || alive(previous.pid)) return null;
  return (
    `the previous JERRY Core (pid ${previous.pid}, ${previous.version}, started ${previous.startedAt}, last seen alive ${previous.aliveAt}) ended without a clean stop: ` +
    'something outside JERRY ended it (Task Manager, taskkill, the process tree that started it closing, a Windows restart or sign-out) or it crashed natively. ' +
    'For a native crash see Windows Event Viewer, Windows Logs > Application, entries for node.exe.'
  );
}
