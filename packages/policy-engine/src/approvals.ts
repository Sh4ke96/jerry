import { createHash } from 'node:crypto';
import type { ApprovalRecord, CoreState, Task } from '@jerry/contracts';
import { comparablePath } from './paths.js';

export interface ApprovedPlan {
  taskId: string;
  planVersion: number;
  scope: readonly string[];
}

/**
 * Deterministic plan hash. An approval is bound to (version, hash); any change to the
 * plan produces a new version and hash, which invalidates earlier approvals.
 */
export function computePlanHash(input: { taskId: string; title: string; repoRoot: string; version: number; scope: readonly string[] }): string {
  const canonical = JSON.stringify({
    taskId: input.taskId,
    title: input.title,
    repoRoot: input.repoRoot,
    version: input.version,
    scope: [...input.scope],
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** The latest decision for the task's current plan version and hash, if any. */
export function currentPlanDecision(task: Task, approvals: readonly ApprovalRecord[]): ApprovalRecord | null {
  const matching = approvals.filter(
    (approval) =>
      approval.taskId === task.taskId &&
      approval.stage === 'PLAN' &&
      approval.version === task.plan.version &&
      approval.contentHash === task.plan.contentHash,
  );
  return matching.at(-1) ?? null;
}

export function isRepoExcluded(state: CoreState, repoRoot: string, platform: NodeJS.Platform): boolean {
  const repoKey = comparablePath(repoRoot, repoRoot, platform);
  return state.excludedRepos.some((exclusion) => comparablePath(exclusion.repoRoot, exclusion.repoRoot, platform) === repoKey);
}

export function approvedPlansForRepo(state: CoreState, repoRoot: string, platform: NodeJS.Platform): ApprovedPlan[] {
  const repoKey = comparablePath(repoRoot, repoRoot, platform);
  return state.tasks
    .filter((task) => comparablePath(task.repoRoot, task.repoRoot, platform) === repoKey)
    .filter((task) => currentPlanDecision(task, state.approvals)?.decision === 'APPROVED')
    .map((task) => ({ taskId: task.taskId, planVersion: task.plan.version, scope: task.plan.scope }));
}
