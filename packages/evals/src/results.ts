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
