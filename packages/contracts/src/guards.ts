import { CORE_TOKEN_PATTERN, GATE_VERDICTS, TASK_ID_PATTERN, WORKFLOW_STATES } from './constants.js';

/**
 * Dependency-free validators for the hook bridge's hot path. Each one accepts exactly
 * what the corresponding Zod schema in index.ts accepts; tests/integration/guards-equivalence.test.ts
 * checks that on valid and invalid fixtures. Types are imported only, so this module loads no Zod.
 */
import type { CoreRuntimeInfo, GateDecision, PreToolUseInput, SessionRegistrationResponse, SessionStartInput } from './index.js';

type Unknown = Record<string, unknown>;

const isObject = (value: unknown): value is Unknown => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isIsoDateTime = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
const isInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function isHookCommonInput(value: unknown): value is Unknown {
  return (
    isObject(value) &&
    isNonEmptyString(value['session_id']) &&
    isNonEmptyString(value['cwd']) &&
    isNonEmptyString(value['hook_event_name']) &&
    isOptionalString(value['transcript_path']) &&
    isOptionalString(value['permission_mode']) &&
    isOptionalString(value['agent_id']) &&
    isOptionalString(value['agent_type'])
  );
}

export function isPreToolUseInput(value: unknown): value is PreToolUseInput {
  return (
    isHookCommonInput(value) &&
    value['hook_event_name'] === 'PreToolUse' &&
    isNonEmptyString(value['tool_name']) &&
    isObject(value['tool_input']) &&
    isOptionalString(value['tool_use_id'])
  );
}

export function isSessionStartInput(value: unknown): value is SessionStartInput {
  return isHookCommonInput(value) && value['hook_event_name'] === 'SessionStart' && isOptionalString(value['source']);
}

export function isGateDecision(value: unknown): value is GateDecision {
  return (
    isObject(value) &&
    (GATE_VERDICTS as readonly unknown[]).includes(value['verdict']) &&
    isNonEmptyString(value['ruleId']) &&
    isNonEmptyString(value['reason']) &&
    isNullableString(value['taskId']) &&
    isNullableString(value['repoRoot']) &&
    (value['feedback'] === undefined || typeof value['feedback'] === 'string') &&
    (value['quiet'] === undefined || typeof value['quiet'] === 'boolean')
  );
}

const isTaskId = (value: unknown): boolean => typeof value === 'string' && TASK_ID_PATTERN.test(value);
const isScope = (value: unknown): boolean => Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string');
const WORKFLOW_STATE_SET: ReadonlySet<unknown> = new Set(WORKFLOW_STATES);

function isSinceCheckpoint(value: unknown): boolean {
  return value === undefined || (isObject(value) && isNullableString(value['headBefore']) && isNullableString(value['headNow']) && isInteger(value['changedFiles'], 0));
}

function isOpenTask(task: unknown): boolean {
  if (!isObject(task)) return false;
  const checkpoint = task['checkpoint'];
  if (!isSinceCheckpoint(task['sinceCheckpoint'])) return false;
  return (
    isTaskId(task['taskId']) &&
    isNonEmptyString(task['title']) &&
    WORKFLOW_STATE_SET.has(task['state']) &&
    isInteger(task['planVersion'], 1) &&
    isScope(task['scope']) &&
    typeof task['coversEdits'] === 'boolean' &&
    typeof task['workedInThisSession'] === 'boolean' &&
    (task['lastActivityAt'] === null || isIsoDateTime(task['lastActivityAt'])) &&
    (checkpoint === null || (isObject(checkpoint) && typeof checkpoint['summary'] === 'string' && isStringArray(checkpoint['nextSteps']) && isIsoDateTime(checkpoint['at'])))
  );
}

export function isSessionRegistrationResponse(value: unknown): value is SessionRegistrationResponse {
  return (
    isObject(value) &&
    value['registered'] === true &&
    isNullableString(value['repoRoot']) &&
    typeof value['excluded'] === 'boolean' &&
    (value['monitored'] === undefined || typeof value['monitored'] === 'boolean') &&
    Array.isArray(value['approvedPlans']) &&
    value['approvedPlans'].every((plan) => isObject(plan) && isTaskId(plan['taskId']) && isInteger(plan['planVersion'], 1) && isScope(plan['scope'])) &&
    (value['openTasks'] === undefined || (Array.isArray(value['openTasks']) && value['openTasks'].every(isOpenTask))) &&
    (value['finishedTasks'] === undefined || isInteger(value['finishedTasks'], 0))
  );
}

export function isCoreRuntimeInfo(value: unknown): value is CoreRuntimeInfo {
  return (
    isObject(value) &&
    isInteger(value['pid'], 1) &&
    isInteger(value['port'], 1, 65535) &&
    (value['configuredPort'] === undefined || isInteger(value['configuredPort'], 0, 65535)) &&
    typeof value['token'] === 'string' &&
    CORE_TOKEN_PATTERN.test(value['token']) &&
    isIsoDateTime(value['startedAt']) &&
    isNonEmptyString(value['version'])
  );
}
