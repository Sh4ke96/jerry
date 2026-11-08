import type { PlanClassification } from '@jerry/contracts';

/**
 * Which independent reviewers a change needs, from what kind of change it is and how big it is:
 * deterministic, like the sizing of the analysis. The correctness reviewer always reviews; the
 * security reviewer joins for sensitive, API or large changes; the design reviewer for UI,
 * refactoring or large changes. A plan without a classification gets all three, as before.
 * (Role ids are spelled out here: the hook bridge bundles this package and must not load Zod.)
 */

export type ReviewerId = 'jerry-correctness-reviewer' | 'jerry-security-reviewer' | 'jerry-design-reviewer';
const ALL: readonly ReviewerId[] = ['jerry-correctness-reviewer', 'jerry-security-reviewer', 'jerry-design-reviewer'];

/** More changed files than this is a large change: every perspective reviews it. */
export const LARGE_CHANGE_FILES = 10;

const SECURITY: ReadonlySet<PlanClassification> = new Set(['security', 'database', 'infrastructure', 'api-backend']);
const DESIGN: ReadonlySet<PlanClassification> = new Set(['ui-ux', 'frontend', 'refactoring']);

export interface ReviewersInput {
  classification?: readonly PlanClassification[] | undefined;
  changedFiles: number;
  repositories: number;
}

export function reviewersFor(input: ReviewersInput): ReviewerId[] {
  const classification = input.classification ?? [];
  if (classification.length === 0) return [...ALL];
  const large = input.changedFiles > LARGE_CHANGE_FILES || input.repositories > 1;
  const chosen = new Set<ReviewerId>(['jerry-correctness-reviewer']);
  if (large || classification.some((kind) => SECURITY.has(kind))) chosen.add('jerry-security-reviewer');
  if (large || classification.some((kind) => DESIGN.has(kind))) chosen.add('jerry-design-reviewer');
  return ALL.filter((role) => chosen.has(role));
}
