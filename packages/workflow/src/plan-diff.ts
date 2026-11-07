import type { Plan, PlanDocument } from '@jerry/contracts';

/**
 * What changed between two versions of a plan, section by section, so the user reviews
 * a revision instead of re-reading the whole plan. Pure and browser-safe: the dashboard and the CLI
 * compute it from the stored versions.
 */

export interface PlanSectionDiff {
  section: string;
  /** Text sections: the old and the new text. */
  before?: string;
  after?: string;
  /** List sections: items only in the newer version, and items only in the older one. */
  added: string[];
  removed: string[];
}

export interface PlanDiff {
  from: number;
  to: number;
  /** The globs JERRY checks edits against. */
  scope: { added: string[]; removed: string[] };
  /** A full document appeared (e.g. an intake turned into a plan) or disappeared. */
  document: 'unchanged' | 'added' | 'removed' | 'none';
  sections: PlanSectionDiff[];
}

const TEXT_SECTIONS: ReadonlyArray<[keyof PlanDocument, string]> = [
  ['goal', 'Goal'],
  ['currentState', 'Current state'],
  ['architectureImpact', 'Architecture impact'],
  ['crossRepoDependencies', 'Cross-repository dependencies'],
  ['rollback', 'Rollback'],
  ['regression', 'Regression'],
  ['artifact', 'Artifact'],
];

/** List sections with one line per item, the way the user reads them. */
const LIST_SECTIONS: ReadonlyArray<[string, (plan: PlanDocument) => string[]]> = [
  ['Classification', (plan) => plan.classification],
  ['Repositories', (plan) => plan.repositories],
  ['Changes', (plan) => plan.changes.map((change) => `${change.kind} ${change.target}${inRepository(change.repository)}: ${change.description}`)],
  ['Risks', (plan) => plan.risks.map((risk) => `[${risk.severity}] ${risk.risk} → ${risk.mitigation}`)],
  ['Out of scope', (plan) => plan.scope.exclude],
  // A multi-repository plan: each other repository's globs, one line per glob.
  [
    'Repository scopes',
    (plan) => (plan.repositoryScopes ?? []).flatMap((scope) => [...scope.include.map((glob) => `${scope.repository}: ${glob}`), ...scope.exclude.map((glob) => `${scope.repository}: not ${glob}`)]),
  ],
  [
    'Steps',
    (plan) =>
      plan.steps.map((step) => {
        const details = [step.files.length > 0 ? `files: ${step.files.join(', ')}` : '', step.dependsOn.length > 0 ? `after step ${step.dependsOn.join(', ')}` : ''].filter(Boolean);
        if (step.repository !== undefined) details.unshift(`in ${step.repository}`);
        return details.length === 0 ? step.step : `${step.step} (${details.join('; ')})`;
      }),
  ],
  ['Tests', (plan) => plan.tests.map((test) => `${test.kind}: ${test.description}`)],
  ['Proposed commits', (plan) => plan.commitSubjects],
  ['Manual QA', (plan) => plan.qaScenarios.map((scenario) => `${scenario.title}: ${scenario.steps.join(' → ')} ⇒ ${scenario.expected}`)],
  ['Definition of Done', (plan) => plan.definitionOfDone],
  ['Open questions', (plan) => plan.openQuestions],
  ['Analysis reports', (plan) => (plan.analysis?.reports ?? []).map((id) => `#${id}`)],
  ['Analysis gaps', (plan) => plan.analysis?.gaps ?? []],
];

/** " (in <repository>)" when a change names its repository. */
const inRepository = (repository: string | undefined): string => (repository === undefined ? '' : ` (in ${repository})`);

/** Items of `after` not matched in `before`, counting duplicates (a multiset difference). */
function only(after: readonly string[], before: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const item of before) left.set(item, (left.get(item) ?? 0) + 1);
  const result: string[] = [];
  for (const item of after) {
    const count = left.get(item) ?? 0;
    if (count > 0) left.set(item, count - 1);
    else result.push(item);
  }
  return result;
}

export function diffPlans(older: Pick<Plan, 'version' | 'scope' | 'document'>, newer: Pick<Plan, 'version' | 'scope' | 'document'>): PlanDiff {
  const sections: PlanSectionDiff[] = [];
  const a = older.document;
  const b = newer.document;
  const document = a === undefined ? (b === undefined ? 'none' : 'added') : b === undefined ? 'removed' : 'unchanged';
  const empty = (plan: PlanDocument | undefined, read: (plan: PlanDocument) => string[]): string[] => (plan === undefined ? [] : read(plan));

  for (const [key, label] of TEXT_SECTIONS) {
    const before = a === undefined ? '' : String(a[key] ?? '');
    const after = b === undefined ? '' : String(b[key] ?? '');
    if (before.trim() !== after.trim()) sections.push({ section: label, before, after, added: [], removed: [] });
  }
  for (const [label, read] of LIST_SECTIONS) {
    const before = empty(a, read);
    const after = empty(b, read);
    const added = only(after, before);
    const removed = only(before, after);
    if (added.length > 0 || removed.length > 0) sections.push({ section: label, added, removed });
  }
  return {
    from: older.version,
    to: newer.version,
    scope: { added: only(newer.scope, older.scope), removed: only(older.scope, newer.scope) },
    document,
    sections,
  };
}

/** True when the two versions differ in nothing the user reviews. */
export function isEmptyDiff(diff: PlanDiff): boolean {
  return diff.scope.added.length === 0 && diff.scope.removed.length === 0 && diff.sections.length === 0 && (diff.document === 'unchanged' || diff.document === 'none');
}
