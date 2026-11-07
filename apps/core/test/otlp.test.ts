import { describe, expect, it } from 'vitest';
import { COST_METRIC, DeltaTracker, MAX_ATTRIBUTE_KEYS, OtlpError, parseOtlpMetrics, TOKEN_METRIC } from '../src/otlp.js';

const NS = 1_000_000n;
const nanos = (ms: number): string => String(BigInt(ms) * NS);
const text = (key: string, value: string) => ({ key, value: { stringValue: value } });

function request(options: { resource?: unknown[]; metrics: unknown[] }): unknown {
  return { resourceMetrics: [{ resource: { attributes: options.resource ?? [] }, scopeMetrics: [{ scope: { name: 'com.anthropic.claude_code' }, metrics: options.metrics }] }] };
}

function sum(name: string, points: unknown[], temporality: 1 | 2 = 1): unknown {
  return { name, unit: name === TOKEN_METRIC ? 'tokens' : 'USD', sum: { dataPoints: points, aggregationTemporality: temporality, isMonotonic: true } };
}

describe('OTLP/HTTP JSON metrics', () => {
  const start = Date.parse('2026-11-07T10:00:00.000Z');

  it('reads token and cost points with attributes on the data point', () => {
    const parsed = parseOtlpMetrics(
      request({
        metrics: [
          sum(TOKEN_METRIC, [
            { attributes: [text('type', 'input'), text('model', 'claude-opus-5-5'), text('session.id', 's1'), text('query_source', 'main'), text('app.entrypoint', 'claude-vscode')], asInt: '1200', startTimeUnixNano: nanos(start), timeUnixNano: nanos(start + 60_000) },
            { attributes: [text('type', 'cacheRead'), text('model', 'claude-opus-5-5'), text('session.id', 's1')], asInt: 300, timeUnixNano: nanos(start + 60_000) },
          ]),
          sum(COST_METRIC, [{ attributes: [text('model', 'claude-opus-5-5'), text('session.id', 's1')], asDouble: 0.25, timeUnixNano: nanos(start + 60_000) }]),
        ],
      }),
    );
    expect(parsed.points).toHaveLength(3);
    expect(parsed.points[0]).toMatchObject({ metric: 'tokens', value: 1200, temporality: 'delta', sessionId: 's1', model: 'claude-opus-5-5', tokenType: 'input', querySource: 'main', entrypoint: 'claude-vscode', startMs: start, timeMs: start + 60_000 });
    expect(parsed.points[1]).toMatchObject({ tokenType: 'cacheRead', value: 300, querySource: '', entrypoint: '' });
    expect(parsed.points[2]).toMatchObject({ metric: 'cost', tokenType: 'cost', value: 0.25 });
    expect(parsed.entrypoints).toEqual(['claude-vscode']);
  });

  it('takes standard attributes from the resource when the point has none (the point wins)', () => {
    const parsed = parseOtlpMetrics(
      request({
        resource: [text('session.id', 'from-resource'), text('app.entrypoint', 'cli'), { key: 'app.version', value: { stringValue: '2.1.90' } }],
        metrics: [
          sum(TOKEN_METRIC, [
            { attributes: [text('type', 'output'), text('model', 'm')], asInt: '5' },
            { attributes: [text('type', 'output'), text('model', 'm'), text('session.id', 'from-point')], asInt: '7' },
          ]),
        ],
      }),
    );
    expect(parsed.points.map((point) => [point.sessionId, point.entrypoint, point.value])).toEqual([
      ['from-resource', 'cli', 5],
      ['from-point', 'cli', 7],
    ]);
    expect(parsed.entrypoints).toEqual(['cli']);
  });

  it('ignores other metrics, unknown token types and points without a value; a resource without an entrypoint is "unknown"', () => {
    const parsed = parseOtlpMetrics(
      request({
        metrics: [
          sum('claude_code.session.count', [{ attributes: [], asInt: '1' }]),
          { name: 'claude_code.lines_of_code.count', gauge: { dataPoints: [{ asInt: '3' }] } },
          sum(TOKEN_METRIC, [{ attributes: [text('type', 'thinking')], asInt: '9' }, { attributes: [text('type', 'input')] }, { attributes: [text('type', 'input')], asInt: '-4' }]),
        ],
      }),
    );
    expect(parsed.points).toEqual([]);
    expect(parsed.entrypoints).toEqual(['unknown']);
  });

  it('lists the attribute names of resources and token/cost points, sorted and without values; points without one have entrypoint ""', () => {
    const parsed = parseOtlpMetrics(
      request({
        resource: [text('service.name', 'claude-code'), text('user.id', 'secret-looking-value')],
        metrics: [
          sum(TOKEN_METRIC, [{ attributes: [text('type', 'input'), text('session.id', 's1'), text('model', 'm')], asInt: '3' }]),
          sum('claude_code.session.count', [{ attributes: [text('not.counted', 'x')], asInt: '1' }]),
        ],
      }),
    );
    expect(parsed.points[0]!.entrypoint).toBe('');
    expect(parsed.entrypoints).toEqual(['unknown']);
    expect(parsed.attributeKeys).toEqual(['model', 'service.name', 'session.id', 'type', 'user.id']);
    expect(JSON.stringify(parsed.attributeKeys)).not.toContain('secret-looking-value');
    const many = parseOtlpMetrics(request({ resource: Array.from({ length: 70 }, (_, index) => text(`k${String(index).padStart(2, '0')}`, 'v')), metrics: [] }));
    expect(many.attributeKeys).toHaveLength(MAX_ATTRIBUTE_KEYS);
    expect(many.attributeKeys.at(-1)).toBe('k49');
  });

  it('rejects requests that are not shaped like an export request', () => {
    for (const body of [null, 'text', [], {}, { resourceMetrics: {} }, { resourceMetrics: ['x'] }, { resourceMetrics: [{ scopeMetrics: {} }] }, { resourceMetrics: [{ scopeMetrics: [{ metrics: [1] }] }] }]) {
      expect(() => parseOtlpMetrics(body), JSON.stringify(body)).toThrow(OtlpError);
    }
    expect(parseOtlpMetrics({ resourceMetrics: [] }).points).toEqual([]);
  });

  it('turns cumulative series into deltas: new series after Core started count in full, older ones set a baseline, resets start over', () => {
    const coreStarted = start;
    const tracker = new DeltaTracker(coreStarted);
    const point = (value: number, startMs: number, session = 's1') =>
      parseOtlpMetrics(request({ metrics: [sum(TOKEN_METRIC, [{ attributes: [text('type', 'input'), text('session.id', session)], asInt: String(value), startTimeUnixNano: nanos(startMs) }], 2)] })).points[0]!;
    expect(point(100, start + 1000).temporality).toBe('cumulative');
    expect(tracker.delta(point(100, start + 1000))).toBe(100);
    expect(tracker.delta(point(250, start + 1000))).toBe(150);
    expect(tracker.delta(point(250, start + 1000))).toBe(0);
    // The process restarted: a new start time.
    expect(tracker.delta(point(40, start + 5000))).toBe(40);
    // A series that started before this Core: baseline only, then deltas.
    expect(tracker.delta(point(9000, start - 60_000, 's2'))).toBe(0);
    expect(tracker.delta(point(9500, start - 60_000, 's2'))).toBe(500);
    // Delta series pass through.
    const delta = parseOtlpMetrics(request({ metrics: [sum(TOKEN_METRIC, [{ attributes: [text('type', 'input')], asInt: '12' }])] })).points[0]!;
    expect(tracker.delta(delta)).toBe(12);
    expect(tracker.delta(delta)).toBe(12);
  });
});
