/**
 * Claude Code's OpenTelemetry metrics, as OTLP/HTTP JSON (OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json).
 * Only two metrics matter to JERRY; everything else is ignored:
 *   - claude_code.token.usage (tokens; attribute type = input | output | cacheRead | cacheCreation)
 *   - claude_code.cost.usage (USD)
 * Both carry model, query_source and the standard attributes (session.id, …), on the data point or
 * on the resource; the point wins. An entrypoint attribute is used when present, but Claude Code's
 * metrics do not carry one in practice: Core falls back to the session's registered entrypoint
 * (see UsageStore.recordTelemetry). Sums may be delta (Claude Code's default) or
 * cumulative; DeltaTracker turns cumulative series into deltas.
 */

export const TOKEN_METRIC = 'claude_code.token.usage';
export const COST_METRIC = 'claude_code.cost.usage';
export const TOKEN_TYPES = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;

export class OtlpError extends Error {}

type Fields = Record<string, unknown>;

export interface MetricPoint {
  metric: 'tokens' | 'cost';
  /** As reported: a delta, or the running total of a cumulative series. */
  value: number;
  temporality: 'delta' | 'cumulative';
  sessionId: string | null;
  /** '' when unknown. */
  model: string;
  /** input, output, cacheRead, cacheCreation; 'cost' for the cost metric. */
  tokenType: string;
  /** '' when unknown. */
  querySource: string;
  /**
   * From the 'app.entrypoint' or 'entrypoint' attribute; '' when absent (Claude Code's metrics
   * usually carry neither: Core then uses the entrypoint the session registered with).
   */
  entrypoint: string;
  /** Milliseconds since the epoch; null when absent. */
  startMs: number | null;
  timeMs: number | null;
  /** Identifies the series (metric and every attribute), for cumulative deltas. */
  seriesKey: string;
}

export interface ParsedMetrics {
  points: MetricPoint[];
  /** The entrypoint attributes seen anywhere in the request ('unknown' for resources without one). */
  entrypoints: string[];
  /**
   * The attribute keys (names only, never values) on the request's resources and on the points of
   * the two metrics, sorted, at most MAX_ATTRIBUTE_KEYS: shows what Claude Code sends, for diagnosis.
   */
  attributeKeys: string[];
}

export const MAX_ATTRIBUTE_KEYS = 50;
/** Longer keys are cut; a key is a name, so this only guards against odd senders. */
const MAX_ATTRIBUTE_KEY_LENGTH = 100;

function record(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

function list(value: unknown, what: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new OtlpError(`${what} must be an array`);
  return value;
}

/** An OTLP AnyValue as text; ints arrive as strings or numbers. Arrays and maps are not used here. */
function attributeValue(value: unknown): string | null {
  const fields = record(value);
  if (fields === null) return null;
  if (typeof fields['stringValue'] === 'string') return fields['stringValue'];
  for (const key of ['intValue', 'doubleValue']) {
    const raw = fields[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'string' && raw.trim() !== '') return raw;
  }
  if (typeof fields['boolValue'] === 'boolean') return String(fields['boolValue']);
  return null;
}

function attributes(value: unknown, what: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of list(value, what)) {
    const fields = record(entry);
    if (fields === null || typeof fields['key'] !== 'string') continue;
    const text = attributeValue(fields['value']);
    if (text !== null) result.set(fields['key'], text);
  }
  return result;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Unix nanoseconds (string or number) to milliseconds. */
function nanosToMs(value: unknown): number | null {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return Number(BigInt(value) / 1_000_000n);
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value / 1_000_000);
  return null;
}

/** 1 or "AGGREGATION_TEMPORALITY_DELTA": delta; 2 or "…_CUMULATIVE": cumulative. Claude Code's default is delta. */
function temporalityOf(value: unknown): 'delta' | 'cumulative' {
  return value === 2 || value === 'AGGREGATION_TEMPORALITY_CUMULATIVE' ? 'cumulative' : 'delta';
}

const ENTRYPOINT_KEYS = ['app.entrypoint', 'entrypoint'];

function pick(point: Map<string, string>, resource: Map<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = point.get(key) ?? resource.get(key);
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

/**
 * The token and cost points of an OTLP/HTTP JSON export request. Throws OtlpError when the request
 * is not shaped like one; points that are incomplete (no value) are skipped.
 */
export function parseOtlpMetrics(body: unknown): ParsedMetrics {
  const request = record(body);
  if (request === null) throw new OtlpError('the body must be a JSON object');
  if (!Array.isArray(request['resourceMetrics'])) throw new OtlpError('resourceMetrics must be an array');
  const points: MetricPoint[] = [];
  const entrypoints = new Set<string>();
  const keys = new Set<string>();
  const noteKeys = (found: Map<string, string>): void => {
    for (const key of found.keys()) keys.add(key.slice(0, MAX_ATTRIBUTE_KEY_LENGTH));
  };
  for (const resourceEntry of request['resourceMetrics']) {
    const resourceMetrics = record(resourceEntry);
    if (resourceMetrics === null) throw new OtlpError('every resourceMetrics entry must be an object');
    const resource = attributes(record(resourceMetrics['resource'])?.['attributes'], 'resource.attributes');
    noteKeys(resource);
    const seen = new Set<string>();
    const resourceEntrypoint = pick(new Map(), resource, ENTRYPOINT_KEYS);
    if (resourceEntrypoint !== null) seen.add(resourceEntrypoint);
    for (const scopeEntry of list(resourceMetrics['scopeMetrics'], 'scopeMetrics')) {
      const scope = record(scopeEntry);
      if (scope === null) throw new OtlpError('every scopeMetrics entry must be an object');
      for (const metricEntry of list(scope['metrics'], 'metrics')) {
        const metric = record(metricEntry);
        if (metric === null) throw new OtlpError('every metric must be an object');
        const name = metric['name'];
        if (name !== TOKEN_METRIC && name !== COST_METRIC) continue;
        const sum = record(metric['sum']);
        if (sum === null) continue;
        const temporality = temporalityOf(sum['aggregationTemporality']);
        for (const pointEntry of list(sum['dataPoints'], 'dataPoints')) {
          const point = record(pointEntry);
          if (point === null) continue;
          const value = numberOf(point['asDouble'] ?? point['asInt']);
          if (value === null || value < 0) continue;
          const own = attributes(point['attributes'], 'dataPoint.attributes');
          noteKeys(own);
          const kind = name === TOKEN_METRIC ? 'tokens' : 'cost';
          const tokenType = kind === 'cost' ? 'cost' : (own.get('type') ?? resource.get('type') ?? '');
          if (kind === 'tokens' && !(TOKEN_TYPES as readonly string[]).includes(tokenType)) continue;
          const entrypoint = pick(own, resource, ENTRYPOINT_KEYS) ?? '';
          if (entrypoint !== '') seen.add(entrypoint);
          const identity = [...resource.entries(), ...own.entries()].sort(([a], [b]) => a.localeCompare(b));
          points.push({
            metric: kind,
            value,
            temporality,
            sessionId: pick(own, resource, ['session.id']),
            model: pick(own, resource, ['model']) ?? '',
            tokenType,
            querySource: pick(own, resource, ['query_source']) ?? '',
            entrypoint,
            startMs: nanosToMs(point['startTimeUnixNano']),
            timeMs: nanosToMs(point['timeUnixNano']),
            seriesKey: JSON.stringify([name, identity]),
          });
        }
      }
    }
    for (const entrypoint of seen.size === 0 ? ['unknown'] : seen) entrypoints.add(entrypoint);
  }
  return { points, entrypoints: [...entrypoints].sort(), attributeKeys: [...keys].sort().slice(0, MAX_ATTRIBUTE_KEYS) };
}

/** Series remembered for cumulative deltas; the oldest are forgotten beyond this. */
const MAX_SERIES = 10_000;

/**
 * Turns the running totals of cumulative series into deltas. A series seen for the first time counts
 * in full only when it started after this Core did; an older one (Core restarted in between) only
 * sets the baseline, so nothing is counted twice. A new start time or a smaller total is a reset.
 */
export class DeltaTracker {
  private readonly last = new Map<string, { startMs: number | null; value: number }>();

  constructor(private readonly startedAtMs: number) {}

  delta(point: MetricPoint): number {
    if (point.temporality === 'delta') return point.value;
    const previous = this.last.get(point.seriesKey);
    this.last.delete(point.seriesKey);
    this.last.set(point.seriesKey, { startMs: point.startMs, value: point.value });
    if (this.last.size > MAX_SERIES) this.last.delete(this.last.keys().next().value!);
    if (previous === undefined) return point.startMs !== null && point.startMs >= this.startedAtMs ? point.value : 0;
    if (previous.startMs !== point.startMs || point.value < previous.value) return point.value;
    return point.value - previous.value;
  }
}
