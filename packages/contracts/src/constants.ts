/**
 * Plain constants, free of any runtime dependency. The hook bridge runs on every guarded tool call
 * and imports only this module from the contracts, so it starts without loading Zod.
 * The Zod schemas in index.ts are built from these same lists, so there is one source of truth.
 */

export const JERRY_VERSION = '0.1.0';

export const EVENT_SCHEMA_VERSION = 1;

export const HOOK_EVENT_TYPES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
] as const;

export const GATE_VERDICTS = ['PASS', 'WARN', 'DENY'] as const;

/**
 * Task workflow states, plus PAUSED and CANCELLED.
 */
export const WORKFLOW_STATES = [
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
  'DONE',
  'BLOCKED',
  'PAUSED',
  'CANCELLED',
] as const;

/**
 * The workflow states an added skill can be assigned to: the open states in which Claude works on a
 * task. Terminal, paused and blocked tasks have no next step, so nothing would start a skill there.
 */
export const SKILL_TRIGGER_STATES: ReadonlyArray<(typeof WORKFLOW_STATES)[number]> = WORKFLOW_STATES.filter((state) => state !== 'DONE' && state !== 'CANCELLED' && state !== 'PAUSED' && state !== 'BLOCKED');

/** The kinds of change a plan is classified as; added skills can be assigned to them too. */
export const PLAN_CLASSIFICATIONS = ['ui-ux', 'frontend', 'api-backend', 'database', 'infrastructure', 'security', 'docs', 'tests', 'refactoring', 'tooling'] as const;

/**
 * Whether JERRY starts an added skill for a task: the task is in one of the skill's states, and the
 * skill is for every change (no kinds), or the task has no classification yet (its plan is not
 * written), or the plan shares one of the skill's kinds. One rule for the next action and the gate;
 * kept here, free of dependencies, because the hook bridge bundles the gate.
 */
export function skillApplies(
  skill: { states: readonly (typeof WORKFLOW_STATES)[number][]; classifications?: readonly (typeof PLAN_CLASSIFICATIONS)[number][] | undefined },
  task: { state: (typeof WORKFLOW_STATES)[number]; classification?: readonly (typeof PLAN_CLASSIFICATIONS)[number][] | undefined },
): boolean {
  if (!skill.states.includes(task.state)) return false;
  const kinds = skill.classifications ?? [];
  if (kinds.length === 0) return true;
  const own = task.classification ?? [];
  return own.length === 0 || own.some((kind) => kinds.includes(kind));
}

/** What moves a task between states. */
export const WORKFLOW_EVENTS = [
  'task.started',
  'analysis.started',
  'analysis.completed',
  'plan.submitted',
  'plan.revised',
  'plan.approved',
  'plan.rejected',
  'report.submitted',
  'changes.requested',
  'implementation.accepted',
  'review.reported',
  'review.passed',
  'review.skipped',
  'fixes.proposed',
  'fixes.approved',
  'fixes.rejected',
  'fixes.reported',
  'task.completed',
  // The user completes a task the final checks refused, with a reason (a recorded waiver).
  'final-checks.waived',
  'task.paused',
  'task.resumed',
  'task.cancelled',
] as const;

/**
 * Blocking final-check conditions the user may waive to complete a task anyway: facts about the
 * work (a failed check, a critical risk, edits after the report). Conditions about the user's own
 * decisions (the approved plan and report versions, the review) and any condition not listed here
 * are never waivable.
 */
export const WAIVABLE_FINAL_CHECK_CONDITIONS = ['report.no-failed-checks', 'report.no-critical-risks', 'code.unchanged-since-report'] as const;

/** Who caused a transition: the user, Claude (through MCP) or JERRY Core itself. */
export const WORKFLOW_ACTORS = ['user', 'claude', 'core'] as const;

export const TASK_ID_PATTERN = /^JRY-\d{4,}$/;
export const CORE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
