/**
 * Claude Code usage as Core reports it (GET /api/v1/usage): the last known plan limits, tokens and
 * estimated cost. Read defensively: every field an older or partial answer lacks gets an empty
 * default, so the views render less, never nothing. The types are the contract's (usageSummarySchema).
 */

import type { UsageCollection, UsageSummary, UsageTotals } from '@jerry/contracts';

export type { UsageCollection, UsageSummary, UsageTotals };

/** When a source last delivered, overall and per entrypoint ("cli", "claude-vscode", …). */
export type UsageSource = UsageSummary['sources']['statusline'];

/** The last known reading of one plan window. */
export type UsageLimit = NonNullable<UsageSummary['limits']['fiveHour']>;

/** Tokens and estimated cost of one row (a model, a project, a day…). */
export interface UsageShare {
  tokens: number;
  costUsd: number;
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : {};
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function readSource(value: unknown): UsageSource {
  const raw = record(value);
  const byEntrypoint: Record<string, string> = {};
  for (const [entrypoint, at] of Object.entries(record(raw['byEntrypoint']))) if (typeof at === 'string') byEntrypoint[entrypoint] = at;
  return { lastAt: text(raw['lastAt']), byEntrypoint };
}

function readLimit(value: unknown): UsageLimit | null {
  const raw = record(value);
  const readAt = text(raw['readAt']);
  if (typeof raw['pct'] !== 'number' || !Number.isFinite(raw['pct']) || readAt === null) return null;
  return { pct: Math.min(100, Math.max(0, raw['pct'])), resetsAt: text(raw['resetsAt']), readAt, entrypoint: text(raw['entrypoint']) };
}

function readTotals(value: unknown): UsageTotals {
  const raw = record(value);
  return { input: count(raw['input']), output: count(raw['output']), cacheRead: count(raw['cacheRead']), cacheCreation: count(raw['cacheCreation']), tokens: count(raw['tokens']), costUsd: count(raw['costUsd']) };
}

function share(raw: Raw): UsageShare {
  return { tokens: count(raw['tokens']), costUsd: count(raw['costUsd']) };
}

/** The usage summary from Core's raw answer, with defaults for whatever is missing. */
export function readUsage(value: unknown): UsageSummary {
  const raw = record(value);
  const collection = record(raw['collection']);
  const sources = record(raw['sources']);
  const limits = record(raw['limits']);
  const totals = record(raw['totals']);
  const jerry = record(raw['jerryShare']);
  return {
    collection: readCollection(collection),
    sources: { statusline: readSource(sources['statusline']), telemetry: readSource(sources['telemetry']) },
    limits: { fiveHour: readLimit(limits['fiveHour']), sevenDay: readLimit(limits['sevenDay']) },
    totals: { today: readTotals(totals['today']), last7d: readTotals(totals['last7d']), last30d: readTotals(totals['last30d']) },
    byModel: list(raw['byModel']).map((item) => ({ model: text(item['model']) ?? 'unknown', ...share(item) })),
    byProject: list(raw['byProject']).map((item) => {
      const repoRoot = text(item['repoRoot']) ?? '';
      return { repoRoot, name: text(item['name']) ?? (repoRoot === '' ? 'other' : repoRoot), ...share(item) };
    }),
    byEntrypoint: list(raw['byEntrypoint']).map((item) => ({ entrypoint: text(item['entrypoint']) ?? 'unknown', ...share(item) })),
    daily: list(raw['daily'])
      .filter((item) => typeof item['date'] === 'string')
      .map((item) => ({ date: item['date'] as string, ...share(item) })),
    jerryShare: { chars30d: count(jerry['chars30d']), estimatedTokens30d: count(jerry['estimatedTokens30d']), sessionStart: count(jerry['sessionStart']), warnings: count(jerry['warnings']), mcp: count(jerry['mcp']) },
  };
}

/** The collection status from Core's raw answer (also the answer of POST /api/v1/usage/collection). */
export function readCollection(value: unknown): UsageCollection {
  const raw = record(value);
  const statusline = raw['statusline'];
  const telemetry = raw['telemetry'];
  return {
    statusline: statusline === 'on' || statusline === 'not-jerry' ? statusline : 'off',
    telemetry: telemetry === 'on' || telemetry === 'clash' ? telemetry : 'off',
    showBar: raw['showBar'] !== false,
  };
}

/** What Core could not change when turning collection on or off (e.g. a telemetry clash). */
export function readProblems(value: unknown): string[] {
  const problems = record(value)['problems'];
  return Array.isArray(problems) ? problems.filter((problem): problem is string => typeof problem === 'string' && problem !== '') : [];
}

/** JERRY collects something: the status line or telemetry is its own. */
export function collecting(collection: UsageCollection): boolean {
  return collection.statusline === 'on' || collection.telemetry === 'on';
}

/** Nothing arrived yet: no tokens in 30 days and no plan limit. */
export function hasNoData(usage: UsageSummary): boolean {
  return usage.totals.last30d.tokens === 0 && usage.limits.fiveHour === null && usage.limits.sevenDay === null && usage.sources.statusline.lastAt === null && usage.sources.telemetry.lastAt === null;
}

// ---------------------------------------------------------------------------------------------
// Words and numbers

const ENTRYPOINT_LABEL: Record<string, string> = { 'claude-vscode': 'VS Code', cli: 'Terminal' };

/** Where Claude Code ran, in words: "VS Code", "Terminal", or the entrypoint as Claude Code names it. */
export function entrypointLabel(entrypoint: string | null): string {
  if (entrypoint === null) return 'unknown';
  return ENTRYPOINT_LABEL[entrypoint] ?? entrypoint;
}

/** "from a terminal session", "from the VS Code extension"… */
export function sourcePhrase(entrypoint: string | null): string {
  if (entrypoint === 'cli') return 'from a terminal session';
  if (entrypoint === 'claude-vscode') return 'from the VS Code extension';
  return entrypoint === null ? 'from a Claude Code session' : `from ${entrypoint}`;
}

export const LIMITS_NOTE = 'Plan limits come from terminal sessions; the VS Code extension does not pass them.';

export type LimitTone = 'normal' | 'warn' | 'critical';

/** Amber from 80 %, destructive from 95 %. */
export function limitTone(pct: number): LimitTone {
  if (pct >= 95) return 'critical';
  if (pct >= 80) return 'warn';
  return 'normal';
}

/** Classes of a limit bar's track and fill, and of its percent label, by tone. */
export const TONE_CLASSES: Record<LimitTone, { track: string; fill: string; text: string }> = {
  normal: { track: 'bg-primary/20', fill: 'fill-primary', text: '' },
  warn: { track: 'bg-amber-500/20', fill: 'fill-amber-500', text: 'text-amber-700 dark:text-amber-400' },
  critical: { track: 'bg-destructive/20', fill: 'fill-destructive', text: 'text-destructive' },
};

export function percent(pct: number): string {
  return `${Math.round(pct)}%`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (value: number): string => String(value).padStart(2, '0');

/** "14:02" today, "Mon 14:02" within a week, else "2026-10-30 14:02" (local time). */
export function clockTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return time;
  if (Math.abs(date.getTime() - now.getTime()) < 6.5 * 24 * 3600 * 1000) return `${WEEKDAYS[date.getDay()]} ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** "resets in 2 h 14 min" within a day, "resets Mon 09:00" later; "reset at 09:00, after it was read" once passed. */
export function resetText(resetsAt: string | null, now = new Date()): string {
  if (resetsAt === null) return 'reset time unknown';
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return 'reset time unknown';
  const minutes = Math.ceil((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return `reset at ${clockTime(resetsAt, now)}, after it was read`;
  if (minutes < 60) return `resets in ${minutes} min`;
  if (minutes < 24 * 60) return `resets in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `resets ${clockTime(resetsAt, now)}`;
}

/** The window has reset since the value was read: the percent is history, not the current use. */
export function limitExpired(limit: UsageLimit, now = new Date()): boolean {
  return limit.resetsAt !== null && new Date(limit.resetsAt).getTime() <= now.getTime();
}

/** A reading older than this is shown muted as stale: the percent may have moved since. */
export const STALE_AFTER_MINUTES = 30;

/** Whole minutes since the limit was read (0 for a reading from the future or an unreadable time). */
export function minutesSinceRead(limit: UsageLimit, now = new Date()): number {
  const read = new Date(limit.readAt).getTime();
  return Number.isNaN(read) ? 0 : Math.max(0, Math.floor((now.getTime() - read) / 60_000));
}

/** The reading is older than STALE_AFTER_MINUTES. */
export function limitStale(limit: UsageLimit, now = new Date()): boolean {
  return minutesSinceRead(limit, now) > STALE_AFTER_MINUTES;
}

/** "stale · 43 min", "stale · 2 h 5 min", "stale · 3 d" */
export function staleText(limit: UsageLimit, now = new Date()): string {
  const minutes = minutesSinceRead(limit, now);
  if (minutes < 60) return `stale · ${minutes} min`;
  if (minutes < 24 * 60) return `stale · ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `stale · ${Math.floor(minutes / (24 * 60))} d`;
}

/** How the user gets a fresh reading: plan limits come only through the status line of a terminal session. */
export const REFRESH_HINT = 'To refresh, send a message in Claude Code running in a terminal: the VS Code terminal (setting claudeCode.useTerminal) or any other terminal session.';

/** "read 14:02 from a terminal session" */
export function readText(limit: UsageLimit, now = new Date()): string {
  return `read ${clockTime(limit.readAt, now)} ${sourcePhrase(limit.entrypoint)}`;
}

/** 950, 12.3k, 4.5M, 1.2B */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, unit] of units) {
    if (tokens >= size) {
      const value = tokens / size;
      return `${value < 100 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)}${unit}`;
    }
  }
  return String(tokens);
}

/** $1.23; under a cent "<$0.01"; nothing "$0". */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd < 1000 ? usd.toFixed(2) : Math.round(usd).toLocaleString('en-US')}`;
}

/** A token count with thousands separators, for tooltips. */
export function exactTokens(tokens: number): string {
  return Math.round(tokens).toLocaleString('en-US');
}
