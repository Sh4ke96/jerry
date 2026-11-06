import { describe, expect, it } from 'vitest';
import { WORKFLOW_STATES } from '../src/constants.js';
import { decorate, EMOJI, emojiEnabled, RESULT_EMOJI, SEVERITY_EMOJI, STATE_EMOJI } from '../src/emoji.js';

describe('emoji vocabulary', () => {
  it('has an emoji for every workflow state', () => {
    for (const state of WORKFLOW_STATES) expect(STATE_EMOJI[state], state).toMatch(/\S/);
  });

  it('gives results and severities their own emoji', () => {
    expect(RESULT_EMOJI.DENY).toBe(EMOJI.blocked);
    expect(RESULT_EMOJI.WARN).toBe(EMOJI.warning);
    expect(new Set(Object.values(SEVERITY_EMOJI)).size).toBe(4);
  });

  it('is on unless JERRY_NO_EMOJI=1', () => {
    expect(emojiEnabled({})).toBe(true);
    expect(emojiEnabled({ JERRY_NO_EMOJI: '0' })).toBe(true);
    expect(emojiEnabled({ JERRY_NO_EMOJI: '1' })).toBe(false);
    expect(emojiEnabled(undefined)).toBe(true);
  });

  it('decorates text, or leaves it plain when emoji are off', () => {
    expect(decorate(EMOJI.pass, 'tests passed')).toBe('✅ tests passed');
    expect(decorate(EMOJI.pass, 'tests passed', false)).toBe('tests passed');
    expect(decorate('', 'plain')).toBe('plain');
  });
});
