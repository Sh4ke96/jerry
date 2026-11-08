// The agents module only: the hook bridge bundles the policy engine and must not load Zod.
import type { AnalysisDepth, PlanClassification } from '@jerry/contracts';
import { ANALYST_ROLES, type AnalystRole } from '@jerry/contracts/agents';
import { matchesAnyGlob } from './paths.js';

/**
 * Which of JERRY's analysts a change needs, from what kind of change it is: deterministic, so the
 * same intake always gets the same suggestion. Sensitive changes get all three; small ones only the
 * perspectives they touch; a docs-only change needs none. Claude runs the suggested analysts; more
 * only when the user asks (depth "full").
 */

export interface AnalystsInput {
  /** What kind of change it is; absent: all three, as before JERRY sized analyses. */
  classification?: readonly PlanClassification[] | undefined;
  depth?: AnalysisDepth | undefined;
  /** Repo-relative globs of the area to analyse. */
  focus: readonly string[];
  /** How many repositories the change spans (a workspace's task may span several). */
  repositoryCount?: number;
  /** Repo-relative paths of the repository's API schemas and migrations (from its profile). */
  sensitivePaths?: readonly string[];
  caseInsensitive: boolean;
}

export interface AnalystsSuggestion {
  roles: AnalystRole[];
  /** Why, in a few words each: shown to Claude and kept with the task. */
  reasons: string[];
}

const ALL: readonly AnalystRole[] = ANALYST_ROLES;
const ARCHITECTURE: AnalystRole = 'jerry-architecture-analyst';
const QUALITY: AnalystRole = 'jerry-quality-analyst';

/** Kinds of change that always get the whole analysis. */
const SENSITIVE: ReadonlySet<PlanClassification> = new Set(['security', 'database', 'infrastructure']);

export function analystsFor(input: AnalystsInput): AnalystsSuggestion {
  const all = (reason: string): AnalystsSuggestion => ({ roles: [...ALL], reasons: [reason] });
  if (input.depth === 'full') return all('the user asked for the full analysis');
  const classification = input.classification ?? [];
  if (classification.length === 0) return all('no classification given');

  const sensitive = classification.filter((kind) => SENSITIVE.has(kind));
  if (sensitive.length > 0) return all(`${sensitive.join(' and ')} change`);
  if ((input.repositoryCount ?? 1) > 1) return all(`spans ${input.repositoryCount} repositories`);
  // A migrations entry may be a folder: its contents count.
  const touched = (input.sensitivePaths ?? [])
    .map((file) => file.replaceAll('\\', '/').replace(/\/+$/, ''))
    .filter((file) => matchesAnyGlob(file, input.focus, input.caseInsensitive) || matchesAnyGlob(`${file}/x`, input.focus, input.caseInsensitive));
  if (touched.length > 0) return all(`the focus covers API schemas or migrations (${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ', …' : ''})`);

  const roles = new Set<AnalystRole>();
  const reasons: string[] = [];
  const need = (role: AnalystRole, reason: string): void => {
    roles.add(role);
    reasons.push(reason);
  };
  for (const kind of classification) {
    if (kind === 'api-backend' || kind === 'refactoring') need(ARCHITECTURE, `${kind}: architecture, contracts and impact`);
    if (kind === 'api-backend' || kind === 'refactoring' || kind === 'ui-ux' || kind === 'frontend' || kind === 'tests' || kind === 'tooling') need(QUALITY, `${kind}: tests, regression${kind === 'ui-ux' || kind === 'frontend' ? ', UI and accessibility' : ''}`);
  }
  if (roles.size === 0) return { roles: [], reasons: [`${classification.join(' and ')} only: no analyst needed, plan directly`] };
  // In the analysts' own order, each reason once.
  return { roles: ALL.filter((role) => roles.has(role)), reasons: [...new Set(reasons)] };
}

/** The analysts a plan's final classification would have been suggested, for the completeness check. */
export function analystsForClassification(classification: readonly PlanClassification[], repositoryCount: number): AnalystRole[] {
  return analystsFor({ classification, focus: [], repositoryCount, caseInsensitive: false }).roles;
}
