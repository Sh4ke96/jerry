import fs from 'node:fs';
import path from 'node:path';
import { MAX_SKILL_ARCHIVE_BYTES, MAX_SKILL_UPLOAD_BYTES, type SkillScanFinding, type SkillSource } from '@jerry/contracts';
import { contentFromFolder, contentFromZip, validateSkill, type SkillContent, type ValidatedSkill } from './content.js';
import { invalid } from './errors.js';
import { fetchGitHubFolder, looksLikeUrl, parseGitHubUrl, type GitHubFetchOptions } from './github.js';
import { scanSkill } from './scan.js';

/**
 * One skill read from where the user pointed (GitHub URL, local zip or .skill file, local folder,
 * or an uploaded file), validated and scanned. Nothing is written and nothing is run.
 */

export type SkillInput = { source: string } | { upload: { fileName: string; data: Buffer } };

export interface LoadedSkill {
  source: SkillSource;
  content: SkillContent;
  skill: ValidatedSkill;
  scan: SkillScanFinding[];
}

export interface LoadOptions {
  github?: GitHubFetchOptions;
  /** Folders a local source may not be inside (JERRY's own data). */
  forbiddenRoots?: readonly string[];
}

const ARCHIVE = /\.(zip|skill)$/i;

function inside(child: string, parent: string): boolean {
  const key = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  const relative = path.relative(key(parent), key(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function loadSkill(input: SkillInput, options: LoadOptions = {}): Promise<LoadedSkill> {
  let source: SkillSource;
  let content: SkillContent;
  if ('upload' in input) {
    const { fileName, data } = input.upload;
    if (!ARCHIVE.test(fileName)) throw invalid('Upload a .zip or .skill file.');
    if (data.length > MAX_SKILL_UPLOAD_BYTES) throw invalid(`The file is larger than ${MAX_SKILL_UPLOAD_BYTES / (1024 * 1024)} MB.`);
    content = contentFromZip(data, { fileName });
    source = { kind: 'zip', source: path.basename(fileName.replaceAll('\\', '/')), ref: null, commit: null, path: null };
  } else if (looksLikeUrl(input.source)) {
    // Only the skill's folder is downloaded, however big the repository is.
    const location = parseGitHubUrl(input.source);
    const fetched = await fetchGitHubFolder(location, options.github);
    content = { files: fetched.files, nameHint: fetched.nameHint };
    source = { kind: 'github', source: input.source.trim(), ref: location.ref, commit: fetched.commit, path: location.path };
  } else {
    const target = input.source.trim().replace(/^["']|["']$/g, '');
    if (!path.isAbsolute(target)) throw invalid(`Give the full path of the folder or zip file (got "${target.slice(0, 200)}").`);
    const resolved = path.resolve(target);
    for (const root of options.forbiddenRoots ?? []) {
      if (inside(resolved, root)) throw invalid(`${resolved} is inside JERRY's own data; add a skill from elsewhere.`);
    }
    const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (stat === undefined) throw invalid(`${resolved} does not exist.`);
    if (stat.isFile()) {
      if (!ARCHIVE.test(resolved)) throw invalid(`${resolved} is a file; give a skill folder, or a .zip or .skill file.`);
      if (stat.size > MAX_SKILL_ARCHIVE_BYTES) throw invalid(`${resolved} is larger than ${MAX_SKILL_ARCHIVE_BYTES / (1024 * 1024)} MB.`);
      content = contentFromZip(fs.readFileSync(resolved), { fileName: path.basename(resolved) });
      source = { kind: 'zip', source: resolved, ref: null, commit: null, path: null };
    } else {
      content = contentFromFolder(resolved);
      source = { kind: 'folder', source: resolved, ref: null, commit: null, path: null };
    }
  }
  const skill = validateSkill(content);
  const scan = scanSkill(skill.content.files, skill.frontmatter);
  if (skill.renamedFrom !== null) {
    scan.unshift({
      level: 'warning',
      rule: 'name-normalized',
      file: 'SKILL.md',
      line: null,
      message: `SKILL.md names the skill "${skill.renamedFrom.slice(0, 80)}"; Claude Code needs lowercase letters, digits and hyphens, so JERRY installs it as "${skill.name}" and changes only that line.`,
      excerpt: null,
    });
  }
  return { source, content: skill.content, skill, scan };
}
