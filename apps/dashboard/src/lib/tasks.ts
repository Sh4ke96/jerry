import type { ProjectSummary, RepositorySummary, TaskSummary, WorkflowState } from '@jerry/contracts';
import { STATE_LABELS } from '@jerry/workflow';
import { waitsForUser } from '../format';

/** The task filters at the top of the Tasks view. */
export type TaskFilter = 'active' | 'waiting' | 'review' | 'finished' | 'cancelled' | 'all';

/** States of the independent review, from the first reviewer to the re-check of the fixes. */
export const REVIEW_STATES: ReadonlySet<WorkflowState> = new Set(['CODE_REVIEW', 'REVIEW_REPORT', 'REVERIFICATION', 'FIX_IMPLEMENTATION', 'WAIT_REVIEW_FIX_APPROVAL']);

/** States in which Claude runs the reviewers (`/jerry:review`). */
export const REVIEWER_STATES: ReadonlySet<WorkflowState> = new Set(['CODE_REVIEW', 'REVERIFICATION']);

export const TASK_FILTERS: Array<{ id: TaskFilter; label: string; matches: (task: TaskSummary) => boolean }> = [
  { id: 'active', label: 'Active', matches: (task) => task.state !== 'DONE' && task.state !== 'CANCELLED' },
  // FINAL_REPORT counts too: it remains only when Core refused DONE, and then the next step is the user's.
  { id: 'waiting', label: 'Waiting for you', matches: waitsForUser },
  { id: 'review', label: 'In review', matches: (task) => REVIEW_STATES.has(task.state) },
  { id: 'finished', label: 'Finished', matches: (task) => task.state === 'DONE' },
  { id: 'cancelled', label: 'Cancelled', matches: (task) => task.state === 'CANCELLED' },
  { id: 'all', label: 'All', matches: () => true },
];

/** Separators and case differ between the tools that report a path on Windows. */
function normalise(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

export function sameRoot(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

/** True when `path` is `root` or lies inside it. */
export function insideRoot(path: string, root: string): boolean {
  const inner = normalise(path);
  const outer = normalise(root);
  return inner === outer || inner.startsWith(`${outer}/`);
}

/** A repository's name: the last segment of its root. */
export function projectName(repoRoot: string): string {
  const parts = repoRoot.split(/[\\/]+/).filter((part) => part !== '');
  return parts.at(-1) ?? repoRoot;
}

/** The project a task belongs to (the innermost one when projects nest). */
export function projectOf(task: TaskSummary, projects: ProjectSummary[]): ProjectSummary | undefined {
  return projects.filter((project) => insideRoot(task.repoRoot, project.repoRoot)).sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
}

export function tasksOf(repoRoot: string, tasks: TaskSummary[]): TaskSummary[] {
  return tasks.filter((task) => insideRoot(task.repoRoot, repoRoot));
}

export function repositoryOf(repoRoot: string, repositories: RepositorySummary[]): RepositorySummary | undefined {
  return repositories.find((repository) => sameRoot(repository.repoRoot, repoRoot));
}

/** The latest thing that happened to the task. */
export function lastActivity(task: TaskSummary): string {
  const candidates = [task.activity.lastActivityAt, task.lastCheckpoint?.at, task.lastReport?.createdAt, task.finalCheck?.at, task.plan.createdAt, task.createdAt];
  return candidates.filter((value): value is string => typeof value === 'string').sort().at(-1) ?? task.createdAt;
}

const NEXT_STEP: Partial<Record<WorkflowState, string>> = {
  DISCOVERY: 'Claude analyses the repository before planning.',
  PARALLEL_ANALYSIS: 'The analysts are reading the code; Claude then drafts the plan.',
  PLAN_DRAFT: 'Claude revises the plan and submits it for your approval.',
  WAIT_PLAN_APPROVAL: 'Your decision: approve or reject the plan.',
  IMPLEMENTATION: 'Claude implements the approved plan and then submits a report.',
  IMPLEMENTATION_REPORT: 'Claude writes the implementation report.',
  WAIT_IMPLEMENTATION_ACCEPTANCE: 'Your decision: accept the report or request changes.',
  CODE_REVIEW: 'The independent reviewers check the changes: start /jerry:review in Claude Code, or skip the review.',
  REVIEW_REPORT: 'Claude writes the fix plan for the review findings.',
  WAIT_REVIEW_FIX_APPROVAL: 'Your decision: approve or reject the fix plan.',
  FIX_IMPLEMENTATION: 'Claude makes the approved fixes.',
  REVERIFICATION: 'The same reviewers re-check the fixes: run /jerry:review in Claude Code.',
  FINAL_REPORT: 'JERRY did not complete the task: request changes or cancel it.',
  DONE: 'Nothing: the task is done. Committing stays with you.',
  BLOCKED: 'Something blocks the task; see its history.',
  PAUSED: 'Paused by you: resume it to continue.',
  CANCELLED: 'Nothing: the task was cancelled.',
};

/** What happens next, in one sentence (Claude's own next step while it is working). */
export function nextStepText(task: TaskSummary): string {
  const claude = task.lastCheckpoint?.nextSteps[0];
  if (claude !== undefined && (task.state === 'IMPLEMENTATION' || task.state === 'FIX_IMPLEMENTATION')) return `Claude: ${claude}`;
  return NEXT_STEP[task.state] ?? STATE_LABELS[task.state];
}

/** The task's plan and report versions, e.g. "plan v2 · report v1". */
export function versionsText(task: TaskSummary): string {
  const plan = task.goal !== undefined && task.plan.version === 1 && task.plan.document === undefined ? 'no plan yet' : `plan v${task.plan.version}`;
  return task.lastReport === null ? plan : `${plan} · report v${task.lastReport.version}`;
}
