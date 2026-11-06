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
  'task.paused',
  'task.resumed',
  'task.cancelled',
] as const;

/** Who caused a transition: the user, Claude (through MCP) or JERRY Core itself. */
export const WORKFLOW_ACTORS = ['user', 'claude', 'core'] as const;

export const TASK_ID_PATTERN = /^JRY-\d{4,}$/;
export const CORE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
