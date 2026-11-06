import { createHash } from 'node:crypto';
import type { ApprovalRecord, CoreState, Task } from '@jerry/contracts';
import { WORK_STATES } from '@jerry/workflow';
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
export function computePlanHash(input: { taskId: string; title: string; repoRoot: string; version: number; scope: readonly string[]; document?: unknown }): string {
  const canonical = JSON.stringify({
    taskId: input.taskId,
    title: input.title,
    repoRoot: input.repoRoot,
    version: input.version,
    scope: [...input.scope],
    // The whole plan document is part of what the user approves. Plans without one keep the hash
    // they always had (an absent key does not change the JSON).
    ...(input.document === undefined ? {} : { document: canonicalize(input.document) }),
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Hash of an implementation report version; the user's acceptance binds to it (ADR 0014). */
export function computeReportHash(input: { taskId: string; version: number; planVersion: number; document: unknown }): string {
  const canonical = JSON.stringify({ kind: 'implementation-report', taskId: input.taskId, version: input.version, planVersion: input.planVersion, document: canonicalize(input.document) });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/** Sorted object keys, so the same document always hashes the same however it was assembled. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The latest decision bound to exactly this stage, version and hash, if any. */
export function decisionFor(approvals: readonly ApprovalRecord[], subject: { taskId: string; stage: ApprovalRecord['stage']; version: number; contentHash: string }): ApprovalRecord | null {
  const matching = approvals.filter(
    (approval) => approval.taskId === subject.taskId && approval.stage === subject.stage && approval.version === subject.version && approval.contentHash === subject.contentHash,
  );
  return matching.at(-1) ?? null;
}

/** The latest decision for the task's current plan version and hash, if any. */
export function currentPlanDecision(task: Task, approvals: readonly ApprovalRecord[]): ApprovalRecord | null {
  return decisionFor(approvals, { taskId: task.taskId, stage: 'PLAN', version: task.plan.version, contentHash: task.plan.contentHash });
}

export function isRepoExcluded(state: CoreState, repoRoot: string, platform: NodeJS.Platform): boolean {
  const repoKey = comparablePath(repoRoot, repoRoot, platform);
  return state.excludedRepos.some((exclusion) => comparablePath(exclusion.repoRoot, exclusion.repoRoot, platform) === repoKey);
}

/**
 * Plans that cover edits right now: the task is being implemented (ADR 0012) and the user approved
 * exactly its current plan. A paused task, or one waiting for acceptance, covers nothing.
 */
export function approvedPlansForRepo(state: CoreState, repoRoot: string, platform: NodeJS.Platform): ApprovedPlan[] {
  const repoKey = comparablePath(repoRoot, repoRoot, platform);
  return state.tasks
    .filter((task) => comparablePath(task.repoRoot, task.repoRoot, platform) === repoKey)
    .filter((task) => WORK_STATES.has(task.state))
    .filter((task) => currentPlanDecision(task, state.approvals)?.decision === 'APPROVED')
    .map((task) => ({ taskId: task.taskId, planVersion: task.plan.version, scope: task.plan.scope }));
}
