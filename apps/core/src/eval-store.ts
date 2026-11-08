import type { EvalCaseResult, EvalRunDetail, EvalRunSummary, EvalStatus } from '@jerry/contracts';
import { evalCaseResultSchema, jerryFingerprintSchema } from '@jerry/contracts';
import type { JerrySchema } from '@jerry/database';
import { calibration, changedComponents, compareRuns, metricDeltas, variantMetrics, type CaseOutcome, type JerryFingerprint, type VariantMetrics } from '@jerry/evals';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import { StateError } from './state-store.js';

/**
 * Eval runs, baselines and calibration labels, in JERRY's database, outside any project.
 * The CLI runner records runs; only the user sets a baseline or labels a rubric result.
 */
export class EvalStore {
  constructor(private readonly db: Kysely<JerrySchema>) {}

  async recordRun(run: { startedAt: string; finishedAt: string; jerryVersion: string; fingerprint: JerryFingerprint; label: string; results: EvalCaseResult[] }, now: Date): Promise<EvalRunDetail> {
    const inserted = await this.db
      .insertInto('eval_runs')
      .values({ started_at: run.startedAt, finished_at: run.finishedAt, jerry_version: run.jerryVersion, fingerprint_json: JSON.stringify(run.fingerprint), label: run.label, results_json: JSON.stringify(run.results), created_at: now.toISOString() })
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.run(`EVR-${inserted.id}`);
  }

  async runs(limit = 50): Promise<EvalRunSummary[]> {
    const baseline = await this.baselineId();
    const rows = await this.db.selectFrom('eval_runs').selectAll().orderBy('id', 'desc').limit(limit).execute();
    return rows.map((row) => summaryOf(row, baseline));
  }

  /** A run with its results compared with the current baseline (or, for the baseline, with the one before). */
  async run(runId: string): Promise<EvalRunDetail> {
    const id = runNumber(runId);
    const row = await this.db.selectFrom('eval_runs').selectAll().where('id', '=', id).executeTakeFirst();
    if (row === undefined) throw new StateError(404, `Unknown eval run ${runId}`);
    const baselineId = await this.baselineId();
    const reference = baselineId !== null && baselineId !== id ? baselineId : await this.previousBaselineId(id);
    const results = parseResults(row.results_json);
    const outcomes = new Map(results.map((result) => [result.caseId, result.outcome as CaseOutcome]));
    let before = new Map<string, CaseOutcome>();
    let beforeMetrics = new Map<string, VariantMetrics[]>();
    if (reference !== null) {
      const baseRow = await this.db.selectFrom('eval_runs').select('results_json').where('id', '=', reference).executeTakeFirstOrThrow();
      const baseResults = parseResults(baseRow.results_json);
      before = new Map(baseResults.map((result) => [result.caseId, result.outcome as CaseOutcome]));
      beforeMetrics = metricsOf(baseResults);
    }
    const critical = new Set(results.filter((result) => result.critical).map((result) => result.caseId));
    const comparison = compareRuns(before, outcomes, critical);
    const metrics = metricsOf(results);
    return {
      ...summaryOf(row, baselineId),
      results,
      comparison: { baselineRunId: reference === null ? null : `EVR-${reference}`, ...comparison, deltas: metricDeltas(beforeMetrics, metrics) },
      metrics: [...metrics.entries()].map(([caseId, variants]) => ({ caseId, variants })),
    };
  }

  /** The user's choice of baseline, with a reason; a run with errors or flaky cases cannot be one. */
  async setBaseline(runId: string, note: string, now: Date): Promise<EvalRunSummary> {
    const id = runNumber(runId);
    const row = await this.db.selectFrom('eval_runs').selectAll().where('id', '=', id).executeTakeFirst();
    if (row === undefined) throw new StateError(404, `Unknown eval run ${runId}`);
    const unsettled = parseResults(row.results_json).filter((result) => result.outcome === 'ERROR' || result.outcome === 'FLAKY');
    if (unsettled.length > 0) throw new StateError(409, `${runId} has flaky or erroring cases (${unsettled.map((result) => result.caseId).join(', ')}); rerun them before making it the baseline`);
    await this.db.insertInto('eval_baselines').values({ run_id: id, note, set_at: now.toISOString() }).execute();
    return summaryOf(row, id);
  }

  /** A human verdict on a rubric grader's result in a run. */
  async label(input: { runId: string; caseId: string; attempt: number; rubricId: string; humanPassed: boolean }, now: Date): Promise<void> {
    const id = runNumber(input.runId);
    const row = await this.db.selectFrom('eval_runs').select('results_json').where('id', '=', id).executeTakeFirst();
    if (row === undefined) throw new StateError(404, `Unknown eval run ${input.runId}`);
    const attempt = parseResults(row.results_json)
      .find((result) => result.caseId === input.caseId)
      ?.attempts.find((entry) => entry.attempt === input.attempt);
    const grader = attempt?.graders.find((entry) => entry.kind === 'rubric' && entry.grader.startsWith(`rubric ${input.rubricId} `));
    if (grader === undefined || grader.score === undefined) throw new StateError(404, `${input.runId} has no rubric ${input.rubricId} result for ${input.caseId} attempt ${input.attempt}`);
    const threshold = Number(/≥ ([\d.]+)$/.exec(grader.grader)?.[1] ?? '0.7');
    await this.db
      .insertInto('eval_labels')
      .values({ run_id: id, case_id: input.caseId, attempt: input.attempt, rubric_id: input.rubricId, human_passed: input.humanPassed ? 1 : 0, grader_passed: grader.score >= threshold ? 1 : 0, score: grader.score, labeled_at: now.toISOString() })
      .onConflict((conflict) => conflict.columns(['run_id', 'case_id', 'attempt', 'rubric_id']).doUpdateSet({ human_passed: input.humanPassed ? 1 : 0, labeled_at: now.toISOString() }))
      .execute();
  }

  async calibration(): Promise<Array<{ rubricId: string; labels: number; agreement: number; calibrated: boolean }>> {
    const rows = await this.db.selectFrom('eval_labels').select(['rubric_id', 'human_passed', 'grader_passed']).execute();
    return [...calibration(rows.map((row) => ({ rubricId: row.rubric_id, humanPassed: row.human_passed === 1, graderPassed: row.grader_passed === 1 })))].map(([rubricId, entry]) => ({ rubricId, ...entry }));
  }

  /** Whether the evals should run again: what changed since the baseline was measured. */
  async status(current: JerryFingerprint | null): Promise<EvalStatus> {
    const baselineId = await this.baselineId();
    const latest = await this.db.selectFrom('eval_runs').select('id').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const baselineRow = baselineId === null ? undefined : await this.db.selectFrom('eval_runs').select('fingerprint_json').where('id', '=', baselineId).executeTakeFirst();
    const baselineFingerprint = baselineRow === undefined ? null : jerryFingerprintSchema.parse(JSON.parse(baselineRow.fingerprint_json));
    const releaseBlocked = latest === undefined ? false : (await this.run(`EVR-${latest.id}`)).comparison.releaseBlocked;
    return {
      baselineRunId: baselineId === null ? null : `EVR-${baselineId}`,
      latestRunId: latest === undefined ? null : `EVR-${latest.id}`,
      fingerprint: current,
      changedSinceBaseline: current === null ? [] : changedComponents(baselineFingerprint, current),
      releaseBlocked,
    };
  }

  private async baselineId(): Promise<number | null> {
    const row = await this.db.selectFrom('eval_baselines').select('run_id').orderBy('id', 'desc').limit(1).executeTakeFirst();
    return row?.run_id ?? null;
  }

  private async previousBaselineId(runId: number): Promise<number | null> {
    const row = await this.db.selectFrom('eval_baselines').select('run_id').where('run_id', '<', runId).orderBy('id', 'desc').limit(1).executeTakeFirst();
    return row?.run_id ?? null;
  }
}

function runNumber(runId: string): number {
  const match = /^EVR-(\d+)$/i.exec(runId.trim());
  if (match === null) throw new StateError(400, `${runId} is not an eval run ID (EVR-…)`);
  return Number(match[1]);
}

function parseResults(json: string): EvalCaseResult[] {
  return z.array(evalCaseResultSchema).parse(JSON.parse(json));
}

/** Cost and work per case and variant (older runs without metrics give counts and nulls). */
function metricsOf(results: readonly EvalCaseResult[]): Map<string, VariantMetrics[]> {
  return new Map(results.map((result) => [result.caseId, variantMetrics(result.attempts)]));
}

function summaryOf(row: Selectable<JerrySchema['eval_runs']>, baselineId: number | null): EvalRunSummary {
  const results = parseResults(row.results_json);
  const count = (outcome: string): number => results.filter((result) => result.outcome === outcome).length;
  const costs = results.flatMap((result) => result.attempts.map((attempt) => attempt.costUsd)).filter((cost): cost is number => cost !== null);
  return {
    runId: `EVR-${row.id}`,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    jerryVersion: row.jerry_version,
    fingerprint: jerryFingerprintSchema.parse(JSON.parse(row.fingerprint_json)),
    label: row.label,
    counts: { PASS: count('PASS'), FAIL: count('FAIL'), FLAKY: count('FLAKY'), ERROR: count('ERROR') },
    isBaseline: baselineId === row.id,
    costUsd: costs.length === 0 ? null : Math.round(costs.reduce((sum, cost) => sum + cost, 0) * 1e4) / 1e4,
  };
}
