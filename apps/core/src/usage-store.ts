import fs from 'node:fs';
import path from 'node:path';
import {
  usageSnapshotSchema,
  type JerryShareRequest,
  type Settings,
  type UsageLimit,
  type UsageSnapshotRecord,
  type UsageSummary,
  type UsageTotals,
} from '@jerry/contracts';
import { jerryPaths, readStatuslineLast, readTelemetryLast, usageCollectionStatus } from '@jerry/platform';
import { sql } from 'kysely';
import { DeltaTracker, type ParsedMetrics } from './otlp.js';
import { realPathOfNearestExisting } from './repo-fs.js';
import type { StateStore } from './state-store.js';

/**
 * Claude usage in JERRY's database. Only sessions in projects are kept: a telemetry point or a
 * status-line snapshot of any other session is dropped. Plan limits are account-wide and name no
 * session or path, so every reading is kept.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_DAYS = 30;
/** A limit reading without a reset time stops counting after the window's own length. */
const FIVE_HOURS_MS = 5 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
/** A repeated limit reading within this time is not stored again. */
const LIMIT_REPEAT_MS = MINUTE_MS;
/** Characters per token, for the estimate of JERRY's share. */
const CHARS_PER_TOKEN = 4;
const USAGE_SPOOL_BATCH = 500;

export type JerryShareKind = 'sessionStart' | 'warnings' | 'mcp';

export interface UsageLocations {
  home: string;
  claudeConfigDir: string;
}

/** Start of the minute, as stored in bucket_minute. */
export function minuteBucket(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD in the local time zone of Core's machine. */
export function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight `daysBack` days before `now`'s day. */
function localMidnight(now: Date, daysBack: number): Date {
  const date = new Date(now.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysBack);
  return date;
}

function roundCost(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, tokens: 0, costUsd: 0 };
}

/** One amount of usage: tokens of one type, or cost, of a project session at a time. */
interface Entry {
  ms: number;
  model: string;
  repoRoot: string;
  entrypoint: string;
  type: 'input' | 'output' | 'cacheRead' | 'cacheCreation' | 'cost';
  tokens: number;
  cost: number;
}

interface RegisteredSession {
  repoRoot: string | null;
  entrypoint: string | null;
}

export class UsageStore {
  private readonly tracker: DeltaTracker;

  constructor(
    private readonly store: StateStore,
    startedAt: Date,
  ) {
    this.tracker = new DeltaTracker(startedAt.getTime());
  }

  private get db() {
    return this.store.kysely;
  }

  /**
   * A session JERRY registered (SessionStart in a project): its project root (null once it is no
   * longer in a project) and the entrypoint it registered with. Null for an unknown session.
   */
  private async registeredSession(sessionId: string, cache: Map<string, RegisteredSession | null>): Promise<RegisteredSession | null> {
    if (cache.has(sessionId)) return cache.get(sessionId)!;
    const row = await this.db.selectFrom('sessions').select(['cwd', 'entrypoint']).where('session_id', '=', sessionId).executeTakeFirst();
    const session = row === undefined ? null : { repoRoot: this.store.projectOf(realPathOfNearestExisting(row.cwd))?.repoRoot ?? null, entrypoint: row.entrypoint ?? null };
    cache.set(sessionId, session);
    return session;
  }

  /** The project root of a session JERRY registered (SessionStart in a project), else null. */
  private async projectOfSession(sessionId: string, cache: Map<string, RegisteredSession | null>): Promise<string | null> {
    return (await this.registeredSession(sessionId, cache))?.repoRoot ?? null;
  }

  /**
   * Stores the token and cost points of project sessions. A point's entrypoint is its own attribute,
   * else the one its session registered with, else unknown. Returns how many points were kept and
   * the entrypoints of all points (for "jerry usage status"; empty without points).
   */
  async recordTelemetry(parsed: ParsedMetrics, now: Date): Promise<{ stored: number; entrypoints: string[] }> {
    const sessions = new Map<string, RegisteredSession | null>();
    const entrypoints = new Set<string>();
    const at = now.toISOString();
    let stored = 0;
    for (const point of parsed.points) {
      // Every cumulative series moves its baseline, also the ones that are dropped.
      const delta = this.tracker.delta(point);
      const session = point.sessionId === null ? null : await this.registeredSession(point.sessionId, sessions);
      const entrypoint = point.entrypoint !== '' ? point.entrypoint : (session?.entrypoint ?? '');
      entrypoints.add(entrypoint === '' ? 'unknown' : entrypoint);
      if (point.sessionId === null || delta <= 0) continue;
      const repoRoot = session?.repoRoot ?? null;
      if (repoRoot === null) continue;
      const tokens = point.metric === 'tokens' ? delta : 0;
      const cost = point.metric === 'cost' ? delta : 0;
      await this.db
        .insertInto('usage_tokens')
        .values({
          bucket_minute: minuteBucket(point.timeMs ?? now.getTime()),
          session_id: point.sessionId,
          repo_root: repoRoot,
          model: point.model,
          token_type: point.tokenType,
          query_source: point.querySource,
          tokens,
          cost_usd: cost,
          entrypoint,
          updated_at: at,
        })
        .onConflict((conflict) =>
          conflict.columns(['bucket_minute', 'session_id', 'model', 'token_type', 'query_source']).doUpdateSet({
            tokens: sql`tokens + excluded.tokens`,
            cost_usd: sql`cost_usd + excluded.cost_usd`,
            entrypoint: sql`CASE WHEN excluded.entrypoint = '' THEN entrypoint ELSE excluded.entrypoint END`,
            updated_at: at,
          }),
        )
        .execute();
      stored += 1;
    }
    return { stored, entrypoints: [...entrypoints].sort() };
  }

  /**
   * Status-line snapshots: plan limits from any of them (account-wide), the rest only of project
   * sessions (a session JERRY registered there, or a working directory inside a project).
   */
  async recordSnapshots(snapshots: readonly UsageSnapshotRecord[]): Promise<{ stored: number; limits: number }> {
    const sessions = new Map<string, RegisteredSession | null>();
    let stored = 0;
    let limits = 0;
    for (const snapshot of [...snapshots].sort((a, b) => a.at.localeCompare(b.at))) {
      if ((snapshot.fiveHour !== undefined || snapshot.sevenDay !== undefined) && (await this.recordLimits(snapshot))) limits += 1;
      if (snapshot.sessionId === null) continue;
      const repoRoot = (await this.projectOfSession(snapshot.sessionId, sessions)) ?? (snapshot.cwd === null ? null : (this.store.projectOf(realPathOfNearestExisting(snapshot.cwd))?.repoRoot ?? null));
      if (repoRoot === null) continue;
      const row = {
        bucket_minute: minuteBucket(Date.parse(snapshot.at)),
        at: snapshot.at,
        session_id: snapshot.sessionId,
        repo_root: repoRoot,
        model: snapshot.model,
        cost_usd: snapshot.costUsd ?? null,
        input_tokens: snapshot.inputTokens ?? null,
        output_tokens: snapshot.outputTokens ?? null,
        context_used_pct: snapshot.contextUsedPct ?? null,
        entrypoint: snapshot.entrypoint,
        version: snapshot.version,
      };
      // The latest snapshot of the minute wins.
      const { bucket_minute: _bucket, session_id: _session, ...update } = row;
      await this.db
        .insertInto('usage_snapshots')
        .values(row)
        .onConflict((conflict) => conflict.columns(['session_id', 'bucket_minute']).doUpdateSet(update).where('usage_snapshots.at', '<=', snapshot.at))
        .execute();
      stored += 1;
    }
    return { stored, limits };
  }

  /** Keeps a limit reading unless the latest one says the same and is less than a minute older. */
  private async recordLimits(snapshot: UsageSnapshotRecord): Promise<boolean> {
    const row = {
      at: snapshot.at,
      five_hour_pct: snapshot.fiveHour?.pct ?? null,
      five_hour_resets_at: snapshot.fiveHour?.resetsAt ?? null,
      seven_day_pct: snapshot.sevenDay?.pct ?? null,
      seven_day_resets_at: snapshot.sevenDay?.resetsAt ?? null,
      entrypoint: snapshot.entrypoint,
    };
    const latest = await this.db.selectFrom('usage_limits').selectAll().orderBy('at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (
      latest !== undefined &&
      Math.abs(Date.parse(row.at) - Date.parse(latest.at)) < LIMIT_REPEAT_MS &&
      latest.five_hour_pct === row.five_hour_pct &&
      latest.five_hour_resets_at === row.five_hour_resets_at &&
      latest.seven_day_pct === row.seven_day_pct &&
      latest.seven_day_resets_at === row.seven_day_resets_at
    ) {
      return false;
    }
    await this.db.insertInto('usage_limits').values(row).execute();
    return true;
  }

  /** Adds characters JERRY put into the context of a session in a project. */
  async addJerryShare(input: { sessionId: string; repoRoot: string; kind: JerryShareKind; chars: number }, now: Date): Promise<void> {
    if (input.chars <= 0) return;
    await this.db
      .insertInto('usage_jerry_share')
      .values({ bucket_minute: minuteBucket(now.getTime()), session_id: input.sessionId, repo_root: input.repoRoot, kind: input.kind, chars: input.chars, count: 1 })
      .onConflict((conflict) => conflict.columns(['bucket_minute', 'session_id', 'kind']).doUpdateSet({ chars: sql`chars + excluded.chars`, count: sql`count + 1` }))
      .execute();
  }

  /** A report from the bridge or the MCP server; kept only for a session JERRY registered in a project. */
  async recordJerryShare(request: JerryShareRequest, sessionId: string | null, now: Date): Promise<boolean> {
    if (sessionId === null) return false;
    const repoRoot = await this.projectOfSession(sessionId, new Map());
    if (repoRoot === null) return false;
    await this.addJerryShare({ sessionId, repoRoot, kind: request.kind, chars: request.chars }, now);
    return true;
  }

  // --- Summary ----------------------------------------------------------------------------------

  async summary(now: Date, locations: UsageLocations, settings: Settings): Promise<UsageSummary> {
    const start = localMidnight(now, WINDOW_DAYS - 1);
    const startIso = start.toISOString();
    const entries = [...(await this.telemetryEntries(startIso)), ...(await this.snapshotEntries(startIso))].filter((entry) => entry.ms >= start.getTime());

    const days: string[] = [];
    for (let offset = WINDOW_DAYS - 1; offset >= 0; offset -= 1) days.push(localDate(localMidnight(now, offset).getTime()));
    const today = days.at(-1)!;
    const weekStart = days.at(-7)!;
    const totals = { today: emptyTotals(), last7d: emptyTotals(), last30d: emptyTotals() };
    const daily = new Map(days.map((date) => [date, { date, tokens: 0, costUsd: 0 }]));
    const byModel = new Map<string, { model: string; tokens: number; costUsd: number }>();
    const byProject = new Map<string, { repoRoot: string; name: string; tokens: number; costUsd: number }>();
    const byEntrypoint = new Map<string, { entrypoint: string; tokens: number; costUsd: number }>();
    const add = <T extends { tokens: number; costUsd: number }>(map: Map<string, T>, key: string, create: () => T, entry: Entry): void => {
      const target = map.get(key) ?? map.set(key, create()).get(key)!;
      target.tokens += entry.tokens;
      target.costUsd += entry.cost;
    };
    for (const entry of entries) {
      const date = localDate(entry.ms);
      const windows = [totals.last30d, ...(date >= weekStart ? [totals.last7d] : []), ...(date === today ? [totals.today] : [])];
      for (const total of windows) {
        if (entry.type !== 'cost') total[entry.type] += entry.tokens;
        total.tokens += entry.tokens;
        total.costUsd += entry.cost;
      }
      const day = daily.get(date);
      if (day !== undefined) {
        day.tokens += entry.tokens;
        day.costUsd += entry.cost;
      }
      const model = entry.model === '' ? 'unknown' : entry.model;
      add(byModel, model, () => ({ model, tokens: 0, costUsd: 0 }), entry);
      add(byProject, entry.repoRoot, () => ({ repoRoot: entry.repoRoot, name: path.basename(entry.repoRoot) || entry.repoRoot, tokens: 0, costUsd: 0 }), entry);
      const entrypoint = entry.entrypoint === '' ? 'unknown' : entry.entrypoint;
      add(byEntrypoint, entrypoint, () => ({ entrypoint, tokens: 0, costUsd: 0 }), entry);
    }
    const rounded = <T extends { costUsd: number; tokens: number }>(values: Iterable<T>, sort: boolean): T[] => {
      const list = [...values].map((value) => ({ ...value, costUsd: roundCost(value.costUsd) }));
      return sort ? list.sort((a, b) => b.tokens - a.tokens || b.costUsd - a.costUsd) : list;
    };
    const collection = usageCollectionStatus(locations);
    return {
      collection: { statusline: collection.statusline, telemetry: collection.telemetry, showBar: settings.usageShowBar },
      sources: this.sources(locations.home),
      limits: await this.limits(now),
      totals: { today: rounded([totals.today], false)[0]!, last7d: rounded([totals.last7d], false)[0]!, last30d: rounded([totals.last30d], false)[0]! },
      byModel: rounded(byModel.values(), true),
      byProject: rounded(byProject.values(), true),
      byEntrypoint: rounded(byEntrypoint.values(), true),
      daily: rounded(daily.values(), false),
      jerryShare: await this.jerryShare(startIso),
    };
  }

  /** Telemetry, summed per 10 minutes (fine enough for local days in any time zone). */
  private async telemetryEntries(startIso: string): Promise<Entry[]> {
    // Rows stored without an entrypoint take the one their session registered with, if known by now.
    const rows = await sql<{ slot: string; repo_root: string; model: string; token_type: string; resolved_entrypoint: string; tokens: number; cost: number }>`
      SELECT substr(t.bucket_minute, 1, 15) AS slot, t.repo_root, t.model, t.token_type,
        COALESCE(NULLIF(t.entrypoint, ''), s.entrypoint, '') AS resolved_entrypoint,
        SUM(t.tokens) AS tokens, SUM(t.cost_usd) AS cost
      FROM usage_tokens AS t LEFT JOIN sessions AS s ON s.session_id = t.session_id
      WHERE t.bucket_minute >= ${startIso}
      GROUP BY slot, t.repo_root, t.model, t.token_type, resolved_entrypoint
    `.execute(this.db);
    return rows.rows.map((row) => ({
      ms: Date.parse(`${row.slot}0:00.000Z`),
      model: row.model,
      repoRoot: row.repo_root,
      entrypoint: row.resolved_entrypoint,
      type: row.token_type as Entry['type'],
      tokens: row.token_type === 'cost' ? 0 : Number(row.tokens),
      cost: Number(row.cost),
    }));
  }

  /**
   * Sessions without telemetry: the status line's running totals, turned into the usage between two
   * snapshots (a smaller total starts over). Earlier snapshots of a session set its baseline.
   */
  private async snapshotEntries(startIso: string): Promise<Entry[]> {
    const rows = await sql<{ session_id: string; at: string; repo_root: string; model: string | null; entrypoint: string | null; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null }>`
      SELECT u.session_id, u.at, u.repo_root, u.model, COALESCE(NULLIF(u.entrypoint, ''), s.entrypoint) AS entrypoint, u.input_tokens, u.output_tokens, u.cost_usd
      FROM usage_snapshots AS u LEFT JOIN sessions AS s ON s.session_id = u.session_id
      WHERE u.session_id IN (SELECT DISTINCT session_id FROM usage_snapshots WHERE at >= ${startIso})
        AND u.session_id NOT IN (SELECT DISTINCT session_id FROM usage_tokens)
      ORDER BY u.session_id, u.at
    `.execute(this.db);
    const entries: Entry[] = [];
    let session: string | null = null;
    let previous = { input: 0, output: 0, cost: 0 };
    const step = (value: number | null, before: number): number => (value === null ? 0 : value >= before ? value - before : value);
    for (const row of rows.rows) {
      if (row.session_id !== session) {
        session = row.session_id;
        previous = { input: 0, output: 0, cost: 0 };
      }
      const input = step(row.input_tokens, previous.input);
      const output = step(row.output_tokens, previous.output);
      const cost = step(row.cost_usd, previous.cost);
      previous = { input: row.input_tokens ?? previous.input, output: row.output_tokens ?? previous.output, cost: row.cost_usd ?? previous.cost };
      const base = { ms: Date.parse(row.at), model: row.model ?? '', repoRoot: row.repo_root, entrypoint: row.entrypoint ?? '' };
      if (input > 0) entries.push({ ...base, type: 'input', tokens: input, cost: 0 });
      if (output > 0) entries.push({ ...base, type: 'output', tokens: output, cost: 0 });
      if (cost > 0) entries.push({ ...base, type: 'cost', tokens: 0, cost });
    }
    return entries;
  }

  /** The latest reading of each plan window; null without one, or once it has reset. */
  async limits(now: Date): Promise<UsageSummary['limits']> {
    const latest = async (pct: 'five_hour_pct' | 'seven_day_pct', resets: 'five_hour_resets_at' | 'seven_day_resets_at', windowMs: number): Promise<UsageLimit> => {
      const row = await this.db.selectFrom('usage_limits').select(['at', pct, resets, 'entrypoint']).where(pct, 'is not', null).orderBy('at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
      if (row === undefined) return null;
      const resetsAt = row[resets] as string | null;
      if (resetsAt !== null ? Date.parse(resetsAt) <= now.getTime() : now.getTime() - Date.parse(row.at) > windowMs) return null;
      return { pct: Number(row[pct]), resetsAt, readAt: row.at, entrypoint: row.entrypoint };
    };
    return { fiveHour: await latest('five_hour_pct', 'five_hour_resets_at', FIVE_HOURS_MS), sevenDay: await latest('seven_day_pct', 'seven_day_resets_at', SEVEN_DAYS_MS) };
  }

  /** When each source last delivered, from the files the status line and Core keep (no usage numbers). */
  private sources(home: string): UsageSummary['sources'] {
    const statusline = readStatuslineLast(home);
    const telemetry = readTelemetryLast(home);
    return {
      statusline: { lastAt: statusline?.at ?? null, byEntrypoint: Object.fromEntries(Object.entries(statusline?.byEntrypoint ?? {}).map(([entrypoint, sighting]) => [entrypoint, sighting.at])) },
      telemetry: { lastAt: telemetry?.at ?? null, byEntrypoint: telemetry?.byEntrypoint ?? {} },
    };
  }

  private async jerryShare(startIso: string): Promise<UsageSummary['jerryShare']> {
    const rows = await this.db.selectFrom('usage_jerry_share').select((eb) => ['kind', eb.fn.sum<number>('chars').as('chars')]).where('bucket_minute', '>=', startIso).groupBy('kind').execute();
    const of = (kind: JerryShareKind): number => Number(rows.find((row) => row.kind === kind)?.chars ?? 0);
    const chars30d = of('sessionStart') + of('warnings') + of('mcp');
    return { chars30d, estimatedTokens30d: Math.round(chars30d / CHARS_PER_TOKEN), sessionStart: of('sessionStart'), warnings: of('warnings'), mcp: of('mcp') };
  }
}

/**
 * Moves the status-line snapshots spooled while Core was down into the database. The spool file is
 * renamed first, so the script appends to a new one meanwhile; unreadable lines are dropped.
 * Returns how many snapshots were read.
 */
export async function drainUsageSpool(home: string, usage: UsageStore): Promise<number> {
  const spool = jerryPaths(home).usageSpoolFile;
  const dir = path.dirname(spool);
  let leftovers: string[] = [];
  try {
    leftovers = fs.readdirSync(dir).filter((name) => name.startsWith(`${path.basename(spool)}.`) && name.endsWith('.draining'));
  } catch {
    return 0;
  }
  const files = leftovers.map((name) => path.join(dir, name));
  if (fs.existsSync(spool)) {
    const draining = `${spool}.${process.pid}-${Date.now()}.draining`;
    try {
      fs.renameSync(spool, draining);
      files.push(draining);
    } catch {
      // The script is writing right now: next time.
    }
  }
  let read = 0;
  for (const file of files) {
    let lines: string[];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    const snapshots: UsageSnapshotRecord[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const parsed = usageSnapshotSchema.safeParse(JSON.parse(line));
        if (parsed.success) snapshots.push(parsed.data);
      } catch {
        // not JSON: dropped
      }
    }
    for (let index = 0; index < snapshots.length; index += USAGE_SPOOL_BATCH) await usage.recordSnapshots(snapshots.slice(index, index + USAGE_SPOOL_BATCH));
    read += snapshots.length;
    fs.rmSync(file, { force: true });
  }
  return read;
}
