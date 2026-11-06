/**
 * Plain constants, free of any runtime dependency. The hook bridge runs on every guarded tool call
 * and imports only this module from the contracts, so it starts without loading Zod (ADR 0010).
 * The Zod schemas in index.ts are built from these same lists, so there is one source of truth.
 */

export const JERRY_VERSION = '0.0.1-m0';

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
 * Task workflow states (spec §7.1), plus PAUSED and CANCELLED. The review states exist from the start
 * so later milestones only add transitions.
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
  'plan.submitted',
  'plan.revised',
  'plan.approved',
  'plan.rejected',
  'report.submitted',
  'changes.requested',
  'implementation.accepted',
  'task.completed',
  'task.paused',
  'task.resumed',
  'task.cancelled',
] as const;

/** Who caused a transition: the user, Claude (through MCP) or JERRY Core itself. */
export const WORKFLOW_ACTORS = ['user', 'claude', 'core'] as const;

export const TASK_ID_PATTERN = /^JRY-\d{4,}$/;
export const CORE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
