import type { ImplementationReportRecord, WorkflowActor, WorkflowEvent, WorkflowState } from '@jerry/contracts';

/**
 * The task workflow as a pure transition table. Core applies every state change
 * through `applyEvent`; nothing else may set a task's state.
 *
 * Who may cause what:
 *   user    approvals, rejections, accepting or sending back an implementation, pause, resume, cancel
 *   claude  submitting and revising plans, submitting the implementation report
 *   core    completing a task after the final checks (DONE is never set by a model)
 */

// The PURE annotations let bundlers drop what a consumer does not use: the hook bridge needs only
// the labels and WORK_STATES, not the transition table.
export const TERMINAL_STATES: ReadonlySet<WorkflowState> = /* @__PURE__ */ new Set(['DONE', 'CANCELLED']);

/** States in which an approved plan covers edits; everywhere else edits are deviations. */
export const WORK_STATES: ReadonlySet<WorkflowState> = /* @__PURE__ */ new Set(['IMPLEMENTATION', 'FIX_IMPLEMENTATION']);

/** States a task can be paused from (and resumed to). */
const PAUSABLE: readonly WorkflowState[] = [
  'DISCOVERY',
  'PARALLEL_ANALYSIS',
  'PLAN_DRAFT',
  'WAIT_PLAN_APPROVAL',
  'IMPLEMENTATION',
  'IMPLEMENTATION_REPORT',
  'WAIT_IMPLEMENTATION_ACCEPTANCE',
  'CODE_REVIEW',
  'REVIEW_REPORT',
  'WAIT_REVIEW_FIX_APPROVAL',
  'FIX_IMPLEMENTATION',
  'REVERIFICATION',
  'FINAL_REPORT',
  'BLOCKED',
];

interface Rule {
  from: readonly (WorkflowState | null)[];
  /** Target state; `resume` returns to the state the task was paused in. */
  to: WorkflowState | 'resume';
  actors: readonly WorkflowActor[];
}

const RULES: Readonly<Record<WorkflowEvent, Rule>> = {
  // Analysis first: a task starts in discovery, analysts' reports move it on, and the
  // plan submitted after them completes the analysis.
  'task.started': { from: [null], to: 'DISCOVERY', actors: ['user', 'claude'] },
  'analysis.started': { from: ['DISCOVERY'], to: 'PARALLEL_ANALYSIS', actors: ['core', 'claude', 'user'] },
  'analysis.completed': { from: ['PARALLEL_ANALYSIS'], to: 'PLAN_DRAFT', actors: ['core', 'claude', 'user'] },
  'plan.submitted': { from: [null], to: 'WAIT_PLAN_APPROVAL', actors: ['user', 'claude'] },
  'plan.revised': {
    from: ['DISCOVERY', 'PARALLEL_ANALYSIS', 'PLAN_DRAFT', 'WAIT_PLAN_APPROVAL', 'IMPLEMENTATION', 'WAIT_IMPLEMENTATION_ACCEPTANCE', 'BLOCKED'],
    to: 'WAIT_PLAN_APPROVAL',
    actors: ['user', 'claude'],
  },
  // A rejected plan can still be approved unchanged if the user reconsiders.
  'plan.approved': { from: ['WAIT_PLAN_APPROVAL', 'PLAN_DRAFT'], to: 'IMPLEMENTATION', actors: ['user'] },
  // Rejecting during implementation withdraws the approval: edits are deviations again.
  'plan.rejected': { from: ['WAIT_PLAN_APPROVAL', 'IMPLEMENTATION'], to: 'PLAN_DRAFT', actors: ['user'] },
  'report.submitted': { from: ['IMPLEMENTATION'], to: 'WAIT_IMPLEMENTATION_ACCEPTANCE', actors: ['claude', 'user'] },
  // Also from the final checks: when Core refuses DONE, the user sends the work back.
  // After a review the user may send it back too, instead of a fix plan.
  'changes.requested': { from: ['WAIT_IMPLEMENTATION_ACCEPTANCE', 'FINAL_REPORT', 'REVIEW_REPORT'], to: 'IMPLEMENTATION', actors: ['user'] },
  // An accepted implementation goes to independent review.
  'implementation.accepted': { from: ['WAIT_IMPLEMENTATION_ACCEPTANCE'], to: 'CODE_REVIEW', actors: ['user'] },
  // A review round is complete: all three reviewers submitted (Core), or Claude closed it with gaps.
  'review.reported': { from: ['CODE_REVIEW', 'REVERIFICATION'], to: 'REVIEW_REPORT', actors: ['core', 'claude'] },
  // No open P1–P3 review finding: Core moves on to the final checks.
  'review.passed': { from: ['REVIEW_REPORT'], to: 'FINAL_REPORT', actors: ['core'] },
  // The user waives the (rest of the) review, with a reason.
  'review.skipped': { from: ['CODE_REVIEW', 'REVIEW_REPORT', 'WAIT_REVIEW_FIX_APPROVAL', 'REVERIFICATION'], to: 'FINAL_REPORT', actors: ['user'] },
  // Claude's remediation plan for the review findings, and its revisions; only the user approves it.
  'fixes.proposed': { from: ['REVIEW_REPORT', 'WAIT_REVIEW_FIX_APPROVAL'], to: 'WAIT_REVIEW_FIX_APPROVAL', actors: ['claude', 'user'] },
  'fixes.approved': { from: ['WAIT_REVIEW_FIX_APPROVAL'], to: 'FIX_IMPLEMENTATION', actors: ['user'] },
  'fixes.rejected': { from: ['WAIT_REVIEW_FIX_APPROVAL'], to: 'REVIEW_REPORT', actors: ['user'] },
  // The fixes are done: the same reviewers check again.
  'fixes.reported': { from: ['FIX_IMPLEMENTATION'], to: 'REVERIFICATION', actors: ['claude', 'user'] },
  'task.completed': { from: ['FINAL_REPORT'], to: 'DONE', actors: ['core'] },
  'task.paused': { from: PAUSABLE, to: 'PAUSED', actors: ['user'] },
  'task.resumed': { from: ['PAUSED'], to: 'resume', actors: ['user'] },
  'task.cancelled': { from: /* @__PURE__ */ PAUSABLE.concat('PAUSED'), to: 'CANCELLED', actors: ['user'] },
};

export type TransitionResult = { ok: true; to: WorkflowState } | { ok: false; reason: string };

/**
 * Validates one transition. `pausedFrom` is the state a PAUSED task returns to on resume (taken
 * from its transition history by the caller).
 */
export function applyEvent(current: WorkflowState | null, event: WorkflowEvent, actor: WorkflowActor, pausedFrom: WorkflowState | null = null): TransitionResult {
  const rule = RULES[event];
  if (!rule.actors.includes(actor)) {
    return { ok: false, reason: `${event} can only be done by ${rule.actors.join(' or ')}, not by ${actor}` };
  }
  if (!rule.from.includes(current)) {
    return { ok: false, reason: `${event} is not possible while the task is ${current ?? 'new'}` };
  }
  if (rule.to === 'resume') {
    if (pausedFrom === null || pausedFrom === 'PAUSED') return { ok: false, reason: 'the state before the pause is unknown' };
    return { ok: true, to: pausedFrom };
  }
  return { ok: true, to: rule.to };
}

/** Events the given actor may send now; used for buttons in the dashboard and hints to Claude. */
export function availableEvents(current: WorkflowState, actor: WorkflowActor): WorkflowEvent[] {
  return (Object.keys(RULES) as WorkflowEvent[]).filter((event) => RULES[event].actors.includes(actor) && RULES[event].from.includes(current));
}

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}

/** One condition of the final checks; blocking ones decide DONE, the others are recorded limitations. */
export interface CompletionCondition {
  id: string;
  blocking: boolean;
  passed: boolean;
  detail: string;
}

export interface CompletionInput {
  currentPlanVersion: number;
  /** The user approved exactly the current plan version and hash. */
  planApproved: boolean;
  /** The latest implementation report, if any. */
  report: Pick<ImplementationReportRecord, 'version' | 'planVersion' | 'document' | 'evidence'> | null;
  /** The user accepted exactly that report version and hash. */
  reportAccepted: boolean;
  /** In-scope files edited with the file tools after the report was submitted. */
  editsSinceReport: readonly string[];
  /** From the approved plan; the user's acceptance confirms it. */
  definitionOfDone: readonly string[];
  /**
   * The independent review. Absent for tasks accepted before reviews existed.
   * outcome: passed (no open P1–P3 review finding), skipped (the user waived it), or null.
   */
  review?: { outcome: 'passed' | 'skipped' | null; rounds: number; reason: string; uncovered: readonly string[]; notIndependent: readonly string[]; openFindings: readonly string[] };
}

const list = (items: readonly string[], max = 10): string => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);

/**
 * The DONE validator. Pure: Core gathers the facts and applies the
 * result; a model can never set DONE. Every blocking condition must pass.
 */
export function evaluateCompletion(input: CompletionInput): { passed: boolean; conditions: CompletionCondition[] } {
  const { report } = input;
  const conditions: CompletionCondition[] = [];
  const add = (id: string, blocking: boolean, passed: boolean, detail: string): void => {
    conditions.push({ id, blocking, passed, detail });
  };

  add('plan.approved', true, input.planApproved, input.planApproved ? `plan v${input.currentPlanVersion} is approved by the user` : `plan v${input.currentPlanVersion} is not approved in its current version`);
  if (report === null) {
    add('report.accepted', true, false, 'there is no implementation report');
    return { passed: false, conditions };
  }
  const dod = input.definitionOfDone.length === 0 ? 'the plan has no Definition of Done (scope-only plan)' : `confirming the plan's Definition of Done (${input.definitionOfDone.length} item(s))`;
  add('report.accepted', true, input.reportAccepted, input.reportAccepted ? `report v${report.version} is accepted by the user, ${dod}` : `report v${report.version} is not accepted`);
  add(
    'report.matches-plan',
    true,
    report.planVersion === input.currentPlanVersion,
    report.planVersion === input.currentPlanVersion ? `report v${report.version} covers plan v${report.planVersion}` : `report v${report.version} was written for plan v${report.planVersion}, the plan is now v${input.currentPlanVersion}`,
  );
  const failed = report.document.checks.filter((check) => check.result === 'FAIL').map((check) => check.command);
  add('report.no-failed-checks', true, failed.length === 0, failed.length === 0 ? 'no check failed' : `failed: ${list(failed)}`);
  const critical = report.document.risks.filter((risk) => risk.severity === 'critical').map((risk) => risk.risk);
  add('report.no-critical-risks', true, critical.length === 0, critical.length === 0 ? 'no critical risk is open' : `critical risk open: ${list(critical)}`);
  add(
    'code.unchanged-since-report',
    true,
    input.editsSinceReport.length === 0,
    input.editsSinceReport.length === 0 ? 'no in-scope file was edited after the report' : `edited after report v${report.version} was submitted: ${list(input.editsSinceReport)}`,
  );

  const ran = report.document.checks.some((check) => check.result === 'PASS');
  add('checks.ran', false, ran, ran ? 'at least one check ran and passed' : 'no check ran: recorded as a limitation');
  const { unreportedEdits, deviationCount } = report.evidence;
  add('report.complete', false, unreportedEdits.length === 0, unreportedEdits.length === 0 ? 'every observed edit is in the report' : `edited but not in the report: ${list(unreportedEdits)}`);
  add('implementation.deviations', false, deviationCount === 0, deviationCount === 0 ? 'no deviation was recorded' : `${deviationCount} deviation(s) recorded during the implementation`);

  // Independent review: it must have passed or been waived by the user.
  const review = input.review;
  if (review !== undefined) {
    const outcome =
      review.outcome === 'passed'
        ? `review passed after ${review.rounds} round(s)`
        : review.outcome === 'skipped'
          ? `the user waived the review${review.reason === '' ? '' : `: ${review.reason}`}`
          : 'the independent review has not passed';
    add('review.done', true, review.outcome !== null, outcome);
    add('review.coverage', false, review.uncovered.length === 0, review.uncovered.length === 0 ? 'every changed file was reviewed' : `changed files no reviewer covered: ${list(review.uncovered)}`);
    add('review.independent', false, review.notIndependent.length === 0, review.notIndependent.length === 0 ? 'no reviewer had edited the task' : `reviewers who also edited the task: ${list(review.notIndependent)}`);
    if (review.outcome === 'skipped') add('review.open-findings', false, review.openFindings.length === 0, review.openFindings.length === 0 ? 'no review finding left open' : `left open: ${list(review.openFindings, 5)}`);
  }

  // Continuous quality: recorded limitations, never a block; the user decides what to do about them.
  const quality = report.evidence.quality;
  if (quality !== undefined) {
    add('quality.no-serious-findings', false, quality.serious.length === 0, quality.serious.length === 0 ? 'no open P1 or P2 finding at the report' : `open at the report: ${list(quality.serious, 5)}`);
    add('tests.claims-match-observed', false, quality.claimedVsObserved.length === 0, quality.claimedVsObserved.length === 0 ? 'no check the report claims passed was seen failing' : list(quality.claimedVsObserved, 5));
  }

  return { passed: conditions.every((condition) => !condition.blocking || condition.passed), conditions };
}

/** Plain-language label for UIs and CLI output. */
export const STATE_LABELS: Readonly<Record<WorkflowState, string>> = {
  DISCOVERY: 'Discovery',
  PARALLEL_ANALYSIS: 'Analysis',
  PLAN_DRAFT: 'Plan needs changes',
  WAIT_PLAN_APPROVAL: 'Waiting for plan approval',
  IMPLEMENTATION: 'In implementation',
  IMPLEMENTATION_REPORT: 'Writing report',
  WAIT_IMPLEMENTATION_ACCEPTANCE: 'Waiting for acceptance',
  CODE_REVIEW: 'In code review',
  REVIEW_REPORT: 'Review report',
  WAIT_REVIEW_FIX_APPROVAL: 'Waiting for fix approval',
  FIX_IMPLEMENTATION: 'Fixing review findings',
  REVERIFICATION: 'Re-verification',
  // A task stays here only when Core's final checks refused DONE.
  FINAL_REPORT: 'Final checks failed',
  DONE: 'Done',
  BLOCKED: 'Blocked',
  PAUSED: 'Paused',
  CANCELLED: 'Cancelled',
};

export { diffPlans, isEmptyDiff, type PlanDiff, type PlanSectionDiff } from './plan-diff.js';
export { globsOverlap, planLayers, type PlanLayers, type PlanStepNode } from './plan-dag.js';
