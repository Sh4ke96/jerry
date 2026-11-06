import type { FindingSeverity, WorkflowState } from '@jerry/contracts';
import { decorate, EMOJI, emojiEnabled, RESULT_EMOJI, SEVERITY_EMOJI, STATE_EMOJI, type EmojiName } from '@jerry/contracts/emoji';

/**
 * Emoji in the CLI's human-readable output, from JERRY's shared vocabulary. Read once per command:
 * JERRY_NO_EMOJI=1 gives plain text for terminals that cannot render emoji. JSON output never
 * carries emoji, and every emoji stands next to the text that says the same.
 */
const enabled = emojiEnabled();

/** `text` prefixed with the named emoji. */
export function mark(name: EmojiName, text: string): string {
  return decorate(EMOJI[name], text, enabled);
}

/** `text` prefixed with the emoji of a workflow state. */
export function stateMark(state: WorkflowState, text: string): string {
  return decorate(STATE_EMOJI[state], text, enabled);
}

/** `text` prefixed with the emoji of a check or gate result (PASS, WARN, DENY, FAIL, NOT_RUN); other results stay plain. */
export function resultMark(result: string, text: string): string {
  return decorate((RESULT_EMOJI as Record<string, string>)[result] ?? '', text, enabled);
}

/** `text` prefixed with the emoji of a finding severity. */
export function severityMark(severity: FindingSeverity, text: string): string {
  return decorate(SEVERITY_EMOJI[severity], text, enabled);
}

/**
 * A line that needs attention: the warning emoji (or another one, e.g. blocked), and the "!" the
 * CLI always used when emoji are off, so plain output keeps its marker.
 */
export function flag(text: string, emoji: string = EMOJI.warning): string {
  return enabled ? `${emoji} ${text}` : `! ${text}`;
}

export type GuardState = 'GUARDED' | 'DEGRADED' | 'UNGUARDED';

/** The guard state line of "jerry status" and "jerry doctor". */
export function guardMark(guard: GuardState, text: string): string {
  return decorate(guard === 'GUARDED' ? EMOJI.jerry : guard === 'DEGRADED' ? EMOJI.warning : EMOJI.fail, text, enabled);
}

export { EMOJI, type EmojiName };
