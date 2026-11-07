import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyStatusline as applyStatuslineAt,
  claudeSettingsFile,
  isJerryStatusLine,
  jerryPaths,
  readClaudeSettings,
  readStatuslineConfig,
  readStatuslineLast,
  removeStatusline as removeStatuslineAt,
  resolveClaudeConfigDir,
  resolveJerryHome,
  type StatuslineLocations,
  type StatuslineResult,
  type StatusLineSetting,
  type UsageLocations,
} from '@jerry/platform';
import { mark } from './emoji.js';
import { ask, requireTerminal } from './terminal.js';

/**
 * JERRY's Claude Code status line: the plan usage (5-hour and weekly windows, like /usage) and the
 * session cost. A plugin cannot set the main "statusLine", so JERRY writes that one key of the
 * user's settings.json itself: a timestamped backup first, every other key kept as it is, and the
 * status line the user had before saved and chained (it still shows, above JERRY's). The settings
 * logic lives in @jerry/platform, shared with Core (the dashboard's usage switch).
 */

export { installStatuslineScript, isJerryStatusLine, jerryStatusLine, type StatuslineChange, type StatuslineLocations, type StatuslineResult } from '@jerry/platform';

/** The bundled script next to the CLI (dist/plugin/statusline/statusline.mjs). */
export const STATUSLINE_PAYLOAD = fileURLToPath(new URL('../plugin/statusline/statusline.mjs', import.meta.url));

export function defaultLocations(): UsageLocations {
  return { home: resolveJerryHome(), claudeConfigDir: resolveClaudeConfigDir() };
}

/**
 * Makes JERRY's script the Claude Code status line; the script shipped next to the CLI is installed
 * unless a payload is given. Running it again changes nothing.
 */
export function applyStatusline(locations: StatuslineLocations = defaultLocations()): StatuslineResult {
  return applyStatuslineAt({ ...locations, payload: locations.payload ?? STATUSLINE_PAYLOAD });
}

/** Puts back the status line JERRY's replaced (or removes the key when there was none). */
export function removeStatusline(locations: UsageLocations = defaultLocations()): StatuslineResult {
  return removeStatuslineAt(locations);
}

export function describeCommand(value: StatusLineSetting | null | undefined): string {
  if (value === null || value === undefined) return 'none';
  const command = value['command'];
  return typeof command === 'string' ? command : JSON.stringify(value);
}

/** Lines `jerry install` and `jerry statusline enable` print after turning the status line on. */
export function reportEnabled(result: StatuslineResult): void {
  const where = `${result.settingsFile}${result.backupFile === null ? '' : `; backup: ${result.backupFile}`}`;
  if (result.change === 'unchanged') {
    console.log(mark('pass', `JERRY's status line is on (${result.settingsFile}).`));
  } else {
    console.log(mark('pass', `JERRY's status line is on: Claude Code shows your plan usage (5-hour and weekly) and the session cost (${where}).`));
  }
  if (result.previous !== null) console.log(mark('info', `Your previous status line still shows, above JERRY's: ${describeCommand(result.previous)}`));
}

export async function confirm(question: string): Promise<boolean> {
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  console.log(mark('info', 'Nothing changed.'));
  return false;
}

/** `jerry statusline enable`: interactive, it changes the user's Claude Code settings. */
export async function enableStatusline(): Promise<void> {
  requireTerminal('Turning on JERRY\'s status line');
  const locations = defaultLocations();
  const settingsFile = claudeSettingsFile(locations.claudeConfigDir);
  if (!(await confirm(`Set JERRY's status line in ${settingsFile} (a backup is taken; your current status line is kept and shown above JERRY's)?`))) return;
  const result = applyStatusline(locations);
  reportEnabled(result);
  if (result.change !== 'unchanged') console.log(mark('next', 'Claude Code picks it up at its next status-line refresh. Turn it off with: jerry statusline disable'));
}

/** Lines `jerry uninstall` and `jerry statusline disable` print. */
export function reportRemoved(result: StatuslineResult): void {
  const backup = result.backupFile === null ? '' : ` (backup: ${result.backupFile})`;
  switch (result.change) {
    case 'restored':
      console.log(mark('pass', `Restored your previous status line in ${result.settingsFile}: ${describeCommand(result.previous)}${backup}`));
      break;
    case 'removed':
      console.log(mark('pass', `Removed JERRY's status line from ${result.settingsFile}${backup}.`));
      break;
    case 'not-jerry':
      console.log(mark('info', `The status line in ${result.settingsFile} is not JERRY's any more; left as it is.`));
      break;
    default:
      console.log(mark('info', "JERRY's status line was not on."));
  }
}

/** `jerry statusline disable`: interactive, it changes the user's Claude Code settings. */
export async function disableStatusline(): Promise<void> {
  requireTerminal('Turning off JERRY\'s status line');
  const locations = defaultLocations();
  const settingsFile = claudeSettingsFile(locations.claudeConfigDir);
  const previous = readStatuslineConfig(locations.home)?.previous ?? null;
  const what = previous === null ? 'remove JERRY\'s status line' : `put back your previous status line (${describeCommand(previous)})`;
  if (!(await confirm(`In ${settingsFile}, ${what} (a backup is taken)?`))) return;
  reportRemoved(removeStatusline(locations));
}

export function age(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

/** `jerry statusline status`: read-only. */
export function statuslineStatus(options: { json: boolean } = { json: false }): void {
  const { home, claudeConfigDir } = defaultLocations();
  const settingsFile = claudeSettingsFile(claudeConfigDir);
  let current: unknown;
  let settingsProblem: string | null = null;
  try {
    current = readClaudeSettings(settingsFile)['statusLine'];
  } catch (error) {
    settingsProblem = (error as Error).message;
  }
  const enabled = isJerryStatusLine(current, home);
  const config = readStatuslineConfig(home);
  const last = readStatuslineLast(home);
  const scriptInstalled = fs.existsSync(jerryPaths(home).runtimeStatuslineFile);
  if (options.json) {
    console.log(JSON.stringify({ enabled, settingsFile, statusLine: current ?? null, previous: config?.previous ?? null, enabledAt: config?.enabledAt ?? null, scriptInstalled, last }, null, 2));
    return;
  }
  const now = new Date();
  console.log(mark('jerry', `JERRY status line: ${enabled ? 'on' : 'off'}`));
  console.log(`  settings      ${settingsFile}${settingsProblem === null ? '' : ` (${settingsProblem})`}`);
  console.log(`  command       ${current === undefined ? 'none' : describeCommand(current as StatusLineSetting)}${enabled || current === undefined ? '' : ' (not JERRY\'s)'}`);
  if (enabled) {
    console.log(`  chained       ${describeCommand(config?.previous)}`);
    if (!scriptInstalled) console.log(`  ${mark('warning', `script missing at ${jerryPaths(home).runtimeStatuslineFile}; run jerry statusline enable or jerry install`)}`);
  }
  if (last === null) {
    console.log('  last run      never (no Claude Code session has run it yet)');
  } else {
    console.log(`  last run      ${last.at} (${age(last.at, now)}), entrypoint ${last.entrypoint ?? 'unknown'}, Claude Code ${last.version ?? '?'}, rate limits ${last.hasRateLimits ? 'present' : 'absent'}`);
    for (const [entrypoint, seen] of Object.entries(last.byEntrypoint)) {
      console.log(`    ${entrypoint.padEnd(16)} ${seen.at} (${age(seen.at, now)}), Claude Code ${seen.version ?? '?'}, rate limits ${seen.hasRateLimits ? 'present' : 'absent'}`);
    }
  }
  if (!enabled) console.log(`\n${mark('next', 'Turn it on in an interactive terminal: jerry statusline enable')}`);
}
