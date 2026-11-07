import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_SKILL_BYTES, MAX_SKILL_FILES, SKILL_NAME_MAX_LENGTH, SKILL_NAME_PATTERN, type SkillFile } from '@jerry/contracts';
import { invalid } from './errors.js';
import { fieldText, parseFrontmatter, type Frontmatter } from './frontmatter.js';
import { isSafeEntryName, readZip, type ZipEntry } from './zip.js';

/**
 * A skill's files in memory, from a folder, a zip or a GitHub archive, and their validation:
 * SKILL.md with frontmatter (description; name or the folder name), at most MAX_SKILL_FILES files
 * and MAX_SKILL_BYTES, no links, no unsafe paths. Nothing is run and nothing is written here.
 */

export interface SkillContentFile {
  /** Relative to the skill folder, forward slashes. */
  path: string;
  data: Buffer;
}

export interface SkillContent {
  files: SkillContentFile[];
  /** The folder name the skill came in (its name when SKILL.md has none). */
  nameHint: string;
}

export interface ValidatedSkill {
  name: string;
  description: string;
  frontmatter: Frontmatter;
  skillMd: string;
  files: SkillFile[];
  totalBytes: number;
  contentHash: string;
}

/** Folders that are never part of a skill (version control, OS metadata). */
const SKIPPED_SEGMENTS = new Set(['.git', '__MACOSX']);
const SKIPPED_FILES = new Set(['.DS_Store', 'Thumbs.db']);
/** Folder depth inside a skill. */
const MAX_DEPTH = 12;

/** Version control and OS metadata, never part of a skill (folders, zips and GitHub listings alike). */
export const isSkippedPath = (relative: string): boolean => {
  const segments = relative.split('/');
  return segments.some((segment) => SKIPPED_SEGMENTS.has(segment)) || SKIPPED_FILES.has(segments.at(-1)!);
};
const skipped = isSkippedPath;

const tooMany = (): Error => invalid(`A skill may have at most ${MAX_SKILL_FILES} files.`);
const tooBig = (): Error => invalid(`A skill may be at most ${MAX_SKILL_BYTES / (1024 * 1024)} MB.`);

/** Lowercase letters, digits and hyphens: what Claude Code accepts as a skill folder name. */
export function sanitizeSkillName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[łđøßæœ]/g, (letter) => ({ ł: 'l', đ: 'd', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe' })[letter] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SKILL_NAME_MAX_LENGTH)
    .replace(/-+$/g, '');
}

/** Names Claude Code reserves for synced skills; a folder with them does not load. */
export function reservedSkillName(name: string): boolean {
  return name === 'synced' || name.startsWith('anthropic-skills');
}

// --- Sources ------------------------------------------------------------------------------------

/** A folder on this computer: links are refused, .git is skipped, limits apply while walking. */
export function contentFromFolder(dir: string): SkillContent {
  const root = path.resolve(dir);
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stat === undefined) throw invalid(`${dir} does not exist.`);
  if (stat.isSymbolicLink()) throw invalid(`${dir} is a symbolic link; give the folder itself.`);
  if (!stat.isDirectory()) throw invalid(`${dir} is not a folder.`);
  const files: SkillContentFile[] = [];
  let bytes = 0;
  const walk = (current: string, relative: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw invalid(`${relative} is nested too deep for a skill.`);
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (skipped(childRelative)) continue;
      const full = path.join(current, entry.name);
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) throw invalid(`${childRelative} is a symbolic link; skills may not contain links.`);
      if (!isSafeEntryName(childRelative)) throw invalid(`${childRelative} has a name that cannot be installed safely.`);
      if (info.isDirectory()) {
        walk(full, childRelative, depth + 1);
        continue;
      }
      if (!info.isFile()) throw invalid(`${childRelative} is not a regular file.`);
      if (files.length + 1 > MAX_SKILL_FILES) throw tooMany();
      bytes += info.size;
      if (bytes > MAX_SKILL_BYTES) throw tooBig();
      files.push({ path: childRelative, data: fs.readFileSync(full) });
    }
  };
  walk(root, '', 0);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, nameHint: path.basename(root) };
}

export interface ZipSelection {
  /** The archive's file name, for the name of a skill packed without a folder. */
  fileName: string;
  /** GitHub archives: the folder inside the repository ('' for its root). */
  repoPath?: string;
  /** GitHub archives: the repository name (the skill's name when it sits at the root). */
  repoName?: string;
  /** GitHub archives: how to name a folder in a hint ("https://github.com/o/r/tree/<ref>/"). */
  folderUrl?: (folder: string) => string;
}

/**
 * The skill inside an archive. Uploads: SKILL.md at the top, or in one folder at the top. GitHub
 * archives (one "<repo>-<sha>/" folder): the folder the URL named.
 */
export function contentFromZip(buffer: Buffer, selection: ZipSelection): SkillContent {
  const entries = readZip(buffer).filter((entry) => !skipped(entry.name.replace(/\/$/, '')));
  let prefix: string;
  let nameHint: string;
  if (selection.repoPath !== undefined) {
    const tops = new Set(entries.map((entry) => entry.name.split('/')[0]!));
    const top = tops.size === 1 ? [...tops][0]! : null;
    if (top === null) throw invalid('The GitHub archive does not have the expected single top folder.');
    const sub = selection.repoPath.replace(/^\/+|\/+$/g, '');
    prefix = sub === '' ? `${top}/` : `${top}/${sub}/`;
    nameHint = sub === '' ? (selection.repoName ?? top) : sub.slice(sub.lastIndexOf('/') + 1);
    if (!entries.some((entry) => entry.name === `${prefix}SKILL.md`)) {
      const folders = entries
        .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('/SKILL.md'))
        .map((entry) => entry.name.slice(top.length + 1, -'/SKILL.md'.length))
        .slice(0, 10);
      if (!entries.some((entry) => entry.name.startsWith(prefix))) throw invalid(`The repository has no folder "${sub}" at that commit.`);
      const hint = folders.length === 0 ? '' : ` It holds skills in: ${folders.map((folder) => (selection.folderUrl === undefined ? folder : selection.folderUrl(folder))).join(', ')}. Add one of them by its folder URL.`;
      throw invalid(`There is no SKILL.md in ${sub === '' ? 'the root of the repository' : `"${sub}"`}.${hint}`);
    }
  } else {
    const skillFiles = entries.filter((entry) => !entry.directory && (entry.name === 'SKILL.md' || entry.name.endsWith('/SKILL.md')));
    if (skillFiles.length === 0) throw invalid('The archive has no SKILL.md: a skill is a folder with SKILL.md at its top.');
    const depth = (name: string): number => name.split('/').length;
    const shallowest = Math.min(...skillFiles.map((entry) => depth(entry.name)));
    const roots = skillFiles.filter((entry) => depth(entry.name) === shallowest);
    if (shallowest > 2) throw invalid('SKILL.md must be at the top of the archive, or in one folder at its top.');
    if (roots.length > 1) throw invalid(`The archive holds ${roots.length} skills (${roots.map((entry) => entry.name).join(', ')}); add them one at a time.`);
    prefix = shallowest === 1 ? '' : roots[0]!.name.slice(0, -'SKILL.md'.length);
    const base = selection.fileName.replace(/^.*[\\/]/, '').replace(/\.(zip|skill)$/i, '');
    nameHint = prefix === '' ? base : prefix.slice(0, -1);
    // A skill packed in a folder: nothing may sit beside that folder.
    if (prefix !== '') {
      const outside = entries.find((entry) => !entry.name.startsWith(prefix) && entry.name !== prefix);
      if (outside !== undefined) throw invalid(`The archive has "${outside.name}" outside the skill folder ${prefix}; pack only the skill folder.`);
    }
  }

  const selected = entries.filter((entry) => entry.name.startsWith(prefix) && !entry.directory);
  for (const entry of entries) if (entry.name.startsWith(prefix) && entry.problem !== null) throw invalid(entry.problem);
  if (selected.length > MAX_SKILL_FILES) throw tooMany();
  if (selected.reduce((sum, entry) => sum + entry.size, 0) > MAX_SKILL_BYTES) throw tooBig();
  const files = selected.map((entry: ZipEntry): SkillContentFile => ({ path: entry.name.slice(prefix.length), data: entry.read() }));
  return { files, nameHint };
}

// --- Validation ---------------------------------------------------------------------------------

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** sha256 over the sorted paths and their hashes: the same files give the same hash on any OS. */
export function contentHashOf(files: readonly SkillFile[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => `${file.path}\0${file.sha256}\n`);
  return `sha256:${sha256(lines.join(''))}`;
}

export function validateSkill(content: SkillContent): ValidatedSkill {
  if (content.files.length > MAX_SKILL_FILES) throw tooMany();
  const totalBytes = content.files.reduce((sum, file) => sum + file.data.length, 0);
  if (totalBytes > MAX_SKILL_BYTES) throw tooBig();
  const seen = new Set<string>();
  for (const file of content.files) {
    if (!isSafeEntryName(file.path)) throw invalid(`"${file.path}" cannot be installed safely.`);
    // Windows and macOS folders do not tell "a.md" from "A.md".
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw invalid(`"${file.path}" appears twice (names differing only in case).`);
    seen.add(key);
  }
  const skillFile = content.files.find((file) => file.path === 'SKILL.md');
  if (skillFile === undefined) {
    const near = content.files.find((file) => file.path.toLowerCase() === 'skill.md');
    throw invalid(near === undefined ? 'The skill has no SKILL.md at its top.' : `The skill's main file must be named exactly SKILL.md, not ${near.path}.`);
  }
  const skillMd = skillFile.data.toString('utf8');
  const frontmatter = parseFrontmatter(skillMd);
  const description = fieldText(frontmatter, 'description').trim();
  if (description === '') throw invalid('SKILL.md frontmatter needs a "description": Claude uses it to decide when the skill applies.');
  const declared = frontmatter.fields['name'];
  let name: string;
  if (declared !== undefined) {
    if (typeof declared !== 'string' || !SKILL_NAME_PATTERN.test(declared) || declared.length > SKILL_NAME_MAX_LENGTH) {
      throw invalid(`SKILL.md "name" must be lowercase letters, digits and single hyphens, at most ${SKILL_NAME_MAX_LENGTH} characters (got "${String(declared).slice(0, 80)}").`);
    }
    name = declared;
  } else {
    name = sanitizeSkillName(content.nameHint);
    if (name === '') throw invalid('SKILL.md has no "name" and the folder name has no letters or digits to name the skill with; add a "name" to the frontmatter.');
  }
  if (reservedSkillName(name)) throw invalid(`"${name}" is a name Claude Code reserves for synced skills; rename the skill.`);
  const files = content.files.map((file): SkillFile => ({ path: file.path, size: file.data.length, sha256: sha256(file.data) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { name, description, frontmatter, skillMd, files, totalBytes, contentHash: contentHashOf(files) };
}
