import type { Rule, RuleHit } from '../types.js';
import { braceBlock, eachLine, JS_TS } from './helpers.js';

/** Test quality (spec §2.1, §12.2): tests that do not test, or that silently run less. */

export const focusedOrSkipped: Rule = {
  id: 'tests.focused-or-skipped',
  version: '1.0.0',
  category: 'test-quality',
  source: 'static',
  severity: 'P2',
  confidence: 0.95,
  languages: [...JS_TS, 'python'],
  files: 'test',
  title: 'Focused or skipped test',
  why: '`.only` silently skips every other test in the file; `.skip` hides a test that should run. Both make a green run lie.',
  fix: 'Remove `.only`; fix or delete a skipped test, or mark it with the reason and an issue.',
  examples: { language: 'typescript', testFile: true, positive: ["it.only('parses dates', () => {", "describe.skip('legacy', () => {", "fit('focused', () => {"], negative: ["it('parses dates', () => {", "it.skipIf(process.platform !== 'win32')('Windows only', () => {"] },
  exceptions: 'Conditional skips (`skipIf`, `runIf`) that state when they apply.',
  check: (context) =>
    context.language === 'python'
      ? eachLine(context, /@(?:pytest\.mark\.skip|unittest\.skip)\b(?!If|Unless|_if|if)\s*(?:\(\s*\))?\s*$/)
      : eachLine(context, /(?:^|[^\w.])(?:(?:it|test|describe)\.(?:only|skip)|f(?:it|describe)|x(?:it|describe))\s*\(/),
};

const WEAK_NAMES = /^(works|it works|should work|test|tests|test ?\d+|ok|basic|todo|\d+|check|first test|my test|example|sanity|foo|bar|stuff|new test)$/i;

export const weakTestName: Rule = {
  id: 'tests.weak-name',
  version: '1.0.0',
  category: 'test-quality',
  source: 'static',
  severity: 'P3',
  confidence: 0.75,
  languages: [...JS_TS, 'python'],
  files: 'test',
  title: 'Test name does not say what is checked',
  why: 'When "works" fails, nobody knows what broke; a good name is the first line of the bug report.',
  fix: "Name the behaviour and the condition: `it('rejects an expired token with 401')`.",
  examples: { language: 'typescript', testFile: true, positive: ["it('works', () => {", "test('test 1', async () => {"], negative: ["it('rejects an expired token with 401', () => {"] },
  exceptions: 'Names of three or more meaningful words.',
  check: (context) =>
    context.language === 'python'
      ? eachLine(context, /^\s*def (test_?\d*|test_(works|it|ok|basic|stuff|foo|example))\s*\(/)
      : eachLine(context, /\b(?:it|test)\s*\(\s*(['"`])(.*?)\1/, (match, line, text) => (WEAK_NAMES.test((match[2] ?? '').trim()) ? { line, evidence: text.trim() } : null)),
};

const ASSERTION = /\b(expect|assert\w*|should|verify|toMatch\w*|toBe\w*|toEqual|toThrow\w*|toHave\w*|t\.(is|deepEqual|true|false|throws)|snapshot|rejects|resolves|fail)\b/;

export const testWithoutAssertion: Rule = {
  id: 'tests.no-assertion',
  version: '1.0.0',
  category: 'test-quality',
  source: 'static',
  severity: 'P2',
  confidence: 0.65,
  languages: JS_TS,
  files: 'test',
  title: 'Test without an assertion',
  why: 'A test that asserts nothing passes whatever the code does; it gives false confidence.',
  fix: 'Assert the observable result (`expect(…)`), or the error it should throw.',
  examples: { language: 'typescript', testFile: true, positive: ["it('saves the order', async () => {\n  await save(order);\n});"], negative: ["it('saves the order', async () => {\n  await save(order);\n  expect(store.size).toBe(1);\n});", "it('saves', () => helper(order));", "it('accepts the same input', () => {\n  expectEquivalent(guard, schema);\n});"] },
  exceptions: 'One-line tests that delegate to a helper, and tests calling a project helper that asserts (named expect…, check…, verify…, assert…).',
  check: (context) => {
    const hits: RuleHit[] = [];
    context.lines.forEach((text, index) => {
      const line = index + 1;
      if (!/\b(?:it|test)(?:\.\w+)?\s*\(\s*['"`].*?['"`]\s*,\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{\s*$/.test(text)) return;
      const block = braceBlock(context, line, 120);
      if (block === null) return;
      const body = block.body.join('\n');
      // Helpers named expect…, assert…, check… or verify… assert for the test.
      if (!ASSERTION.test(body) && !/\b(expect|check|verify|assert|should)\w*\s*\(/i.test(body)) hits.push({ line, lineEnd: block.end, evidence: text.trim() });
    });
    return hits;
  },
};

export const TEST_PACK: readonly Rule[] = [focusedOrSkipped, weakTestName, testWithoutAssertion];
