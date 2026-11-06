import { ERROR_PACK } from './packs/errors.js';
import { PROSE_PACK } from './packs/prose.js';
import { SECURITY_PACK } from './packs/security.js';
import { TEST_PACK } from './packs/tests.js';
import type { Rule } from './types.js';

export * from './types.js';
export { changedLinesFromDiff, checkFile, fingerprintOf, isTestFile, languageOf, type RunOptions } from './engine.js';
export { builtInSecurityScanner } from './packs/security.js';

/** Every built-in rule, cheap and deterministic. */
export const BUILT_IN_RULES: readonly Rule[] = [...PROSE_PACK, ...ERROR_PACK, ...TEST_PACK, ...SECURITY_PACK];

export const RULE_PACKS: Readonly<Record<string, readonly Rule[]>> = {
  'naming-and-prose': PROSE_PACK,
  'error-handling': ERROR_PACK,
  'test-quality': TEST_PACK,
  security: SECURITY_PACK,
};

export function ruleById(id: string): Rule | undefined {
  return BUILT_IN_RULES.find((rule) => rule.id === id);
}
export { exitCodeOf, isTestCommand, selectTargetedTests, testCandidates, type TargetedTests } from './targeted-tests.js';
