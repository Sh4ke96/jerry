import type { CheckedFile, DetectedFinding, Language, Rule, RuleContext } from './types.js';

const EXTENSIONS: ReadonlyArray<[RegExp, Language]> = [
  [/\.(ts|tsx|mts|cts)$/i, 'typescript'],
  [/\.(js|jsx|mjs|cjs|vue|svelte)$/i, 'javascript'],
  [/\.py$/i, 'python'],
  [/\.php$/i, 'php'],
  [/\.(java|kt)$/i, 'java'],
  [/\.cs$/i, 'csharp'],
  [/\.go$/i, 'go'],
  [/\.rb$/i, 'ruby'],
];

export function languageOf(file: string): Language {
  return EXTENSIONS.find(([pattern]) => pattern.test(file))?.[1] ?? 'other';
}

/** Test files by the common conventions of the supported ecosystems. */
export function isTestFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized) ||
    /(^|\/)test_[^/]+\.py$/i.test(normalized) ||
    /_test\.(py|go)$/i.test(normalized) ||
    /(Test|Tests)\.(java|kt|cs)$/.test(normalized) ||
    /_spec\.rb$/i.test(normalized) ||
    /(^|\/)(__tests__|spec)\//.test(normalized)
  );
}

const HASH_COMMENT: ReadonlySet<Language> = new Set(['python', 'ruby']);

function commentOf(line: string, language: Language): string | null {
  const trimmed = line.trim();
  if (HASH_COMMENT.has(language) || (language === 'php' && trimmed.startsWith('#'))) {
    if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) return trimmed.replace(/^#+\s?/, '');
    if (language !== 'php') return null;
  }
  if (trimmed.startsWith('//')) return trimmed.replace(/^\/\/+\s?/, '');
  if (trimmed.startsWith('/*') || trimmed.startsWith('* ') || trimmed === '*' || trimmed.startsWith('*/')) {
    return trimmed.replace(/^\/\*+\s?|^\*+\/?\s?|\*\/$/g, '').trim();
  }
  return null;
}

/** FNV-1a, enough to tell evidence apart; not a security hash. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, '0');
}

export function fingerprintOf(ruleId: string, evidence: string): string {
  return hash(`${ruleId}\n${evidence.replace(/\s+/g, ' ').trim()}`);
}

const MAX_EVIDENCE = 200;

export interface RunOptions {
  /** Rules the user switched off or calibrated away. */
  disabled?: ReadonlySet<string>;
}

/** Runs the rules on one file and keeps only hits on changed lines (spec §2.1: the diff, not the repository). */
export function checkFile(file: CheckedFile, rules: readonly Rule[], options: RunOptions = {}): DetectedFinding[] {
  const language = languageOf(file.path);
  const isTest = isTestFile(file.path);
  const lines = file.content.split(/\r?\n/);
  const changed = (line: number): boolean => file.changedLines === 'all' || file.changedLines.has(line);
  const context: RuleContext = { file, language, isTest, lines, changed, comment: (line) => commentOf(lines[line - 1] ?? '', language) };

  const findings: DetectedFinding[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (options.disabled?.has(rule.id)) continue;
    if (rule.languages !== 'any' && !rule.languages.includes(language)) continue;
    if ((rule.files === 'test' && !isTest) || (rule.files === 'code' && isTest)) continue;
    for (const hit of rule.check(context)) {
      const end = hit.lineEnd ?? hit.line;
      let touched = false;
      for (let line = hit.line; line <= end && !touched; line += 1) touched = changed(line);
      if (!touched) continue;
      const evidence = hit.evidence.trim().slice(0, MAX_EVIDENCE);
      const fingerprint = fingerprintOf(rule.id, evidence);
      // The same rule and evidence twice in a file is one finding (its first place).
      if (seen.has(`${rule.id}:${fingerprint}`)) continue;
      seen.add(`${rule.id}:${fingerprint}`);
      findings.push({
        ruleId: rule.id,
        ruleVersion: rule.version,
        fingerprint,
        source: rule.source,
        category: rule.category,
        severity: rule.severity,
        confidence: rule.confidence,
        lineStart: hit.line,
        lineEnd: end,
        title: hit.title ?? rule.title,
        evidence,
        whyItMatters: rule.why,
        suggestedFix: rule.fix,
      });
    }
  }
  return findings.sort((a, b) => a.lineStart - b.lineStart || a.ruleId.localeCompare(b.ruleId));
}

/** Changed lines of a file from a unified diff with zero context (`git diff -U0`), 1-based in the new file. */
export function changedLinesFromDiff(diff: string): Set<number> {
  const changed = new Set<number>();
  for (const match of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) changed.add(line);
  }
  return changed;
}
