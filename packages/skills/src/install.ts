import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backupClaudeSettings, claudeSettingsFile, jerryPaths, readClaudeSettings, writeClaudeSettings } from '@jerry/platform';
import { SKILL_OVERRIDE_ON, type SkillFile } from '@jerry/contracts';
import { contentHashOf, sha256, type SkillContentFile } from './content.js';
import { SkillError } from './errors.js';

/**
 * Where skills go and how they are switched. Installed skills are folders in
 * CLAUDE_CONFIG_DIR/skills/<name> (Claude Code's personal skills). Switching one off uses Claude
 * Code's documented "skillOverrides" setting ("off" hides it from Claude and the / menu), so the
 * folder stays where it is; a backup of settings.json comes first and every other key stays.
 * Replaced and removed folders are moved to JERRY_HOME/backups/skills-<name>-<time>.
 */

export interface SkillLocations {
  home: string;
  claudeConfigDir: string;
}

export const skillsDir = (claudeConfigDir: string): string => path.join(claudeConfigDir, 'skills');
export const skillDir = (claudeConfigDir: string, name: string): string => path.join(skillsDir(claudeConfigDir), name);
/** Previews are staged here (JERRY's own data, never a repository); Core clears it on start. */
export const skillStagingRoot = (home: string): string => path.join(jerryPaths(home).runDir, 'skill-staging');

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

/** Moves a folder; across drives it copies, then deletes. */
function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Writes a skill's files into a new folder (which must not exist). */
export function writeSkillFiles(dir: string, files: readonly SkillContentFile[]): void {
  if (fs.existsSync(dir)) throw new SkillError(409, `${dir} already exists.`);
  fs.mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);
  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'));
    // Paths are checked when read; this is the last line of defence against leaving the folder.
    if (!target.startsWith(`${root}${path.sep}`)) throw new SkillError(400, `"${file.path}" would be written outside the skill folder.`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data, { flag: 'wx' });
  }
}

/** The files of a folder with their hashes (links and other non-files are listed with the hash "not-a-file"). */
export function listSkillFiles(dir: string): SkillFile[] | null {
  if (!fs.existsSync(dir)) return null;
  const files: SkillFile[] = [];
  const walk = (current: string, relative: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, childRelative);
      else if (entry.isFile()) {
        const fileBytes = fs.readFileSync(full);
        files.push({ path: childRelative, size: fileBytes.length, sha256: sha256(fileBytes) });
      } else files.push({ path: childRelative, size: 0, sha256: 'not-a-file' });
    }
  };
  walk(dir, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** The content hash of an installed folder; null when it is gone. */
export function folderContentHash(dir: string): string | null {
  const files = listSkillFiles(dir);
  return files === null ? null : contentHashOf(files);
}

/** Moves a skill folder into JERRY_HOME/backups/skills-<name>-<time>; returns where it went. */
export function backupSkillFolder(home: string, dir: string, name: string): string {
  const backups = jerryPaths(home).backupsDir;
  let target = path.join(backups, `skills-${name}-${stamp()}`);
  for (let suffix = 2; fs.existsSync(target); suffix += 1) target = path.join(backups, `skills-${name}-${stamp()}-${suffix}`);
  moveDir(dir, target);
  return target;
}

/** Copies a skill folder into JERRY_HOME/backups/skills-<name>-<time> (it stays in place); returns the copy. */
export function backupSkillCopy(home: string, dir: string, name: string): string {
  const backups = jerryPaths(home).backupsDir;
  let target = path.join(backups, `skills-${name}-${stamp()}`);
  for (let suffix = 2; fs.existsSync(target); suffix += 1) target = path.join(backups, `skills-${name}-${stamp()}-${suffix}`);
  fs.mkdirSync(backups, { recursive: true });
  fs.cpSync(dir, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  return target;
}

/**
 * Puts a staged skill folder in place as CLAUDE_CONFIG_DIR/skills/<name>. It is copied into a
 * temporary folder one level deeper (Claude Code only loads skills/<name>/SKILL.md), then renamed,
 * so Claude Code never sees half a skill. With replace, the folder there is moved to the backups
 * first and put back if the new one cannot be placed.
 */
export function placeSkill(locations: SkillLocations, stagedDir: string, name: string, options: { replace: boolean }): { dir: string; backupDir: string | null } {
  const target = skillDir(locations.claudeConfigDir, name);
  const exists = fs.existsSync(target);
  if (exists && !options.replace) throw new SkillError(409, `${target} already exists.`);
  const incoming = path.join(skillsDir(locations.claudeConfigDir), `.jerry-incoming-${randomBytes(6).toString('hex')}`);
  const staged = path.join(incoming, name);
  fs.mkdirSync(incoming, { recursive: true });
  try {
    fs.cpSync(stagedDir, staged, { recursive: true, errorOnExist: true, force: false });
    const backupDir = exists ? backupSkillFolder(locations.home, target, name) : null;
    try {
      fs.renameSync(staged, target);
    } catch (error) {
      if (backupDir !== null && !fs.existsSync(target)) moveDir(backupDir, target);
      throw error;
    }
    return { dir: target, backupDir };
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

// --- Switching: Claude Code's skillOverrides ---------------------------------------------------

/** The skillOverrides value of a skill in the user's settings ("on" when absent). */
export function skillOverride(claudeConfigDir: string, name: string): string {
  try {
    const overrides = readClaudeSettings(claudeSettingsFile(claudeConfigDir))['skillOverrides'];
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return 'on';
    const value = (overrides as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : 'on';
  } catch {
    return 'on';
  }
}

/** The skillOverrides values JERRY writes itself; any other value is the user's and stays. */
const JERRY_OVERRIDES: ReadonlySet<unknown> = new Set(['off', SKILL_OVERRIDE_ON]);

/**
 * Switches a skill on or off in the user's Claude Code settings. Off sets skillOverrides.<name> to
 * "off". On sets it to `onValue`: "name-only" for a skill JERRY starts (Claude sees its name, not its
 * description, so it never picks it on its own), or null to remove JERRY's value (a skill installed
 * before that). A value the user chose that JERRY does not write (e.g. "user-invocable-only") stays
 * when switching on. A backup of settings.json comes first; nothing is written when nothing changes.
 */
export function setSkillEnabled(locations: SkillLocations, name: string, enabled: boolean, onValue: typeof SKILL_OVERRIDE_ON | null = SKILL_OVERRIDE_ON): { changed: boolean; settingsBackup: string | null } {
  const file = claudeSettingsFile(locations.claudeConfigDir);
  const settings = readClaudeSettings(file);
  const current = settings['skillOverrides'];
  if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
    throw new SkillError(409, `"skillOverrides" in ${file} is not an object; JERRY changed nothing.`);
  }
  const overrides = { ...((current as Record<string, unknown> | undefined) ?? {}) };
  if (enabled) {
    const value = overrides[name];
    // The user's own value stays; only JERRY's values (or none) are replaced.
    if (value !== undefined && value !== 'on' && !JERRY_OVERRIDES.has(value)) return { changed: false, settingsBackup: null };
    const wanted = onValue ?? undefined;
    if (value === wanted || (value === 'on' && wanted === undefined)) return { changed: false, settingsBackup: null };
    if (wanted === undefined) delete overrides[name];
    else overrides[name] = wanted;
  } else {
    if (overrides[name] === 'off') return { changed: false, settingsBackup: null };
    overrides[name] = 'off';
  }
  const settingsBackup = backupClaudeSettings(locations.home, file);
  const next: Record<string, unknown> = { ...settings, skillOverrides: overrides };
  if (Object.keys(overrides).length === 0) delete next['skillOverrides'];
  writeClaudeSettings(file, next);
  return { changed: true, settingsBackup };
}
