import { randomUUID } from 'node:crypto';
import type { EventEnvelope, GateDecision, HookEventType } from '@jerry/contracts';
import { EVENT_SCHEMA_VERSION, HOOK_EVENT_TYPES } from '@jerry/contracts/constants';
import { redactText, truncate } from './redaction.js';

/**
 * Turns raw Claude Code hook input into a minimized, redacted event envelope (spec §11.2, §18.2).
 * Only metadata survives: paths, redacted commands, sizes, flags and outcomes. File contents,
 * edit strings, prompt text and tool output never leave this module.
 */

const MAX_COMMAND_LENGTH = 300;
const MAX_ERROR_LENGTH = 300;
const MAX_KEYS = 20;

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

type Raw = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

class RedactionLog {
  readonly reasons = new Set<string>();
  apply(value: string, maxLength: number): string {
    const redacted = redactText(value);
    for (const reason of redacted.reasons) this.reasons.add(reason);
    return truncate(redacted.text, maxLength);
  }
}

/** What a tool was asked to do: target paths and redacted commands, never contents. */
export function summarizeToolInput(toolName: string, input: unknown, redaction = new RedactionLog()): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) return {};
  const fields = input as Raw;
  const summary: Record<string, unknown> = {};
  const target = text(fields['file_path']) ?? text(fields['notebook_path']);
  if (target !== null) summary['path'] = target;
  const command = text(fields['command']);
  if (command !== null) {
    summary['command'] = redaction.apply(command, MAX_COMMAND_LENGTH);
    summary['commandLength'] = command.length;
  }
  if (toolName.startsWith('mcp__') || (target === null && command === null)) {
    summary['argumentKeys'] = Object.keys(fields).slice(0, MAX_KEYS);
  }
  return summary;
}

/** How a tool call ended: sizes and flags only. */
export function summarizeToolResponse(response: unknown): Record<string, unknown> {
  if (typeof response === 'string') return { responseLength: response.length };
  if (typeof response !== 'object' || response === null) return {};
  const fields = response as Raw;
  const summary: Record<string, unknown> = { responseKeys: Object.keys(fields).slice(0, MAX_KEYS) };
  for (const flag of ['interrupted', 'isError', 'success']) {
    if (typeof fields[flag] === 'boolean') summary[flag] = fields[flag];
  }
  for (const stream of ['stdout', 'stderr']) {
    if (typeof fields[stream] === 'string') summary[`${stream}Length`] = (fields[stream] as string).length;
  }
  return summary;
}

export interface EnvelopeOverrides {
  eventId?: string;
  timestamp?: Date;
  verdict?: GateDecision['verdict'] | null;
  ruleId?: string | null;
  taskId?: string | null;
  repoRoot?: string | null;
  source?: EventEnvelope['source'];
  pendingEvaluation?: boolean;
  extraPayload?: Record<string, unknown>;
}

/** Builds the envelope for any supported hook input; returns null for events JERRY does not record. */
export function buildEventEnvelope(input: Raw, overrides: EnvelopeOverrides = {}): EventEnvelope | null {
  const name = input['hook_event_name'];
  if (!(HOOK_EVENT_TYPES as readonly unknown[]).includes(name)) return null;
  const eventType = name as HookEventType;
  const redaction = new RedactionLog();
  const toolName = text(input['tool_name']);
  const payload: Record<string, unknown> = {};

  switch (eventType) {
    case 'SessionStart':
      payload['source'] = text(input['source']);
      break;
    case 'UserPromptSubmit': {
      // The prompt text is not stored (spec §18.2); only its size and a leading slash command.
      const prompt = typeof input['prompt'] === 'string' ? input['prompt'] : '';
      payload['promptLength'] = prompt.length;
      payload['slashCommand'] = /^\/[\w:.-]+/.exec(prompt.trim())?.[0] ?? null;
      break;
    }
    case 'PreToolUse':
      payload['input'] = summarizeToolInput(toolName ?? '', input['tool_input'], redaction);
      break;
    case 'PostToolUse':
      payload['input'] = summarizeToolInput(toolName ?? '', input['tool_input'], redaction);
      payload['response'] = summarizeToolResponse(input['tool_response']);
      break;
    case 'PostToolUseFailure': {
      payload['input'] = summarizeToolInput(toolName ?? '', input['tool_input'], redaction);
      const error = text(input['error']);
      if (error !== null) payload['error'] = redaction.apply(error, MAX_ERROR_LENGTH);
      if (typeof input['is_interrupt'] === 'boolean') payload['interrupted'] = input['is_interrupt'];
      break;
    }
    case 'SubagentStart':
      break;
    case 'SubagentStop': {
      const lastMessage = input['last_assistant_message'];
      if (typeof lastMessage === 'string') payload['lastMessageLength'] = lastMessage.length;
      if (typeof input['stop_hook_active'] === 'boolean') payload['stopHookActive'] = input['stop_hook_active'];
      break;
    }
    case 'Stop':
      if (typeof input['stop_hook_active'] === 'boolean') payload['stopHookActive'] = input['stop_hook_active'];
      break;
    case 'SessionEnd':
      payload['reason'] = text(input['reason']);
      break;
  }
  Object.assign(payload, overrides.extraPayload);

  return {
    eventId: overrides.eventId ?? newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    source: overrides.source ?? 'claude-code-hook',
    eventType,
    timestamp: (overrides.timestamp ?? new Date()).toISOString(),
    sessionId: text(input['session_id']),
    agentId: text(input['agent_id']),
    agentType: text(input['agent_type']),
    cwd: text(input['cwd']),
    toolName,
    toolUseId: text(input['tool_use_id']),
    taskId: overrides.taskId ?? null,
    repoRoot: overrides.repoRoot ?? null,
    verdict: overrides.verdict ?? null,
    ruleId: overrides.ruleId ?? null,
    payload,
    redaction: { applied: redaction.reasons.size > 0, reasons: [...redaction.reasons] },
    pendingEvaluation: overrides.pendingEvaluation ?? false,
  };
}
