import path from 'node:path';
import { projectSummarySchema, qaLanguageSchema, reviewModeSchema, settingsSchema, type ProjectSummary, type Settings } from '@jerry/contracts';
import { z } from 'zod';
import { mark } from './emoji.js';
import { ask, callCore, requireTerminal, samePath } from './terminal.js';

/**
 * `jerry settings`: the user's workflow settings. Reading them is open to anyone; changing them is
 * the user's decision, like approvals: an interactive terminal and a y/N confirmation.
 */

const SETTING_KEYS = ['review.mode', 'qa.language'] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const LANGUAGE_NAMES: Readonly<Record<Settings['qaLanguage'], string>> = { pl: 'Polish', en: 'English' };

export async function showSettings(options: { json: boolean } = { json: false }): Promise<void> {
  const settings = settingsSchema.parse(await callCore('GET', '/api/v1/settings'));
  const projects = z.array(projectSummarySchema).parse(await callCore('GET', '/api/v1/projects'));
  if (options.json) {
    console.log(JSON.stringify({ ...settings, projects: projects.map((project) => ({ repoRoot: project.repoRoot, reviewMode: project.reviewMode, effectiveReviewMode: project.effectiveReviewMode })) }, null, 2));
    return;
  }
  console.log(mark('jerry', 'JERRY settings'));
  console.log(`  review.mode   ${settings.reviewMode}  (${settings.reviewMode === 'required' ? 'every accepted implementation goes to independent review' : 'independent review only when you ask for it at acceptance'})`);
  console.log(`  qa.language   ${settings.qaLanguage}  (QA scenarios in reports are written in ${LANGUAGE_NAMES[settings.qaLanguage]})`);
  const overrides = projects.filter((project) => project.reviewMode !== null);
  if (overrides.length > 0) {
    console.log('  Projects with their own review mode:');
    for (const project of overrides) console.log(`    ${project.repoRoot}  review.mode ${project.reviewMode}`);
  }
  console.log(`\n${mark('next', 'Change one in an interactive terminal: jerry settings set review.mode optional|required [--project <path>] or jerry settings set qa.language pl|en')}`);
}

/** The project containing a path (or the project at it). */
function projectAt(projects: readonly ProjectSummary[], target: string): ProjectSummary | undefined {
  const wanted = path.resolve(target);
  const inside = (root: string): boolean => {
    const relative = path.relative(root, wanted);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  return projects.find((project) => samePath(project.repoRoot, wanted)) ?? projects.find((project) => inside(project.repoRoot));
}

function settingKey(value: string): SettingKey {
  const key = SETTING_KEYS.find((candidate) => candidate === value.toLowerCase());
  if (key === undefined) throw new Error(`Unknown setting "${value}"; settings are ${SETTING_KEYS.join(' and ')}.`);
  return key;
}

export async function setSetting(rawKey: string, rawValue: string, options: { project?: string }): Promise<void> {
  const key = settingKey(rawKey);
  const value = rawValue.trim().toLowerCase();
  // Validate before asking anything.
  if (key === 'qa.language') {
    if (options.project !== undefined) throw new Error('qa.language is a global setting; it has no per-project value.');
    if (!qaLanguageSchema.safeParse(value).success) throw new Error('qa.language must be "pl" or "en".');
  } else if (!reviewModeSchema.safeParse(value).success && !(options.project !== undefined && value === 'inherit')) {
    throw new Error(options.project === undefined ? 'review.mode must be "optional" or "required".' : 'review.mode of a project must be "optional", "required" or "inherit" (follow the global setting).');
  }
  requireTerminal('Changing a setting');

  if (options.project !== undefined) {
    const projects = z.array(projectSummarySchema).parse(await callCore('GET', '/api/v1/projects'));
    const project = projectAt(projects, options.project);
    if (project === undefined) throw new Error(`${path.resolve(options.project)} is not in a JERRY project (see "jerry project list").`);
    const reviewMode = value === 'inherit' ? null : reviewModeSchema.parse(value);
    const describe = (mode: ProjectSummary['reviewMode']): string => (mode === null ? 'inherit (follow the global setting)' : mode);
    if (!(await confirm(`Change review.mode of ${project.repoRoot} from ${describe(project.reviewMode)} to ${describe(reviewMode)}?`))) return;
    const updated = projectSummarySchema.parse(await callCore('POST', '/api/v1/projects/settings', { path: project.repoRoot, reviewMode }));
    console.log(mark('pass', `review.mode of ${updated.repoRoot} is ${describe(updated.reviewMode)}; in effect there: ${updated.effectiveReviewMode}.`));
    return;
  }

  const current = settingsSchema.parse(await callCore('GET', '/api/v1/settings'));
  const before = key === 'review.mode' ? current.reviewMode : current.qaLanguage;
  if (!(await confirm(`Change ${key} from ${before} to ${value}?`))) return;
  const update = key === 'review.mode' ? { reviewMode: reviewModeSchema.parse(value) } : { qaLanguage: qaLanguageSchema.parse(value) };
  const settings = settingsSchema.parse(await callCore('POST', '/api/v1/settings', update));
  console.log(mark('pass', `${key} is ${key === 'review.mode' ? settings.reviewMode : settings.qaLanguage}.`));
}

/** A y/N question; anything but yes changes nothing. */
async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  console.log(mark('info', 'Nothing changed.'));
  return false;
}
