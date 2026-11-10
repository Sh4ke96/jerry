import type { TaskSummary } from '@jerry/contracts';
import { evaluateCompletion } from '@jerry/workflow';
import { describe, expect, it } from 'vitest';
import { failedBlocking, remedyFor, rerunCanHelp } from '../src/lib/final-checks';
import { sampleReport } from '../../../tests/helpers/report-fixture';

/** A report and facts that fail every blocking condition the DONE validator knows. */
function everythingFails() {
  const report = sampleReport();
  return evaluateCompletion({
    currentPlanVersion: 2,
    planApproved: false,
    report: {
      version: 1,
      planVersion: 1,
      document: { ...report, checks: [{ kind: 'test', command: 'npm test', result: 'FAIL', details: '' }], risks: [{ risk: 'data loss', severity: 'critical', mitigation: '' }] },
      evidence: { since: '', deviations: [], deviationCount: 0, blockedCount: 0, observedEdits: [], unreportedEdits: [], failedOrNotRunChecks: 1, git: null },
    },
    reportAccepted: false,
    editsSinceReport: ['src/a.ts'],
    laterWork: [],
    definitionOfDone: [],
    review: { outcome: null, rounds: 0, reason: '', uncovered: [], notIndependent: [], openFindings: [] },
  });
}

const withConditions = (conditions: Array<{ id: string; blocking: boolean; passed: boolean }>) =>
  ({ finalCheck: { conditions: conditions.map((condition) => ({ ...condition, detail: '' })) } }) as unknown as TaskSummary;

describe('final-check remedies', () => {
  it('has its own remedy for every blocking condition the DONE validator produces', () => {
    const blocking = everythingFails().conditions.filter((condition) => condition.blocking);
    expect(blocking.map((condition) => condition.id)).toEqual([
      'plan.approved',
      'report.accepted',
      'report.matches-plan',
      'report.no-failed-checks',
      'report.no-critical-risks',
      'code.unchanged-since-report',
      'review.done',
    ]);
    for (const condition of blocking) expect(remedyFor(condition.id), condition.id).not.toBe(remedyFor('unknown.condition'));
  });

  it('falls back to a generic remedy for an unknown condition, which a re-run may help', () => {
    expect(remedyFor('something.new')).toMatchObject({ rerun: true });
  });

  it('says a re-run cannot help only when every failed blocking condition is about the report or plan', () => {
    expect(rerunCanHelp(withConditions([{ id: 'report.no-failed-checks', blocking: true, passed: false }]))).toBe(false);
    expect(rerunCanHelp(withConditions([{ id: 'report.no-failed-checks', blocking: true, passed: false }, { id: 'code.unchanged-since-report', blocking: true, passed: false }]))).toBe(true);
    // Non-blocking notes and passed conditions do not count.
    const task = withConditions([{ id: 'checks.ran', blocking: false, passed: false }, { id: 'plan.approved', blocking: true, passed: true }]);
    expect(failedBlocking(task)).toEqual([]);
    expect(rerunCanHelp(task)).toBe(true);
  });
});
