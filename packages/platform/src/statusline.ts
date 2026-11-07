import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-atomic.js';
import { jerryPaths } from './jerry-home.js';

/**
 * Files shared by JERRY's Claude Code status-line script, the CLI ("jerry statusline …") and Core.
 * Dependency-free: the script runs on every status-line refresh and must start fast.
 */

/** One plan-usage window as Claude Code reports it (rate_limits.five_hour / seven_day). */
export interface UsageWindow {
  /** Share of the window used, in percent (0-100). */
  pct: number;
  /** When the window resets (ISO 8601), or null when Claude Code did not say. */
  resetsAt: string | null;
}

/**
 * What the status-line script reports to Core (POST /api/v1/usage/snapshots, body: one snapshot)
 * or appends to JERRY_HOME/spool/usage.jsonl (one snapshot per line) when Core cannot take it.
 * Optional fields are absent when Claude Code did not provide them.
 */
export interface UsageSnapshot {
  sessionId: string | null;
  cwd: string | null;
  /** The model's display name, else its ID. */
  model: string | null;
  /** Claude Code version. */
  version: string | null;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextUsedPct?: number;
  /** CLAUDE_CODE_ENTRYPOINT of the session, e.g. "cli" or "claude-vscode". */
  entrypoint: string | null;
  /** When the script saw it (ISO 8601). */
  at: string;
}

/** A Claude Code "statusLine" setting, kept as the user wrote it. */
export type StatusLineSetting = Record<string, unknown>;

/** JERRY_HOME/config/statusline.json: written when JERRY's status line is turned on. */
export interface StatuslineConfig {
  /** The status line Claude Code had before JERRY's (run first and shown above JERRY's), or null. */
  previous: StatusLineSetting | null;
  enabledAt: string;
}

/** What the script saw last from one kind of Claude Code client. Never any usage numbers. */
export interface StatuslineSighting {
  at: string;
  sessionId: string | null;
  version: string | null;
  hasRateLimits: boolean;
}

/** JERRY_HOME/run/statusline-last.json: the latest sighting, and the latest one per entrypoint. */
export interface StatuslineLast extends StatuslineSighting {
  entrypoint: string | null;
  byEntrypoint: Record<string, StatuslineSighting>;
}

/** Entrypoints remembered in statusline-last.json; older ones drop out. */
const MAX_ENTRYPOINTS = 10;
/** Upper bound on the usage spool, so a Core that never comes back cannot fill the disk. */
export const USAGE_SPOOL_MAX_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The saved configuration, or null when JERRY's status line was never turned on (or the file is unreadable). */
export function readStatuslineConfig(home: string): StatuslineConfig | null {
  const parsed = readJson(jerryPaths(home).statuslineConfigFile);
  if (!isRecord(parsed) || typeof parsed['enabledAt'] !== 'string') return null;
  const previous = parsed['previous'];
  return { previous: isRecord(previous) ? previous : null, enabledAt: parsed['enabledAt'] };
}

export function writeStatuslineConfig(home: string, config: StatuslineConfig): void {
  writeFileAtomic(jerryPaths(home).statuslineConfigFile, `${JSON.stringify(config, null, 2)}\n`);
}

function readSighting(value: unknown): StatuslineSighting | null {
  if (!isRecord(value) || typeof value['at'] !== 'string') return null;
  const text = (field: string): string | null => (typeof value[field] === 'string' ? (value[field] as string) : null);
  return { at: value['at'], sessionId: text('sessionId'), version: text('version'), hasRateLimits: value['hasRateLimits'] === true };
}

export function readStatuslineLast(home: string): StatuslineLast | null {
  const parsed = readJson(jerryPaths(home).statuslineLastFile);
  const latest = readSighting(parsed);
  if (latest === null || !isRecord(parsed)) return null;
  const byEntrypoint: Record<string, StatuslineSighting> = {};
  if (isRecord(parsed['byEntrypoint'])) {
    for (const [entrypoint, value] of Object.entries(parsed['byEntrypoint'])) {
      const sighting = readSighting(value);
      if (sighting !== null) byEntrypoint[entrypoint] = sighting;
    }
  }
  return { ...latest, entrypoint: typeof parsed['entrypoint'] === 'string' ? parsed['entrypoint'] : null, byEntrypoint };
}

/** Records a sighting atomically, keeping the latest one per entrypoint ("unknown" without one). */
export function writeStatuslineLast(home: string, entrypoint: string | null, sighting: StatuslineSighting): void {
  const previous = readStatuslineLast(home)?.byEntrypoint ?? {};
  const merged = Object.entries({ ...previous, [entrypoint ?? 'unknown']: sighting })
    .sort(([, a], [, b]) => b.at.localeCompare(a.at))
    .slice(0, MAX_ENTRYPOINTS);
  const content: StatuslineLast = { ...sighting, entrypoint, byEntrypoint: Object.fromEntries(merged) };
  writeFileAtomic(jerryPaths(home).statuslineLastFile, `${JSON.stringify(content, null, 2)}\n`);
}

export type UsageSpoolResult = 'spooled' | 'paused' | 'full';

/**
 * Keeps a snapshot Core could not take: one JSON line, appended in a single write. Nothing is kept
 * while the user has paused JERRY with "jerry core stop", or once the spool reached its size limit.
 */
export function spoolUsageSnapshot(home: string, snapshot: UsageSnapshot): UsageSpoolResult {
  const paths = jerryPaths(home);
  if (fs.existsSync(paths.autostartDisabledFile)) return 'paused';
  fs.mkdirSync(path.dirname(paths.usageSpoolFile), { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(paths.usageSpoolFile).size;
  } catch {
    // no spool yet
  }
  if (size >= USAGE_SPOOL_MAX_BYTES) return 'full';
  fs.appendFileSync(paths.usageSpoolFile, `${JSON.stringify(snapshot)}\n`, 'utf8');
  return 'spooled';
}
