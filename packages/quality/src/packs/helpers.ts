import type { Language, RuleContext, RuleHit } from '../types.js';

export const C_LIKE: readonly Language[] = ['typescript', 'javascript', 'php', 'java', 'csharp', 'go'];
export const JS_TS: readonly Language[] = ['typescript', 'javascript'];

/** One hit per changed line that matches; `evidence` defaults to the trimmed line. */
export function eachLine(context: RuleContext, pattern: RegExp, toHit?: (match: RegExpExecArray, line: number, text: string) => RuleHit | null): RuleHit[] {
  const hits: RuleHit[] = [];
  context.lines.forEach((text, index) => {
    const line = index + 1;
    if (!context.changed(line)) return;
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match === null) return;
    const hit = toHit === undefined ? { line, evidence: text.trim() } : toHit(match, line, text);
    if (hit !== null) hits.push(hit);
  });
  return hits;
}

/** Code lines only: not comments, not blank. */
export function isCode(context: RuleContext, line: number): boolean {
  const text = context.lines[line - 1] ?? '';
  return text.trim() !== '' && context.comment(line) === null;
}

/**
 * The lines of the block that starts on `line` (an opening `{` on it), up to its closing brace.
 * Braces inside strings are counted too; good enough for the short blocks rules look at.
 */
export function braceBlock(context: RuleContext, line: number, maxLines = 80, startColumn = 0): { end: number; body: string[] } | null {
  let depth = 0;
  let opened = false;
  const body: string[] = [];
  for (let current = line; current <= Math.min(context.lines.length, line + maxLines); current += 1) {
    // On the first line, count from the construct itself (`} catch {` closes the try block first).
    const text = current === line ? (context.lines[current - 1] ?? '').slice(startColumn) : (context.lines[current - 1] ?? '');
    for (const char of text) {
      if (char === '{') {
        depth += 1;
        opened = true;
      } else if (char === '}') {
        depth -= 1;
      }
    }
    if (current !== line) body.push(text);
    if (opened && depth <= 0) return { end: current, body: body.slice(0, -1) };
  }
  return null;
}

/** Words of an identifier or sentence, lower-case: `maxRetryCount` → max, retry, count. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);
}
