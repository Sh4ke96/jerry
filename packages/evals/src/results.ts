import type { GraderResult } from './graders.js';

/**
 * Results, flakiness, regressions and calibration. Pure functions over
 * recorded attempts; the runner and Core store them.
 */

export type AttemptOutcome = 'PASS' | 'FAIL' | 'ERROR';
/** A case over its repeats. FLAKY is never a regression on its own. */
export type CaseOutcome = 'PASS' | 'FAIL' | 'FLAKY' | 'ERROR';

/** One attempt: ERROR when the harness itself failed, otherwise every counted grader must pass. */
export function attemptOutcome(results: readonly GraderResult[], harnessError: string | null): AttemptOutcome {
  if (harnessError !== null) return 'ERROR';
  const counted = results.filter((result) => result.passed !== null);
  if (counted.length === 0) return 'ERROR';
  return counted.every((result) => result.passed === true) ? 'PASS' : 'FAIL';
}

export function classify(attempts: readonly AttemptOutcome[]): CaseOutcome {
  if (attempts.length === 0) return 'ERROR';
  const passes = attempts.filter((attempt) => attempt === 'PASS').length;
  const errors = attempts.filter((attempt) => attempt === 'ERROR').length;
  if (passes === attempts.length) return 'PASS';
  if (errors === attempts.length) return 'ERROR';
  if (passes > 0) return 'FLAKY';
  return 'FAIL';
}

export type Comparison = 'REGRESSION' | 'FIXED' | 'UNCHANGED' | 'FLAKY' | 'NEW' | 'MISSING' | 'ERROR';

export interface CaseComparison {
  caseId: string;
  critical: boolean;
  baseline: CaseOutcome | null;
  current: CaseOutcome | null;
  comparison: Comparison;
}

/**
 * Per case, against the baseline (per case, not one score). Only PASS → FAIL is a
 * regression; a flaky or erroring run is reported as such and needs a rerun, not a verdict.
 */
export function compareRuns(
  baseline: ReadonlyMap<string, CaseOutcome>,
  current: ReadonlyMap<string, CaseOutcome>,
  critical: ReadonlySet<string>,
): { cases: CaseComparison[]; regressions: string[]; releaseBlocked: boolean } {
  const ids = [...new Set([...baseline.keys(), ...current.keys()])].sort();
  const cases = ids.map((caseId): CaseComparison => {
    const before = baseline.get(caseId) ?? null;
    const now = current.get(caseId) ?? null;
    let comparison: Comparison;
    if (now === null) comparison = 'MISSING';
    else if (now === 'ERROR') comparison = 'ERROR';
    else if (now === 'FLAKY') comparison = 'FLAKY';
    else if (before === null) comparison = 'NEW';
    else if (before === 'PASS' && now === 'FAIL') comparison = 'REGRESSION';
    else if (before !== 'PASS' && now === 'PASS') comparison = 'FIXED';
    else comparison = 'UNCHANGED';
    return { caseId, critical: critical.has(caseId), baseline: before, current: now, comparison };
  });
  const regressions = cases.filter((entry) => entry.comparison === 'REGRESSION').map((entry) => entry.caseId);
  // A regression in a critical safety case blocks a JERRY release.
  return { cases, regressions, releaseBlocked: cases.some((entry) => entry.comparison === 'REGRESSION' && entry.critical) };
}

// ---------------------------------------------------------------------------
// Cost and work per variant: what the comparison is about
// ---------------------------------------------------------------------------

/** What an attempt cost and did; older recorded attempts may lack any of it. */
export interface AttemptMetricsInput {
  variant?: string | undefined;
  outcome: AttemptOutcome;
  costUsd: number | null;
  tokens?: { input: number; output: number; cacheRead: number; cacheCreation: number } | null | undefined;
  turns?: number | null | undefined;
  toolCalls?: Readonly<Record<string, number>> | undefined;
  sessionMs?: number | null | undefined;
}

export interface Spread {
  mean: number;
  min: number;
  max: number;
  /** Attempts that reported the value. */
  n: number;
}

export interface VariantMetrics {
  variant: string;
  attempts: number;
  /** Passed attempts / attempts with an outcome other than ERROR. */
  passRate: number | null;
  costUsd: Spread | null;
  /** Input + output + cache tokens. */
  tokens: Spread | null;
  outputTokens: Spread | null;
  turns: Spread | null;
  toolCalls: Spread | null;
  /** Read, Grep and Glob: what earlier knowledge should save. */
  searchCalls: Spread | null;
  /** Calls of JERRY's own tools. */
  jerryCalls: Spread | null;
  sessionMs: Spread | null;
}

function spread(values: ReadonlyArray<number | null | undefined>): Spread | null {
  const known = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (known.length === 0) return null;
  return { mean: known.reduce((sum, value) => sum + value, 0) / known.length, min: Math.min(...known), max: Math.max(...known), n: known.length };
}

const sumOf = (calls: Readonly<Record<string, number>> | undefined, pick: (tool: string) => boolean): number | null =>
  calls === undefined ? null : Object.entries(calls).filter(([tool]) => pick(tool)).reduce((sum, [, count]) => sum + count, 0);

/** Per variant, in the order the variants first appear. */
export function variantMetrics(attempts: readonly AttemptMetricsInput[]): VariantMetrics[] {
  const groups = new Map<string, AttemptMetricsInput[]>();
  for (const attempt of attempts) {
    const key = attempt.variant ?? 'jerry';
    groups.set(key, [...(groups.get(key) ?? []), attempt]);
  }
  return [...groups.entries()].map(([variant, entries]) => {
    const graded = entries.filter((entry) => entry.outcome !== 'ERROR');
    const withCalls = entries.filter((entry) => entry.toolCalls !== undefined && entry.outcome !== 'ERROR');
    return {
      variant,
      attempts: entries.length,
      passRate: graded.length === 0 ? null : graded.filter((entry) => entry.outcome === 'PASS').length / graded.length,
      costUsd: spread(entries.map((entry) => entry.costUsd)),
      tokens: spread(entries.map((entry) => (entry.tokens == null ? null : entry.tokens.input + entry.tokens.output + entry.tokens.cacheRead + entry.tokens.cacheCreation))),
      outputTokens: spread(entries.map((entry) => entry.tokens?.output)),
      turns: spread(entries.map((entry) => entry.turns)),
      toolCalls: spread(withCalls.map((entry) => sumOf(entry.toolCalls, () => true))),
      searchCalls: spread(withCalls.map((entry) => sumOf(entry.toolCalls, (tool) => tool === 'Read' || tool === 'Grep' || tool === 'Glob'))),
      jerryCalls: spread(withCalls.map((entry) => sumOf(entry.toolCalls, (tool) => tool.startsWith('mcp__plugin_jerry_guardian__')))),
      sessionMs: spread(entries.map((entry) => entry.sessionMs)),
    };
  });
}

export interface MetricDelta {
  caseId: string;
  variant: string;
  /** Current mean minus baseline mean; null when either lacks it. */
  costUsd: number | null;
  tokens: number | null;
  /** Relative change of the mean cost (0.2 = 20% more). */
  costRatio: number | null;
}

/** Mean cost and tokens per case and variant against the baseline: information, never a regression. */
export function metricDeltas(baseline: ReadonlyMap<string, VariantMetrics[]>, current: ReadonlyMap<string, VariantMetrics[]>): MetricDelta[] {
  const deltas: MetricDelta[] = [];
  for (const [caseId, variants] of current) {
    for (const metrics of variants) {
      const before = baseline.get(caseId)?.find((entry) => entry.variant === metrics.variant);
      if (before === undefined) continue;
      const cost = metrics.costUsd !== null && before.costUsd !== null ? metrics.costUsd.mean - before.costUsd.mean : null;
      deltas.push({
        caseId,
        variant: metrics.variant,
        costUsd: cost,
        tokens: metrics.tokens !== null && before.tokens !== null ? metrics.tokens.mean - before.tokens.mean : null,
        costRatio: cost !== null && before.costUsd !== null && before.costUsd.mean > 0 ? cost / before.costUsd.mean : null,
      });
    }
  }
  return deltas;
}

/** A human label against a rubric verdict, for calibration. */
export interface CalibrationLabel {
  rubricId: string;
  humanPassed: boolean;
  graderPassed: boolean;
}

export const CALIBRATION_MIN_LABELS = 10;
export const CALIBRATION_MIN_AGREEMENT = 0.8;

/** Per rubric: labels, agreement, and whether it counts (80% over at least 10 labels). */
export function calibration(labels: readonly CalibrationLabel[]): Map<string, { labels: number; agreement: number; calibrated: boolean }> {
  const byRubric = new Map<string, CalibrationLabel[]>();
  for (const label of labels) byRubric.set(label.rubricId, [...(byRubric.get(label.rubricId) ?? []), label]);
  const result = new Map<string, { labels: number; agreement: number; calibrated: boolean }>();
  for (const [rubricId, entries] of byRubric) {
    const agreement = entries.filter((entry) => entry.humanPassed === entry.graderPassed).length / entries.length;
    result.set(rubricId, { labels: entries.length, agreement, calibrated: entries.length >= CALIBRATION_MIN_LABELS && agreement >= CALIBRATION_MIN_AGREEMENT });
  }
  return result;
}
