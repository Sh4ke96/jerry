import { describe, expect, it } from 'vitest';
import { BUILT_IN_RULES, changedLinesFromDiff, checkFile, fingerprintOf, isTestFile, languageOf, ruleById, type Rule } from '../src/index.js';
import { builtInSecurityScanner } from '../src/index.js';

const EXTENSION: Record<string, string> = { typescript: 'ts', javascript: 'js', python: 'py' };

function fileFor(rule: Rule, content: string) {
  const extension = EXTENSION[rule.examples.language] ?? 'ts';
  return { path: rule.examples.testFile === true ? `src/example.test.${extension}` : `src/example.${extension}`, content, changedLines: 'all' as const };
}

describe('built-in rules: every rule against its own examples (ADR 0028)', () => {
  it('has unique ids, versions and documentation', () => {
    const ids = BUILT_IN_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of BUILT_IN_RULES) {
      expect(rule.version, rule.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(rule.why.length, rule.id).toBeGreaterThan(20);
      expect(rule.fix.length, rule.id).toBeGreaterThan(10);
      expect(rule.exceptions.length, rule.id).toBeGreaterThan(5);
      expect(rule.examples.positive.length, rule.id).toBeGreaterThan(0);
      expect(rule.examples.negative.length, rule.id).toBeGreaterThan(0);
    }
  });

  for (const rule of BUILT_IN_RULES) {
    it(`${rule.id} flags its positive examples`, () => {
      for (const example of rule.examples.positive) {
        expect(checkFile(fileFor(rule, example), [rule]).map((finding) => finding.ruleId), example).toContain(rule.id);
      }
    });
    it(`${rule.id} stays quiet on its negative examples`, () => {
      for (const example of rule.examples.negative) {
        expect(checkFile(fileFor(rule, example), [rule]), example).toEqual([]);
      }
    });
  }
});

describe('rule engine', () => {
  const content = ['export function save() {', '  try {', '    write();', '  } catch {}', '  // TODO', '}'].join('\n');

  it('reports only changed lines', () => {
    expect(checkFile({ path: 'src/a.ts', content, changedLines: 'all' }, BUILT_IN_RULES).map((finding) => finding.ruleId)).toEqual(['errors.empty-catch', 'prose.vague-todo']);
    expect(checkFile({ path: 'src/a.ts', content, changedLines: new Set([5]) }, BUILT_IN_RULES).map((finding) => finding.ruleId)).toEqual(['prose.vague-todo']);
    expect(checkFile({ path: 'src/a.ts', content, changedLines: new Set([1]) }, BUILT_IN_RULES)).toEqual([]);
  });

  it('gives a fingerprint that survives moving the line', () => {
    const before = checkFile({ path: 'src/a.ts', content, changedLines: 'all' }, BUILT_IN_RULES)[0]!;
    const moved = checkFile({ path: 'src/a.ts', content: `// header line\n\n${content}`, changedLines: 'all' }, BUILT_IN_RULES).find((finding) => finding.ruleId === before.ruleId)!;
    expect(moved.lineStart).toBe(before.lineStart + 2);
    expect(moved.fingerprint).toBe(before.fingerprint);
    expect(fingerprintOf('a', 'x  y')).toBe(fingerprintOf('a', 'x y'));
  });

  it('honours disabled rules, test-only and code-only rules', () => {
    const file = { path: 'src/a.ts', content, changedLines: 'all' as const };
    expect(checkFile(file, BUILT_IN_RULES, { disabled: new Set(['errors.empty-catch']) }).map((finding) => finding.ruleId)).toEqual(['prose.vague-todo']);
    const test = "it.only('works', () => {\n  run();\n});";
    expect(checkFile({ path: 'src/a.test.ts', content: test, changedLines: 'all' }, BUILT_IN_RULES).map((finding) => finding.ruleId).sort()).toEqual(['tests.focused-or-skipped', 'tests.no-assertion']);
    expect(checkFile({ path: 'src/a.ts', content: test, changedLines: 'all' }, BUILT_IN_RULES)).toEqual([]);
  });

  it('never keeps a secret value in the evidence', () => {
    const value = ['Zq8m', 'N3vR', 'tx7L', 'p2'].join('');
    const findings = builtInSecurityScanner.scan([{ path: 'src/db.ts', content: `const dbPassword = '${value}';`, changedLines: 'all' }]) as ReturnType<typeof checkFile>;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.evidence).not.toContain(value);
    expect(findings[0]!.evidence).toContain('***');
  });

  it('reads changed lines from a zero-context diff', () => {
    const diff = ['diff --git a/x b/x', '@@ -3,0 +4,2 @@', '+a', '+b', '@@ -10 +12 @@', '-c', '+d', '@@ -20,3 +23,0 @@'].join('\n');
    expect([...changedLinesFromDiff(diff)]).toEqual([4, 5, 12]);
  });

  it('knows languages and test files', () => {
    expect(languageOf('a/b.tsx')).toBe('typescript');
    expect(languageOf('a/b.py')).toBe('python');
    expect(languageOf('README.md')).toBe('other');
    for (const file of ['src/a.test.ts', 'tests/test_api.py', 'pkg/x_test.go', 'src/__tests__/a.js', 'AppTests.cs']) expect(isTestFile(file), file).toBe(true);
    for (const file of ['src/testing.ts', 'src/contest.py']) expect(isTestFile(file), file).toBe(false);
    expect(ruleById('errors.empty-catch')?.severity).toBe('P2');
  });

  it('checks Python too', () => {
    const python = ['def load():', '    try:', '        read()', '    except Exception:', '        pass', '    data = parse()'].join('\n');
    expect(checkFile({ path: 'app/load.py', content: python, changedLines: 'all' }, BUILT_IN_RULES).map((finding) => finding.ruleId)).toEqual(['errors.empty-catch', 'naming.vague-name']);
  });
});
