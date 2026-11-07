import type { PlanDocument } from '@jerry/contracts';

/** A complete plan document as Claude would submit it through submit_plan. */
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

/**
 * A plan across several repositories of a workspace: the first is the task's own (plan scope), the
 * others get their own scopes. Every change and step names its repository.
 */
export function sampleMultiRepoPlan(repoRoots: string[], scope: string[] = ['src/**', 'tests/**']): PlanDocument {
  const [own, ...others] = repoRoots;
  if (own === undefined) throw new Error('sampleMultiRepoPlan needs at least one repository');
  const base = samplePlan(own, scope);
  return {
    ...base,
    goal: 'Add a greeting feature across the workspace: each repository gets only its own part.',
    repositories: repoRoots,
    changes: repoRoots.map((repository) => ({ kind: 'add' as const, target: 'src/greeting/greet.ts', description: `greeting in ${repository}`, repository })),
    crossRepoDependencies: 'shop and admin call the greeting endpoint of api.',
    repositoryScopes: others.map((repository) => ({ repository, include: scope, exclude: [] })),
    steps: repoRoots.map((repository, index) => ({ step: `Greeting in ${repository}`, files: ['src/greeting/greet.ts'], dependsOn: index === 0 ? [] : [1], repository })),
  };
}
