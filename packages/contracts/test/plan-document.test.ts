import { describe, expect, it } from 'vitest';
import { samplePlan } from '../../../tests/helpers/plan-fixture.js';
import { planDocumentSchema } from '../src/index.js';

describe('planDocumentSchema', () => {
  it('accepts a complete plan', () => {
    expect(planDocumentSchema.safeParse(samplePlan('D:/Work/repo')).success).toBe(true);
  });

  it('fills optional sections with empty defaults', () => {
    const { crossRepoDependencies: _a, risks: _b, rollback: _c, regression: _d, commitSubjects: _e, qaScenarios: _f, artifact: _g, openQuestions: _h, ...minimal } = samplePlan('D:/Work/repo');
    const parsed = planDocumentSchema.parse({ ...minimal, scope: { include: ['src/**'] } });
    expect(parsed).toMatchObject({ risks: [], rollback: '', openQuestions: [], scope: { include: ['src/**'], exclude: [] } });
  });

  it.each(['goal', 'classification', 'repositories', 'currentState', 'changes', 'architectureImpact', 'scope', 'steps', 'tests', 'definitionOfDone'])('requires %s', (field) => {
    const plan: Record<string, unknown> = { ...samplePlan('D:/Work/repo') };
    delete plan[field];
    expect(planDocumentSchema.safeParse(plan).success).toBe(false);
  });

  it('rejects an empty scope, empty lists of changes or tests, and unknown values', () => {
    const plan = samplePlan('D:/Work/repo');
    expect(planDocumentSchema.safeParse({ ...plan, scope: { include: [] } }).success).toBe(false);
    expect(planDocumentSchema.safeParse({ ...plan, changes: [] }).success).toBe(false);
    expect(planDocumentSchema.safeParse({ ...plan, tests: [] }).success).toBe(false);
    expect(planDocumentSchema.safeParse({ ...plan, classification: ['marketing'] }).success).toBe(false);
    expect(planDocumentSchema.safeParse({ ...plan, goal: '   ' }).success).toBe(false);
  });
});
