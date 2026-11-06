import type { ImplementationReport } from '@jerry/contracts';

/** A complete implementation report for the greeting plan in plan-fixture.ts. */
export function sampleReport(paths: readonly string[] = ['src/greeting/greet.ts', 'tests/greeting/greet.test.ts']): ImplementationReport {
  return {
    summary: 'Added greet(name) and its unit test.',
    changes: paths.map((path) => ({ repository: '', path, kind: 'added' as const, description: path.includes('test') ? 'unit test for greet' : 'greet helper' })),
    agents: [],
    skills: [{ name: 'test-engineering', used: true, note: '' }],
    checks: [
      { kind: 'test', command: 'npm test', result: 'PASS', details: '12 passed' },
      { kind: 'lint', command: 'npm run lint', result: 'NOT_RUN', details: 'no lint script in this repository' },
    ],
    planDeviations: [],
    risks: [{ risk: 'Names with emoji are not normalised', severity: 'low', mitigation: 'covered by a follow-up' }],
    commitSubjects: ['feat(greeting): add greet helper'],
    qaScenarios: [
      {
        id: 'QA-1',
        priority: 'P2',
        title: 'Greeting for a named user',
        location: 'node -e "greet(\'Ada\')"',
        roles: [],
        preconditions: '',
        testData: 'name: Ada',
        steps: ['Call greet("Ada")'],
        expected: 'Returns "Hello, Ada!"',
        negative: 'An empty name does not throw',
        related: '',
        kind: 'new',
      },
    ],
    artifact: '',
  };
}
