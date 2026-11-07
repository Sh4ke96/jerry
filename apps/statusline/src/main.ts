import fs from 'node:fs';
// Dependency-free modules only: Claude Code runs this on every status-line refresh and cancels a run
// that is still going when the next one starts, so it must start fast (the build checks for Zod).
import { emojiEnabled } from '@jerry/contracts/emoji';
import {
  readCoreRuntimeInfo,
  readProjectsFile,
  readStatuslineConfig,
  requestCore,
  resolveJerryHome,
  spoolUsageSnapshot,
  writeStatuslineLast,
  type UsageSnapshot,
} from '@jerry/platform';
import { comparablePath, isComparableInside } from '@jerry/policy-engine';
import { CHAINED_ENV, runChained } from './chain.js';
import { formatSegment, hasRateLimits, MAX_INPUT_BYTES, parseStatusInput } from './snapshot.js';

/**
 * JERRY's Claude Code status line ("statusLine" in the user's settings.json, set by
 * "jerry statusline enable" and "jerry install").
 *
 *   1. Reads the session JSON Claude Code passes on stdin (never the transcript it points to).
 *   2. Inside a project the user added (JERRY_HOME/run/projects.json; without that file every
 *      directory counts), sends the plan-usage snapshot to Core, or spools it when Core cannot
 *      take it. Elsewhere no usage numbers are kept.
 *   3. Always records that it ran, and in which client (JERRY_HOME/run/statusline-last.json).
 *   4. Prints the user's previous status line (if JERRY's replaced one), then JERRY's segment.
 *
 * It never fails: whatever goes wrong, it prints JERRY's segment and exits 0.
 */

const CORE_TIMEOUT_MS = 300;
const CHAIN_TIMEOUT_MS = 1000;
const WATCHDOG_MS = 2500;
/** Body: { snapshots: UsageSnapshot[] }. */
const USAGE_SNAPSHOTS_PATH = '/api/v1/usage/snapshots';

let printed = false;

/** Synchronous fd write: process.stdout can be an asynchronous pipe on Windows and lose data on exit. */
function finish(lines: readonly string[]): never {
  if (!printed) {
    printed = true;
    try {
      fs.writeSync(1, `${lines.filter((line) => line !== '').join('\n')}\n`);
    } catch {
      // Nothing left to tell anyone.
    }
  }
  process.exit(0);
}

function fallback(): never {
  finish([formatSegment(null, emojiEnabled())]);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) return '';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** False only when projects.json lists the projects and the directory lies in none of them. */
function insideProjects(home: string, cwd: string | null): boolean {
  const roots = readProjectsFile(home);
  if (roots === null) return true;
  if (cwd === null) return false;
  const keys = roots.map((root) => comparablePath(root, root, process.platform));
  const inside = (candidate: string): boolean => {
    const key = comparablePath(candidate, candidate, process.platform);
    return keys.some((root) => isComparableInside(key, root));
  };
  if (inside(cwd)) return true;
  try {
    // Reached through a link or junction: judged by where it really is.
    return inside(fs.realpathSync.native(cwd));
  } catch {
    return false;
  }
}

/** Sends the snapshot to Core; on any failure (Core down, no such route yet, timeout) it is spooled. */
async function report(home: string, snapshot: UsageSnapshot): Promise<void> {
  if (!insideProjects(home, snapshot.cwd)) return;
  try {
    const info = readCoreRuntimeInfo(home);
    await requestCore(info, { method: 'POST', path: USAGE_SNAPSHOTS_PATH, body: { snapshots: [snapshot] }, timeoutMs: CORE_TIMEOUT_MS });
  } catch {
    try {
      spoolUsageSnapshot(home, snapshot);
    } catch {
      // Losing one snapshot never matters; the next refresh brings a newer one.
    }
  }
}

function recordSighting(home: string, entrypoint: string | null, snapshot: UsageSnapshot | null, at: Date): void {
  try {
    writeStatuslineLast(home, entrypoint, { at: at.toISOString(), sessionId: snapshot?.sessionId ?? null, version: snapshot?.version ?? null, hasRateLimits: hasRateLimits(snapshot) });
  } catch {
    // Only "jerry statusline status" reads it.
  }
}

/** The user's previous status line, if JERRY's replaced one (never JERRY's own, never recursively). */
function previousCommand(home: string): string | null {
  if (process.env[CHAINED_ENV] === '1') return null;
  const command = readStatuslineConfig(home)?.previous?.['command'];
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

async function main(): Promise<void> {
  setTimeout(fallback, WATCHDOG_MS).unref();
  const raw = await readStdin().catch(() => '');
  const now = new Date();
  const entrypoint = process.env['CLAUDE_CODE_ENTRYPOINT'] ?? null;
  const snapshot = parseStatusInput(raw, entrypoint, now);
  let home: string | null = null;
  try {
    home = resolveJerryHome();
  } catch {
    // No JERRY home: show the segment only.
  }
  const previous = home === null ? null : previousCommand(home);
  // The previous status line runs while the snapshot goes to Core.
  const chained = previous === null ? Promise.resolve('') : runChained(previous, raw, CHAIN_TIMEOUT_MS);
  // Claude Code always sends a session ID; input without one is not worth keeping.
  const reported = home === null || snapshot === null || snapshot.sessionId === null ? Promise.resolve() : report(home, snapshot);
  if (home !== null) recordSighting(home, entrypoint, snapshot, now);
  const [previousOutput] = await Promise.all([chained, reported.catch(() => undefined)]);
  finish([previousOutput, formatSegment(snapshot, emojiEnabled())]);
}

process.on('uncaughtException', fallback);
process.on('unhandledRejection', fallback);
main().catch(fallback);
