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

export const TASK_ID_PATTERN = /^JRY-\d{4,}$/;
export const CORE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
