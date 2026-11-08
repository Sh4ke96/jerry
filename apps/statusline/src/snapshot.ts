import { decorate, EMOJI } from '@jerry/contracts/emoji';
import type { UsageSnapshot, UsageWindow } from '@jerry/platform';

/**
 * Reads the JSON Claude Code passes to a status-line command and turns it into JERRY's usage
 * snapshot. Pure and defensive: every field may be missing or of the wrong type (rate_limits only
 * for Pro/Max plans and only after the first API response; each window on its own).
 */

/** Input larger than this is not a status-line payload; it is not parsed. */
export const MAX_INPUT_BYTES = 1024 * 1024;

type Fields = Record<string, unknown>;

/** effort.level values Claude Code documents for the status line. */
const EFFORT_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function record(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Epoch seconds to ISO 8601; null when absent or not a plausible time. */
function epochSecondsToIso(value: unknown): string | null {
  const seconds = finiteNumber(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function usageWindow(value: unknown): UsageWindow | undefined {
  const fields = record(value);
  const pct = finiteNumber(fields?.['used_percentage']);
  if (fields === null || pct === null) return undefined;
  return { pct, resetsAt: epochSecondsToIso(fields['resets_at']) };
}

/** The snapshot, or null when the input is not a JSON object. */
export function parseStatusInput(raw: string, entrypoint: string | null, now: Date): UsageSnapshot | null {
  if (raw.length === 0 || raw.length > MAX_INPUT_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const input = record(parsed);
  if (input === null) return null;

  const model = record(input['model']);
  const workspace = record(input['workspace']);
  const cost = record(input['cost']);
  const context = record(input['context_window']);
  const limits = record(input['rate_limits']);

  const snapshot: UsageSnapshot = {
    sessionId: text(input['session_id']),
    cwd: text(input['cwd']) ?? text(workspace?.['current_dir']),
    model: text(model?.['display_name']) ?? text(model?.['id']),
    version: text(input['version']),
    entrypoint,
    at: now.toISOString(),
  };
  // The session's level; absent when the model does not support effort. Known values only.
  const effort = text(record(input['effort'])?.['level']);
  if (effort !== null && EFFORT_LEVELS.has(effort)) snapshot.effort = effort;
  const fiveHour = usageWindow(limits?.['five_hour']);
  const sevenDay = usageWindow(limits?.['seven_day']);
  if (fiveHour !== undefined) snapshot.fiveHour = fiveHour;
  if (sevenDay !== undefined) snapshot.sevenDay = sevenDay;
  const costUsd = finiteNumber(cost?.['total_cost_usd']);
  if (costUsd !== null) snapshot.costUsd = costUsd;
  const inputTokens = finiteNumber(context?.['total_input_tokens']);
  if (inputTokens !== null) snapshot.inputTokens = inputTokens;
  const outputTokens = finiteNumber(context?.['total_output_tokens']);
  if (outputTokens !== null) snapshot.outputTokens = outputTokens;
  const contextUsedPct = finiteNumber(context?.['used_percentage']);
  if (contextUsedPct !== null) snapshot.contextUsedPct = contextUsedPct;
  return snapshot;
}

/** True when Claude Code reported at least one plan-usage window. */
export function hasRateLimits(snapshot: UsageSnapshot | null): boolean {
  return snapshot?.fiveHour !== undefined || snapshot?.sevenDay !== undefined;
}

/**
 * JERRY's segment of the status line: "🛡️ JERRY · Opus · high · 5h 23% · week 41% · $1.20": the
 * session's model and effort, the account's plan limits, and this session's estimated cost at list
 * price. Absent parts are left out.
 */
export function formatSegment(snapshot: UsageSnapshot | null, emoji: boolean): string {
  const parts = [decorate(EMOJI.jerry, 'JERRY', emoji)];
  if (snapshot?.model != null) parts.push(snapshot.model.replace(/^Claude\s+/i, ''));
  if (snapshot?.effort !== undefined) parts.push(snapshot.effort);
  if (snapshot?.fiveHour !== undefined) parts.push(`5h ${Math.round(snapshot.fiveHour.pct)}%`);
  if (snapshot?.sevenDay !== undefined) parts.push(`week ${Math.round(snapshot.sevenDay.pct)}%`);
  if (snapshot?.costUsd !== undefined) parts.push(`$${snapshot.costUsd.toFixed(2)}`);
  return parts.join(' · ');
}
