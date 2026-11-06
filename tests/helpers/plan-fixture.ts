import type { PlanDocument } from '@jerry/contracts';

/** A complete plan document as Claude would submit it through jerry_submit_plan. */
export function samplePlan(repoRoot: string, scope: string[] = ['src/greeting/**', 'tests/greeting/**']): PlanDocument {
  return {
    goal: 'Add a greeting helper that formats a personalised welcome message.',
    classification: ['api-backend', 'tests'],
    repositories: [repoRoot],
    currentState: 'src/app.ts exports a single constant; there is no greeting module. Test runner: UNKNOWN.',
    changes: [
      { kind: 'add', target: 'src/greeting/greet.ts', description: 'greet(name) returns "Hello, <name>!" and trims input' },
      { kind: 'add', target: 'tests/greeting/greet.test.ts', description: 'unit tests for greet' },
    ],
    architectureImpact: 'New leaf module; nothing imports it yet.',
    crossRepoDependencies: '',
    risks: [{ risk: 'Empty names produce an odd greeting', severity: 'low', mitigation: 'Fall back to "Hello!" for blank input' }],
    rollback: 'Delete the two new files.',
    scope: { include: scope, exclude: ['src/app.ts'] },
    steps: [
      { step: 'Write greet with input trimming', files: ['src/greeting/greet.ts'], dependsOn: [] },
      { step: 'Add unit tests', files: ['tests/greeting/greet.test.ts'], dependsOn: [1] },
    ],
    tests: [{ kind: 'unit', description: 'greet trims, handles blank input and Unicode names' }],
    regression: 'No existing code changes.',
    commitSubjects: ['feat(greeting): add greet helper'],
    qaScenarios: [{ title: 'Greeting appears', steps: ['Call greet("Ada")'], expected: 'Hello, Ada!' }],
    artifact: '',
    definitionOfDone: ['greet implemented', 'unit tests pass'],
    openQuestions: ['Should greetings be localised?'],
  };
}
