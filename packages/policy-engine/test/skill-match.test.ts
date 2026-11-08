import { describe, expect, it } from 'vitest';
import { skillApplies } from '../src/skill-match.js';

describe('which tasks an added skill is started for', () => {
  const frontend = { states: ['IMPLEMENTATION', 'CODE_REVIEW'] as const, classifications: ['frontend', 'ui-ux'] as const };

  it('needs one of its states', () => {
    expect(skillApplies(frontend, { state: 'REVERIFICATION', classification: ['frontend'] })).toBe(false);
    expect(skillApplies({ states: [] }, { state: 'IMPLEMENTATION' })).toBe(false);
  });

  it('without kinds: every change, as before', () => {
    expect(skillApplies({ states: ['IMPLEMENTATION'] }, { state: 'IMPLEMENTATION', classification: ['api-backend'] })).toBe(true);
    expect(skillApplies({ states: ['IMPLEMENTATION'], classifications: [] }, { state: 'IMPLEMENTATION', classification: ['docs'] })).toBe(true);
  });

  it('with kinds: a plan sharing one of them, or a task not classified yet', () => {
    expect(skillApplies(frontend, { state: 'IMPLEMENTATION', classification: ['api-backend', 'ui-ux'] })).toBe(true);
    expect(skillApplies(frontend, { state: 'CODE_REVIEW', classification: ['api-backend', 'database'] })).toBe(false);
    expect(skillApplies(frontend, { state: 'IMPLEMENTATION' })).toBe(true);
    expect(skillApplies(frontend, { state: 'IMPLEMENTATION', classification: [] })).toBe(true);
  });
});
