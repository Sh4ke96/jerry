import { describe, expect, it } from 'vitest';
import { evaluateCompletion, type CompletionInput } from '../src/index.js';

type Report = NonNullable<CompletionInput['report']>;

const report = (overrides: { checks?: Report['document']['checks']; risks?: Report['document']['risks']; planVersion?: number; unreportedEdits?: string[]; deviationCount?: number } = {}): Report => ({
  version: 2,
  planVersion: overrides.planVersion ?? 1,
  document: {
    summary: 's',
    changes: [{ repository: '', path: 'src/a.ts', kind: 'modified', description: 'd' }],
    agents: [],
    skills: [],
    checks: overrides.checks ?? [{ kind: 'test', command: 'npm test', result: 'PASS', details: '' }],
    planDeviations: [],
    risks: overrides.risks ?? [],
    commitSubjects: ['feat: x'],
    qaScenarios: [],
    artifact: '',
  },
  evidence: { since: '2026-11-06T10:00:00.000Z', deviations: [], deviationCount: overrides.deviationCount ?? 0, blockedCount: 0, observedEdits: [], unreportedEdits: overrides.unreportedEdits ?? [], failedOrNotRunChecks: 0 },
});

const ready: CompletionInput = { currentPlanVersion: 1, planApproved: true, report: report(), reportAccepted: true, editsSinceReport: [], definitionOfDone: ['tests pass', 'README updated'] };
const failedIds = (input: CompletionInput) => evaluateCompletion(input).conditions.filter((condition) => condition.blocking && !condition.passed).map((condition) => condition.id);

describe('DONE validator (spec Phase 9)', () => {
  it('passes when the user approved the plan and accepted a clean report for it', () => {
    const result = evaluateCompletion(ready);
    expect(result.passed).toBe(true);
    expect(result.conditions.every((condition) => condition.passed)).toBe(true);
    expect(result.conditions.find((condition) => condition.id === 'report.accepted')?.detail).toContain("Definition of Done (2 item(s))");
  });

  it('refuses DONE for each blocking reason', () => {
    expect(failedIds({ ...ready, planApproved: false })).toEqual(['plan.approved']);
    expect(failedIds({ ...ready, reportAccepted: false })).toEqual(['report.accepted']);
    expect(failedIds({ ...ready, report: null })).toEqual(['report.accepted']);
    expect(failedIds({ ...ready, currentPlanVersion: 2 })).toEqual(['report.matches-plan']);
    expect(failedIds({ ...ready, report: report({ checks: [{ kind: 'test', command: 'npm test', result: 'FAIL', details: '2 failed' }] }) })).toEqual(['report.no-failed-checks']);
    expect(failedIds({ ...ready, report: report({ risks: [{ risk: 'data loss on retry', severity: 'critical', mitigation: '' }] }) })).toEqual(['report.no-critical-risks']);
    expect(failedIds({ ...ready, editsSinceReport: ['src/a.ts'] })).toEqual(['code.unchanged-since-report']);
    for (const input of [{ ...ready, planApproved: false }, { ...ready, editsSinceReport: ['x'] }]) expect(evaluateCompletion(input).passed).toBe(false);
  });

  it('records limitations without refusing DONE', () => {
    const result = evaluateCompletion({ ...ready, report: report({ checks: [{ kind: 'test', command: 'none', result: 'NOT_RUN', details: 'no runner' }], unreportedEdits: ['README.md'], deviationCount: 3 }) });
    expect(result.passed).toBe(true);
    expect(result.conditions.filter((condition) => !condition.passed).map((condition) => `${condition.id}: ${condition.detail}`)).toEqual([
      'checks.ran: no check ran: recorded as a limitation',
      'report.complete: edited but not in the report: README.md',
      'implementation.deviations: 3 deviation(s) recorded during the implementation',
    ]);
  });

  it('names what blocks, briefly', () => {
    const many = Array.from({ length: 12 }, (_, index) => `src/f${index}.ts`);
    expect(evaluateCompletion({ ...ready, editsSinceReport: many }).conditions.find((condition) => condition.id === 'code.unchanged-since-report')?.detail).toMatch(/src\/f9\.ts and 2 more$/);
  });
});
