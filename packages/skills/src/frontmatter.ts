import { invalid } from './errors.js';

/**
 * The YAML frontmatter of a SKILL.md, read the way Claude Code needs it: the opening "---" on the
 * first line, top-level "key: value" pairs, quoted strings, block scalars (| and >) and lists. Nested
 * maps (metadata) are kept as present but not read. Nothing in it is evaluated.
 */

export interface Frontmatter {
  /** Top-level keys with their values: a string, a list of strings, or true for a nested map. */
  fields: Record<string, string | string[] | true>;
  /** The Markdown after the closing "---". */
  body: string;
  /** Line number (1-based) of the first body line in SKILL.md. */
  bodyLine: number;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  // A plain scalar ends at " #" (a comment).
  const comment = trimmed.search(/\s#/);
  return (comment === -1 ? trimmed : trimmed.slice(0, comment)).trim();
}

function flowList(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1).trim();
  return inner === '' ? [] : inner.split(',').map((item) => unquote(item)).filter((item) => item !== '');
}

export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw invalid('SKILL.md has no frontmatter: its first line must be "---", followed by name and description and a closing "---".');
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) throw invalid('SKILL.md frontmatter is not closed: add a "---" line after the fields.');
  const fields: Frontmatter['fields'] = {};
  let index = 1;
  while (index < end) {
    const line = lines[index]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    if (/^\s/.test(line)) throw invalid(`SKILL.md frontmatter line ${index + 1} is indented where a field was expected: "${line.trim().slice(0, 60)}".`);
    const match = KEY_LINE.exec(line);
    if (match === null) throw invalid(`SKILL.md frontmatter line ${index + 1} is not "key: value": "${line.trim().slice(0, 60)}".`);
    const key = match[1]!;
    const raw = (match[2] ?? '').trim();
    if (Object.hasOwn(fields, key)) throw invalid(`SKILL.md frontmatter has "${key}" twice.`);
    index += 1;
    // Indented lines that belong to this key.
    const block: string[] = [];
    while (index < end && (lines[index]!.trim() === '' || /^\s/.test(lines[index]!))) {
      block.push(lines[index]!);
      index += 1;
    }
    while (block.length > 0 && block.at(-1)!.trim() === '') block.pop();
    if (/^[|>][+-]?\d*$/.test(raw)) {
      const indent = Math.min(...block.filter((entry) => entry.trim() !== '').map((entry) => entry.length - entry.trimStart().length));
      const content = block.map((entry) => entry.slice(Number.isFinite(indent) ? indent : 0));
      fields[key] = raw.startsWith('|') ? content.join('\n').trim() : content.map((entry) => entry.trim()).join(' ').replace(/\s+/g, ' ').trim();
    } else if (raw === '') {
      const items = block.filter((entry) => entry.trim() !== '');
      if (items.length === 0) fields[key] = '';
      else if (items.every((entry) => /^\s*-\s/.test(entry) || /^\s*-$/.test(entry))) fields[key] = items.map((entry) => unquote(entry.replace(/^\s*-\s?/, '')));
      else fields[key] = true;
    } else {
      const list = flowList(raw);
      // A plain or quoted scalar may continue on indented lines (folded into one line).
      fields[key] = list ?? unquote([raw, ...block.map((entry) => entry.trim())].join(' '));
    }
  }
  return { fields, body: lines.slice(end + 1).join('\n'), bodyLine: end + 2 };
}

/**
 * SKILL.md with its top-level "name" set to `name`: only that line (and indented lines continuing it)
 * changes; the BOM, line endings and every other line stay as they are. `name` must be a plain
 * scalar (a valid skill name needs no quoting).
 */
export function withSkillName(text: string, name: string): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  // Each line keeps its own ending, so CRLF and LF files come back unchanged.
  const lines = text.slice(bom.length).split(/(?<=\n)/);
  const ending = (line: string): string => /\r?\n$/.exec(line)?.[0] ?? '';
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line.replace(/\r?\n$/, '')));
  if (lines[0]?.replace(/\r?\n$/, '').trim() !== '---' || end === -1) throw invalid('SKILL.md has no closed frontmatter to set the name in.');
  const at = lines.findIndex((line, index) => index > 0 && index < end && /^name\s*:/.test(line));
  if (at === -1) throw invalid('SKILL.md frontmatter has no "name" to set.');
  let next = at + 1;
  while (next < end && /^\s+\S/.test(lines[next]!)) next += 1;
  lines.splice(at, next - at, `name: ${name}${ending(lines[at]!)}`);
  return bom + lines.join('');
}

/** A field as one string ('' when absent, a list joined with ", "). */
export function fieldText(frontmatter: Frontmatter, key: string): string {
  const value = frontmatter.fields[key];
  if (value === undefined || value === true) return '';
  return Array.isArray(value) ? value.join(', ') : value;
}
