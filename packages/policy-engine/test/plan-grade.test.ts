import type { AgentRun, AnalysisReportRecord, PlanDocument } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { gradePlan, type PlanGradeInput } from '../src/plan-grade.js';

const plan = (overrides: Partial<PlanDocument> = {}): PlanDocument => ({
  goal: 'Add a greeting helper that formats a personalised welcome message.',
  classification: ['api-backend', 'tests'],
  repositories: ['/repo'],
  currentState: 'src/app.ts exports a constant.',
  changes: [
    { kind: 'add', target: 'src/greeting/greet.ts', description: 'greet(name)' },
    { kind: 'add', target: 'tests/greeting/greet.test.ts', description: 'tests' },
  ],
  architectureImpact: 'New leaf module.',
  crossRepoDependencies: '',
  risks: [{ risk: 'Blank names', severity: 'low', mitigation: 'Fallback' }],
  rollback: 'Delete the files.',
  scope: { include: ['src/greeting/**', 'tests/greeting/**'], exclude: [] },
  steps: [
    { step: 'Write greet', files: ['src/greeting/greet.ts'], dependsOn: [] },
    { step: 'Test it', files: ['tests/greeting/greet.test.ts'], dependsOn: [1] },
  ],
  tests: [{ kind: 'unit', description: 'greet' }],
  regression: 'Nothing imports it.',
  commitSubjects: ['feat(greeting): add greet'],
  qaScenarios: [{ title: 'Greeting', steps: ['Call greet'], expected: 'Hello' }],
  artifact: '',
  definitionOfDone: ['tests pass'],
  openQuestions: [],
  ...overrides,
});

const grade = (document: PlanDocument | undefined, extra: Partial<PlanGradeInput> = {}) => gradePlan({ planVersion: 1, document, analyses: [], agentRuns: [], caseInsensitive: false, ...extra });
const failed = (result: ReturnType<typeof grade>) => result.checks.filter((check) => !check.passed).map((check) => check.id);

const analysis = (id: number, severity: 'low' | 'high' = 'low', gaps: string[] = []): Pick<AnalysisReportRecord, 'id' | 'report' | 'citations'> => ({
  id,
  report: {
    role: 'jerry-risk-analyst',
    scope: 'greeting',
    filesRead: ['src/app.ts'],
    observations: [{ statement: 'x', evidence: ['src/app.ts:1'] }],
    risks: [{ risk: `risk ${id}`, severity, scenario: '' }],
    recommendations: [],
    confidence: { level: 'high', reason: 'small' },
    gaps,
  },
  citations: { checked: 1, missingFiles: [], outOfRange: [] },
});

describe('plan completeness grader', () => {
  it('grades a full plan as complete', () => {
    const result = grade(plan());
    expect(failed(result)).toEqual([]);
    expect(result).toMatchObject({ level: 'complete', score: 100 });
  });

  it('marks a scope-only plan', () => {
    expect(grade(undefined)).toMatchObject({ level: 'scope-only', score: 0, checks: [{ id: 'plan.document', passed: false }] });
  });

  it('finds changes and step files outside the scope, and a whole-repository scope', () => {
    const outside = grade(plan({ changes: [{ kind: 'change', target: 'src/app.ts', description: 'x' }, { kind: 'change', target: 'the login form', description: 'not a path' }], steps: [{ step: 'a', files: ['README.md'], dependsOn: [] }] }));
    expect(failed(outside)).toEqual(['changes.in-scope', 'steps.files-in-scope']);
    expect(outside.level).toBe('incomplete');
    expect(outside.checks.find((check) => check.id === 'changes.in-scope')?.detail).toContain('src/app.ts');
    expect(failed(grade(plan({ scope: { include: ['**'], exclude: [] } })))).toEqual(['scope.narrow']);
    // A directory target counts as in scope when its contents are.
    expect(failed(grade(plan({ changes: [{ kind: 'add', target: 'src/greeting/', description: 'module' }] })))).toEqual([]);
  });

  it('finds step dependencies on itself, later or missing steps', () => {
    const result = grade(plan({ steps: [{ step: 'a', files: [], dependsOn: [2] }, { step: 'b', files: [], dependsOn: [2, 7] }] }));
    expect(failed(result)).toEqual(['steps.order']);
    expect(result.checks.find((check) => check.id === 'steps.order')?.detail).toContain('step 1 → 2');
  });

  it('expects risks, tests that fit the change, and contracts across repositories', () => {
    expect(failed(grade(plan({ risks: [], rollback: '' })))).toEqual(['risks.listed', 'rollback.described']);
    expect(failed(grade(plan({ classification: ['frontend'] })))).toEqual(['tests.fit-change']);
    expect(failed(grade(plan({ classification: ['security'] })))).toEqual(['risks.sensitive-area']);
    expect(failed(grade(plan({ repositories: ['/a', '/b'] })))).toEqual(['cross-repo.contracts']);
  });

  it('asks for open questions when the plan has unknowns, and weighs minor gaps lightly', () => {
    const result = grade(plan({ currentState: 'Test runner: UNKNOWN.', qaScenarios: [], commitSubjects: [], regression: '' }));
    expect(failed(result)).toEqual(['regression.planned', 'qa.scenarios', 'commits.proposed', 'unknowns.raised']);
    expect(result.level).toBe('mostly-complete');
    expect(result.score).toBeGreaterThan(50);
    expect(failed(grade(plan({ currentState: 'Test runner: UNKNOWN.', openQuestions: ['Which runner?'] })))).toEqual([]);
  });

  it('checks that an analysed plan cites its reports, carries gaps and addresses serious risks', () => {
    const analyses = [analysis(1, 'high'), analysis(2, 'low', ['could not run tests'])];
    const runs: Pick<AgentRun, 'agentType' | 'status'>[] = [{ agentType: 'jerry:jerry-quality-analyst', status: 'no-report' }];
    expect(failed(grade(plan(), { analyses, agentRuns: runs }))).toEqual(['analysis.reports-cited', 'analysis.gaps-carried']);
    const partial = grade(plan({ analysis: { reports: [1], gaps: [] } }), { analyses, agentRuns: runs });
    expect(failed(partial)).toEqual(['analysis.reports-cited', 'analysis.gaps-carried']);
    expect(partial.checks.find((check) => check.id === 'analysis.reports-cited')?.detail).toContain('#2');
    expect(failed(grade(plan({ analysis: { reports: [1, 2], gaps: ['quality analyst gave no result'] } }), { analyses, agentRuns: runs }))).toEqual([]);
    expect(failed(grade(plan({ risks: [], analysis: { reports: [1, 2], gaps: ['x'] } }), { analyses }))).toEqual(['risks.listed', 'analysis.risks-addressed']);
  });
});

describe('a plan across several repositories', () => {
  it('checks each change and step file against the scope of the repository it names', () => {
    const multi = plan({
      repositories: ['/api', '/shop'],
      crossRepoDependencies: 'shop calls the api.',
      scope: { include: ['src/**'], exclude: [] },
      repositoryScopes: [{ repository: '/shop', include: ['web/**'], exclude: [] }],
      changes: [
        { kind: 'add', target: 'src/a.ts', description: 'api part', repository: '/api' },
        { kind: 'add', target: 'web/b.ts', description: 'shop part', repository: '/shop' },
      ],
      steps: [
        { step: 'api', files: ['src/a.ts'], dependsOn: [] },
        { step: 'shop', files: ['web/b.ts'], dependsOn: [1], repository: '/shop/' },
      ],
    });
    const passed = (document: PlanDocument, id: string) => grade(document).checks.find((check) => check.id === id)?.passed;
    expect(passed(multi, 'changes.in-scope')).toBe(true);
    expect(passed(multi, 'steps.files-in-scope')).toBe(true);
    // The shop's scope does not cover src/, even though the api's does.
    const wrong = { ...multi, changes: [...multi.changes, { kind: 'add' as const, target: 'src/c.ts', description: 'misplaced', repository: '/shop' }] };
    const check = grade(wrong).checks.find((item) => item.id === 'changes.in-scope')!;
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('src/c.ts (/shop)');
  });
});
