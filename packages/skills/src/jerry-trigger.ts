import { invalid } from './errors.js';
import type { SkillContentFile } from './content.js';

/**
 * Added skills are started only by JERRY. Claude Code hides a skill from the user's / menu, while
 * Claude can still call it with the Skill tool, only through the SKILL.md frontmatter field
 * "user-invocable: false"; "disable-model-invocation: true" would stop the Skill tool as well. So
 * JERRY drops both fields from the frontmatter and adds "user-invocable: false" before the closing
 * "---". Every other line stays byte for byte as the author wrote it, and the result is the same
 * when it is applied twice.
 */

/** The frontmatter keys JERRY sets; a skill's own value of them is replaced. */
const JERRY_KEYS = ['user-invocable', 'disable-model-invocation'] as const;
const JERRY_LINE = 'user-invocable: false';
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/;

/** SKILL.md with JERRY's frontmatter: user-invocable: false, no disable-model-invocation. */
export function withJerryTrigger(skillMd: string): string {
  const bom = skillMd.startsWith('﻿') ? '﻿' : '';
  const text = skillMd.slice(bom.length);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw invalid('SKILL.md has no frontmatter: its first line must be "---".');
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) throw invalid('SKILL.md frontmatter is not closed: add a "---" line after the fields.');

  const kept: string[] = [];
  let dropping = false;
  for (const line of lines.slice(1, end)) {
    const key = TOP_LEVEL_KEY.exec(line)?.[1];
    if (key !== undefined && !/^\s/.test(line)) dropping = (JERRY_KEYS as readonly string[]).includes(key);
    // Indented lines and blank lines inside a dropped field's block belong to it.
    else if (dropping && line.trim() !== '' && !/^\s/.test(line)) dropping = false;
    if (!dropping) kept.push(line);
  }
  while (kept.length > 0 && kept.at(-1)!.trim() === '') kept.pop();
  return bom + [lines[0]!, ...kept, JERRY_LINE, ...lines.slice(end)].join(newline);
}

/** True when SKILL.md already carries exactly JERRY's frontmatter. */
export function isJerryTriggered(skillMd: string): boolean {
  try {
    return withJerryTrigger(skillMd) === skillMd;
  } catch {
    return false;
  }
}

/** A skill's files with SKILL.md converted by withJerryTrigger; the other files are the same objects. */
export function jerryTriggeredFiles(files: readonly SkillContentFile[]): SkillContentFile[] {
  return files.map((file) => (file.path === 'SKILL.md' ? { path: file.path, data: Buffer.from(withJerryTrigger(file.data.toString('utf8')), 'utf8') } : file));
}
