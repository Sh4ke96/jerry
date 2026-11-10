import type { TaskSummary } from '@jerry/contracts';
import { WAIVABLE_FINAL_CHECK_CONDITIONS } from '@jerry/contracts/constants';

type Condition = NonNullable<TaskSummary['finalCheck']>['conditions'][number];

/** What fixes one blocking condition of the final checks, and whether re-running them can. */
export interface Remedy {
  /** A re-run evaluates the same report again: only conditions about the repository can change. */
  rerun: boolean;
  text: string;
}

const REMEDIES: Readonly<Record<string, Remedy>> = {
  'plan.approved': { rerun: false, text: 'The plan changed after its approval: approve the current plan version; Claude then reports again.' },
  'report.accepted': { rerun: false, text: 'The latest report is not accepted: accept it, or request changes.' },
  'report.matches-plan': { rerun: false, text: 'The report was written for an older plan version: request changes so Claude reports on the current plan.' },
  'report.no-failed-checks': {
    rerun: false,
    text: 'A check in the report failed: request changes. Claude fixes the code, or, when the failure was expected (a reproduction before the fix), submits the report again with the run on the final code. If it is fine as it is, complete the task anyway with your reason.',
  },
  'report.no-critical-risks': { rerun: false, text: 'The report names a critical risk: request changes so Claude resolves it in a new report, or complete the task anyway with your reason if you accept the risk.' },
  'code.unchanged-since-report': {
    rerun: true,
    text: 'Files changed after the report: re-run the final checks once those edits are gone or a later approved task reported them, request changes so Claude reports them, or complete the task anyway with your reason.',
  },
  'review.done': { rerun: false, text: 'The independent review has not passed: run /jerry:review in Claude Code, or skip the review.' },
};

const FALLBACK: Remedy = { rerun: true, text: 'Request changes so Claude addresses it, or re-run the final checks if something outside the report changed.' };

export function remedyFor(id: string): Remedy {
  return REMEDIES[id] ?? FALLBACK;
}

/** The blocking conditions that failed in the task's latest final checks. */
export function failedBlocking(task: TaskSummary): Condition[] {
  return (task.finalCheck?.conditions ?? []).filter((condition) => condition.blocking && !condition.passed);
}

/** Blockers the user may waive: facts about the work, never their own decisions (the same list Core enforces). */
const WAIVABLE: ReadonlySet<string> = new Set(WAIVABLE_FINAL_CHECK_CONDITIONS);

export function isWaivable(id: string): boolean {
  return WAIVABLE.has(id);
}

/** True when the task waits in FINAL_REPORT and every failed blocker may be waived: 'Complete anyway' is offered. */
export function canWaive(task: TaskSummary): boolean {
  const failed = failedBlocking(task);
  return task.state === 'FINAL_REPORT' && failed.length > 0 && failed.every((condition) => isWaivable(condition.id));
}

/** False when every failed blocking condition is about the report or the plan: a re-run cannot pass. */
export function rerunCanHelp(task: TaskSummary): boolean {
  const failed = failedBlocking(task);
  return failed.length === 0 || failed.some((condition) => remedyFor(condition.id).rerun);
}
