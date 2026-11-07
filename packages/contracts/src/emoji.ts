/**
 * JERRY's emoji vocabulary, shared by the hook bridge, Core, the MCP server, the CLI and the dashboard,
 * so one meaning always has one emoji. Plain constants with no runtime dependency: the hook bridge
 * imports this module on every guarded tool call.
 *
 * An emoji never carries meaning alone; it always stands next to the text it decorates.
 */

import type { WORKFLOW_STATES } from './constants.js';

export const EMOJI = {
  jerry: '🛡️',
  pass: '✅',
  fail: '❌',
  warning: '⚠️',
  blocked: '⛔',
  paused: '⏸️',
  skipped: '⏭️',
  waiting: '⏳',
  next: '💡',
  info: 'ℹ️',
  plan: '📋',
  analysis: '🔎',
  review: '🔍',
  implementation: '🛠️',
  tests: '🧪',
  finding: '🐞',
  evals: '📊',
  report: '📄',
  task: '🗂️',
  repository: '📁',
  session: '💬',
  agent: '🤖',
  security: '🔒',
  artifact: '🎨',
  done: '🏁',
  checkpoint: '💾',
  cancelled: '🚫',
} as const;

export type EmojiName = keyof typeof EMOJI;

type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** One emoji per workflow state, for badges, lists and the session-start summary. */
export const STATE_EMOJI: Record<WorkflowState, string> = {
  DISCOVERY: EMOJI.analysis,
  PARALLEL_ANALYSIS: EMOJI.analysis,
  PLAN_DRAFT: EMOJI.plan,
  WAIT_PLAN_APPROVAL: EMOJI.waiting,
  IMPLEMENTATION: EMOJI.implementation,
  IMPLEMENTATION_REPORT: EMOJI.report,
  WAIT_IMPLEMENTATION_ACCEPTANCE: EMOJI.waiting,
  CODE_REVIEW: EMOJI.review,
  REVIEW_REPORT: EMOJI.review,
  WAIT_REVIEW_FIX_APPROVAL: EMOJI.waiting,
  FIX_IMPLEMENTATION: EMOJI.implementation,
  REVERIFICATION: EMOJI.review,
  FINAL_REPORT: EMOJI.report,
  DONE: EMOJI.done,
  BLOCKED: EMOJI.blocked,
  PAUSED: EMOJI.paused,
  CANCELLED: EMOJI.cancelled,
};

/** Check and gate results as JERRY reports them. */
export const RESULT_EMOJI = {
  PASS: EMOJI.pass,
  WARN: EMOJI.warning,
  DENY: EMOJI.blocked,
  FAIL: EMOJI.fail,
  NOT_RUN: EMOJI.skipped,
} as const;

/** Finding severities, most urgent first. */
export const SEVERITY_EMOJI = {
  P1: '🔴',
  P2: '🟠',
  P3: '🟡',
  P4: '⚪',
} as const;

type Env = Record<string, string | undefined>;

/**
 * Terminals that cannot render emoji (the legacy Windows console with an OEM code page) get plain text
 * with JERRY_NO_EMOJI=1. Only the CLI reads it; Claude's chat and the dashboard always render emoji.
 */
export function emojiEnabled(env: Env | undefined = (globalThis as { process?: { env: Env } }).process?.env): boolean {
  return env?.JERRY_NO_EMOJI !== '1';
}

/** `text` prefixed with `emoji`, or `text` alone when emoji are off. */
export function decorate(emoji: string, text: string, enabled = true): string {
  return enabled && emoji !== '' ? `${emoji} ${text}` : text;
}
