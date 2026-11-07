import path from 'node:path';
import { SKILL_TRIGGER_STATES, skillChangeResultSchema, skillDetailSchema, skillPreviewSchema, skillsListSchema, type AddedSkill, type SkillChangeResult, type SkillPreview, type SkillScanFinding, type SkillSource } from '@jerry/contracts';
import { EMOJI, flag, mark } from './emoji.js';
import { confirm } from './statusline-commands.js';
import { ask, callCore, formatBytes, requireTerminal } from './terminal.js';

/**
 * `jerry skill`: Claude Code skills added through JERRY. Listing and showing are read-only. Adding,
 * switching, updating and removing are the user's decisions: an interactive terminal, the preview
 * (files and scan findings) first, and the typed skill name to add or remove one. Agents are
 * blocked from these commands by JERRY's hard rules.
 */

/** A skill folder from GitHub comes file by file, and large folders take a while (Core allows 300 s). */
const PREVIEW_TIMEOUT_MS = 310_000;

/** The skill folder URLs Core names when a repository holds several skills ("It holds skills in: …"). */
export function candidateUrls(message: string): string[] {
  const list = /It holds skills in: (.+?)\. Add one of them/.exec(message)?.[1];
  return list === undefined ? [] : list.split(', ').filter((url) => url.startsWith('https://github.com/'));
}
const CHANGE_TIMEOUT_MS = 60_000;

/** A URL stays as it is; a path becomes absolute (Core reads it). */
export function skillSourceArgument(source: string): string {
  const trimmed = source.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : path.resolve(trimmed.replace(/^["']|["']$/g, ''));
}

function sourceText(source: SkillSource): string {
  if (source.kind !== 'github') return `${source.kind} ${source.source}`;
  return `${source.source}${source.commit === null ? '' : ` @ ${source.commit.slice(0, 12)}`}`;
}

function findingLine(finding: SkillScanFinding): string {
  const where = `${finding.file}${finding.line === null ? '' : `:${finding.line}`}`;
  const text = `${finding.message} [${finding.rule}] ${where}${finding.excerpt === null ? '' : `  ${finding.excerpt}`}`;
  return finding.level === 'danger' ? flag(text, EMOJI.blocked) : flag(text);
}

/** When JERRY starts an added skill, in one line. */
export function triggerText(skill: Pick<AddedSkill, 'states' | 'jerryTriggered'>): string {
  if (!skill.jerryTriggered) return 'Installed before JERRY started skills: Claude may still pick it on its own. Assign task states ("jerry skill states") to hand it to JERRY.';
  if (skill.states.length === 0) return 'Started by JERRY in: no task state yet, so Claude does not use it. Assign states with "jerry skill states".';
  return `Started by JERRY in: ${skill.states.join(', ')}.`;
}

function printPreview(preview: SkillPreview): void {
  console.log(mark('report', `${preview.name}: ${preview.description}`));
  console.log(`  From      ${sourceText(preview.source)}`);
  console.log(`  Into      ${preview.targetDir}`);
  console.log(`  Files     ${preview.files.length}, ${formatBytes(preview.totalBytes)}`);
  for (const file of preview.files.slice(0, 30)) console.log(`    ${file.path.padEnd(48)} ${formatBytes(file.size).padStart(9)}`);
  if (preview.files.length > 30) console.log(`    … and ${preview.files.length - 30} more`);
  if (preview.diff !== null) {
    const { added, removed, changed } = preview.diff;
    console.log(`  Changes   ${added.length} added, ${changed.length} changed, ${removed.length} removed`);
    for (const file of added) console.log(`    + ${file}`);
    for (const file of changed) console.log(`    ~ ${file}`);
    for (const file of removed) console.log(`    - ${file}`);
  }
  console.log('');
  console.log('  SKILL.md:');
  const lines = preview.skillMd.split(/\r?\n/);
  for (const line of lines.slice(0, 40)) console.log(`  | ${line}`);
  if (lines.length > 40) console.log(`  | … (${lines.length - 40} more lines; read the whole file before you install)`);
  console.log('');
  if (preview.scan.length === 0) console.log(mark('pass', 'The scan found nothing to point out (it reads the files; it cannot prove they are safe).'));
  else {
    console.log(mark('security', `The scan found ${preview.scan.length} thing(s) to look at:`));
    for (const finding of preview.scan.slice(0, 50)) console.log(`  ${findingLine(finding)}`);
    if (preview.scan.length > 50) console.log(`  … and ${preview.scan.length - 50} more`);
  }
}

function printChange(result: SkillChangeResult): void {
  const verb = { installed: 'installed', updated: 'updated', enabled: 'switched on', disabled: 'switched off', removed: 'removed', 'states-set': 'assigned to new task states', unchanged: 'unchanged' }[result.action];
  console.log(mark('pass', `${result.name} ${verb}${result.skill === null ? '' : ` (${result.skill.dir})`}.`));
  if (result.skill !== null && result.action !== 'removed') console.log(mark('jerry', triggerText(result.skill)));
  if (result.backupDir !== null) console.log(mark('checkpoint', `The previous folder: ${result.backupDir}`));
  if (result.settingsBackup !== null) console.log(mark('checkpoint', `Claude Code's settings before the change: ${result.settingsBackup}`));
  console.log(mark('info', result.note));
}

export async function listSkills(options: { json: boolean }): Promise<void> {
  const list = skillsListSchema.parse(await callCore('GET', '/api/v1/skills'));
  if (options.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  console.log(mark('jerry', `Skills in ${list.skillsDir}`));
  if (list.added.length === 0) console.log('  No skills added through JERRY yet. Add one with "jerry skill add <GitHub URL | folder | zip>".');
  for (const skill of list.added) {
    const state = !skill.present ? 'folder missing' : skill.enabled ? 'on' : 'off';
    const notes = [skill.modified ? 'changed by hand' : null, skill.scan.dangers > 0 ? `${skill.scan.dangers} red finding(s)` : null, skill.scan.warnings > 0 ? `${skill.scan.warnings} amber finding(s)` : null].filter((note) => note !== null);
    console.log(`  ${mark(skill.enabled && skill.present ? 'pass' : 'paused', skill.name.padEnd(28))} ${state.padEnd(14)} ${sourceText(skill.source)}${notes.length === 0 ? '' : `  (${notes.join(', ')})`}`);
    console.log(`  ${''.padEnd(31)}${triggerText(skill)}`);
  }
  if (list.own.length > 0) {
    console.log('');
    console.log(mark('security', "JERRY's own skills (read-only, from its plugin):"));
    for (const skill of list.own) console.log(`  ${skill.name.padEnd(28)} ${skill.description.slice(0, 90)}`);
  }
  if (list.personal.length > 0) {
    console.log('');
    console.log(mark('repository', 'Your other skills (not installed by JERRY; JERRY leaves them alone):'));
    for (const skill of list.personal) console.log(`  ${skill.name.padEnd(28)} ${skill.description.slice(0, 90)}`);
  }
}

export async function showSkill(name: string, options: { json: boolean }): Promise<void> {
  const detail = skillDetailSchema.parse(await callCore('GET', `/api/v1/skills/${encodeURIComponent(name)}`));
  if (options.json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  const { skill } = detail;
  console.log(mark('report', `${skill.name}: ${skill.description}`));
  console.log(`  Folder    ${skill.dir}`);
  if (skill.kind === 'added') {
    console.log(`  Source    ${sourceText(skill.source)}`);
    console.log(`  State     ${skill.present ? (skill.enabled ? 'on' : 'off') : 'folder missing'}${skill.modified ? ', changed by hand since JERRY installed it' : ''}`);
    console.log(`  Started   ${triggerText(skill)}`);
    console.log(`  Installed ${skill.installedAt}, updated ${skill.updatedAt}`);
  } else console.log(`  ${skill.kind === 'jerry' ? "JERRY's own skill (read-only)" : 'Not installed by JERRY (read-only here)'}`);
  console.log(`  Files     ${detail.files.length}`);
  for (const file of detail.files) console.log(`    ${file.path.padEnd(48)} ${formatBytes(file.size).padStart(9)}`);
  for (const finding of detail.scan) console.log(`  ${findingLine(finding)}`);
  if (detail.history.length > 0) {
    console.log('  History');
    for (const event of detail.history) console.log(`    ${event.at}  ${event.action} (${event.channel})`);
  }
  if (detail.skillMd !== null) {
    console.log('');
    for (const line of detail.skillMd.split(/\r?\n/)) console.log(`  | ${line}`);
  }
}

async function typedName(name: string, what: string): Promise<boolean> {
  const typed = (await ask(`Type the skill name to ${what} (${name}): `)).trim().toLowerCase();
  if (typed === name) return true;
  console.log(mark('fail', 'Confirmation did not match. Nothing changed.'));
  process.exitCode = 1;
  return false;
}

export async function addSkill(source: string): Promise<void> {
  requireTerminal('Adding a skill');
  console.log(mark('info', 'Reading the skill (from GitHub only its folder is downloaded; a large skill takes a while)…'));
  let answer: unknown;
  try {
    answer = await callCore('POST', '/api/v1/skills/preview', { source: skillSourceArgument(source) }, PREVIEW_TIMEOUT_MS);
  } catch (error) {
    const candidates = candidateUrls(error instanceof Error ? error.message : String(error));
    if (candidates.length === 0) throw error;
    console.log(mark('report', 'This repository holds several skills. Add one of them:'));
    for (const url of candidates) console.log(`  jerry skill add ${url}`);
    process.exitCode = 1;
    return;
  }
  const preview = skillPreviewSchema.parse(answer);
  printPreview(preview);
  if (preview.blocked !== null) throw new Error(preview.blocked);
  console.log(flag('A skill gives Claude instructions in every session and may tell it to run its scripts. Install only what you have read and trust.'));
  if (!(await typedName(preview.name, 'install it'))) return;
  printChange(skillChangeResultSchema.parse(await callCore('POST', '/api/v1/skills/install', { previewId: preview.previewId }, CHANGE_TIMEOUT_MS)));
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  requireTerminal(enabled ? 'Switching a skill on' : 'Switching a skill off');
  const what = enabled ? `Switch ${name} on (skillOverrides "name-only" in Claude Code's settings, so Claude uses it only when JERRY says so; a backup is taken)?` : `Switch ${name} off (skillOverrides "off" in Claude Code's settings; the folder stays; a backup is taken)?`;
  if (!(await confirm(what))) return;
  printChange(skillChangeResultSchema.parse(await callCore('POST', `/api/v1/skills/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, {}, CHANGE_TIMEOUT_MS)));
}

/** The task states given on the command line, upper-cased; unknown ones are refused with the valid list. */
export function parseSkillStates(values: readonly string[]): string[] {
  const states = values.flatMap((value) => value.split(',')).map((value) => value.trim().toUpperCase()).filter((value) => value !== '');
  const unknown = states.filter((state) => !(SKILL_TRIGGER_STATES as readonly string[]).includes(state));
  if (unknown.length > 0) throw new Error(`Not a state JERRY can start a skill in: ${unknown.join(', ')}. Use: ${SKILL_TRIGGER_STATES.join(', ')}.`);
  return [...new Set(states)];
}

export async function setSkillStates(name: string, values: readonly string[], options: { clear: boolean }): Promise<void> {
  requireTerminal('Assigning a skill to task states');
  if (options.clear === (values.length > 0)) throw new Error('Give the states (e.g. CODE_REVIEW REVERIFICATION), or --clear to assign none.');
  const states = options.clear ? [] : parseSkillStates(values);
  const what =
    states.length === 0
      ? `JERRY will not start ${name} in any task state, so Claude will not use it. Continue?`
      : `JERRY will tell Claude to use ${name} while a task is in ${states.join(', ')}. A skill installed before this gets "user-invocable: false" in its SKILL.md (its folder is backed up first). Continue?`;
  if (!(await confirm(what))) return;
  printChange(skillChangeResultSchema.parse(await callCore('POST', `/api/v1/skills/${encodeURIComponent(name)}/states`, { states }, CHANGE_TIMEOUT_MS)));
}

export async function updateSkill(name: string, options: { from?: string }): Promise<void> {
  requireTerminal('Updating a skill');
  const body = options.from === undefined ? {} : { source: skillSourceArgument(options.from) };
  const preview = skillPreviewSchema.parse(await callCore('POST', `/api/v1/skills/${encodeURIComponent(name)}/update/preview`, body, PREVIEW_TIMEOUT_MS));
  if (preview.upToDate) {
    console.log(mark('pass', `${name} is up to date (${sourceText(preview.source)}).`));
    return;
  }
  printPreview(preview);
  if (preview.blocked !== null) throw new Error(preview.blocked);
  if (!(await confirm(`Replace ${name} with this version (the installed folder goes to JERRY's backups)?`))) return;
  printChange(skillChangeResultSchema.parse(await callCore('POST', `/api/v1/skills/${encodeURIComponent(name)}/update/apply`, { previewId: preview.previewId }, CHANGE_TIMEOUT_MS)));
}

export async function removeSkill(name: string): Promise<void> {
  requireTerminal('Removing a skill');
  const detail = skillDetailSchema.parse(await callCore('GET', `/api/v1/skills/${encodeURIComponent(name)}`));
  if (detail.skill.kind !== 'added') throw new Error(`JERRY did not install ${name}; it removes only the skills it installed.`);
  console.log(mark('report', `${detail.skill.name}: ${detail.skill.dir} (${detail.files.length} file(s)) goes to JERRY's backups.`));
  if (!(await typedName(detail.skill.name, 'remove it'))) return;
  printChange(skillChangeResultSchema.parse(await callCore('POST', `/api/v1/skills/${encodeURIComponent(detail.skill.name)}/remove`, {}, CHANGE_TIMEOUT_MS)));
}
