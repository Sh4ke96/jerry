import { usageSummarySchema, type UsageSummary } from '@jerry/contracts';
import {
  claudeSettingsFile,
  disableUsageCollection,
  enableUsageCollection,
  readStatuslineConfig,
  readStatuslineLast,
  readTelemetryConfig,
  readTelemetryLast,
  telemetryPort,
  usageCollectionStatus,
  type SourceOutcome,
  type TelemetryResult,
  type UsageCollectionChange,
  type UsageLocations,
} from '@jerry/platform';
import { mark } from './emoji.js';
import { age, confirm, defaultLocations, reportEnabled, reportRemoved, STATUSLINE_PAYLOAD } from './statusline-commands.js';
import { callCore, requireTerminal } from './terminal.js';

/**
 * Claude usage collection: JERRY's status line (plan limits and session cost, terminal sessions) and
 * Claude Code's telemetry (tokens and cost of every session, VS Code included), both in the user's
 * Claude Code settings. "jerry install" turns both on; "jerry usage enable|disable" and the
 * dashboard switch them together; uninstall restores the settings.
 */

/** Lines `jerry install` and `jerry usage enable` print about telemetry. */
export function reportTelemetryEnabled(result: TelemetryResult): void {
  const backup = result.backupFile === null ? '' : `; backup: ${result.backupFile}`;
  switch (result.change) {
    case 'enabled':
    case 'updated':
      console.log(mark('pass', `Claude Code telemetry is on: metrics (tokens and cost) go to JERRY Core at ${result.endpoint} (${result.settingsFile}${backup}).`));
      break;
    case 'unchanged':
      console.log(mark('pass', `Claude Code telemetry is on (${result.settingsFile}).`));
      break;
    case 'clash':
      console.log(
        mark('warning', `You configured Claude Code telemetry yourself (${result.clashKeys.join(', ')} in ${result.settingsFile}); JERRY left it as it is, so tokens and cost are not collected. Plan limits still come from the status line.`),
      );
      break;
    default:
      break;
  }
}

/** Lines `jerry uninstall` and `jerry usage disable` print about telemetry. */
export function reportTelemetryRemoved(result: TelemetryResult): void {
  const backup = result.backupFile === null ? '' : ` (backup: ${result.backupFile})`;
  switch (result.change) {
    case 'removed':
      console.log(mark('pass', `Removed JERRY's telemetry settings from ${result.settingsFile}${backup}.`));
      break;
    case 'not-jerry':
      console.log(mark('info', `The telemetry settings in ${result.settingsFile} are not JERRY's any more; left as they are.`));
      break;
    default:
      console.log(mark('info', "JERRY's telemetry was not on."));
  }
}

function reportOutcome<T>(outcome: SourceOutcome<T>, what: string, report: (result: T) => void, fix: string): boolean {
  if (outcome.ok) {
    report(outcome.result);
    return true;
  }
  console.log(mark('warning', `${what} was not changed: ${outcome.error} ${fix}`));
  return false;
}

/** Prints what a change of both sources did; false when one of them failed. */
export function reportCollectionChange(change: UsageCollectionChange, enabled: boolean): boolean {
  if (enabled) {
    const statusline = reportOutcome(change.statusline, "JERRY's status line", reportEnabled, 'Once fixed, run "jerry usage enable".');
    const telemetry = reportOutcome(change.telemetry, 'Claude Code telemetry', reportTelemetryEnabled, 'Once fixed, run "jerry usage enable".');
    return statusline && telemetry;
  }
  const statusline = reportOutcome(change.statusline, "JERRY's status line", reportRemoved, 'Remove its "statusLine" key by hand.');
  const telemetry = reportOutcome(change.telemetry, 'Claude Code telemetry', reportTelemetryRemoved, 'Remove the CLAUDE_CODE_ENABLE_TELEMETRY and OTEL_* keys JERRY added to "env" by hand.');
  return statusline && telemetry;
}

/** Turns both sources on (install and "jerry usage enable"); never throws. */
export function enableUsage(locations: UsageLocations = defaultLocations()): UsageCollectionChange {
  return enableUsageCollection({ ...locations, payload: STATUSLINE_PAYLOAD, port: telemetryPort(locations.home) });
}

/** Turns both sources off (uninstall and "jerry usage disable"); never throws. */
export function disableUsage(locations: UsageLocations = defaultLocations()): UsageCollectionChange {
  return disableUsageCollection(locations);
}

/** `jerry usage enable`: interactive, it changes the user's Claude Code settings. */
export async function enableUsageCommand(): Promise<void> {
  requireTerminal('Turning on Claude usage collection');
  const locations = defaultLocations();
  const settingsFile = claudeSettingsFile(locations.claudeConfigDir);
  const question = `In ${settingsFile}, set JERRY's status line (plan limits and session cost; yours is kept and shown above it) and Claude Code telemetry to JERRY Core on 127.0.0.1 (tokens and cost; only sessions in your projects are kept)? A backup is taken first.`;
  if (!(await confirm(question))) return;
  if (!reportCollectionChange(enableUsage(locations), true)) process.exitCode = 1;
  console.log(mark('next', 'Reload VS Code windows and restart terminal sessions so Claude Code reads the new settings. Check with: jerry usage status'));
}

/** `jerry usage disable`: interactive, it changes the user's Claude Code settings. */
export async function disableUsageCommand(): Promise<void> {
  requireTerminal('Turning off Claude usage collection');
  const locations = defaultLocations();
  const settingsFile = claudeSettingsFile(locations.claudeConfigDir);
  if (!(await confirm(`In ${settingsFile}, remove JERRY's status line (yours comes back) and JERRY's telemetry keys? A backup is taken first.`))) return;
  if (!reportCollectionChange(disableUsage(locations), false)) process.exitCode = 1;
}

/** The usage summary from Core, or null when Core is not running. */
async function summaryFromCore(): Promise<UsageSummary | null> {
  try {
    return usageSummarySchema.parse(await callCore('GET', '/api/v1/usage', undefined, 3000));
  } catch {
    return null;
  }
}

function sightings(byEntrypoint: Record<string, string>, now: Date): string[] {
  return Object.entries(byEntrypoint).map(([entrypoint, at]) => `    ${entrypoint.padEnd(16)} ${at} (${age(at, now)})`);
}

/** `jerry usage status`: read-only. */
export async function usageStatus(options: { json: boolean } = { json: false }): Promise<void> {
  const locations = defaultLocations();
  const collection = usageCollectionStatus(locations);
  const telemetryConfig = readTelemetryConfig(locations.home);
  const statuslineLast = readStatuslineLast(locations.home);
  const telemetryLast = readTelemetryLast(locations.home);
  const summary = await summaryFromCore();
  const endpoint = telemetryConfig?.setByJerry?.['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] ?? null;
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          settingsFile: collection.settingsFile,
          problem: collection.problem,
          statusline: { state: collection.statusline, chained: readStatuslineConfig(locations.home)?.previous ?? null, last: statuslineLast },
          telemetry: { state: collection.telemetry, endpoint, last: telemetryLast },
          core: summary === null ? null : { limits: summary.limits, totals: summary.totals, jerryShare: summary.jerryShare },
        },
        null,
        2,
      ),
    );
    return;
  }
  const now = new Date();
  console.log(mark('jerry', 'Claude usage collection'));
  console.log(`  settings      ${collection.settingsFile}${collection.problem === null ? '' : ` (${collection.problem})`}`);
  console.log(`  status line   ${collection.statusline}${collection.statusline === 'not-jerry' ? ' (another status line is set; jerry usage enable keeps it and shows it above JERRY\'s)' : ''}`);
  console.log(`  telemetry     ${collection.telemetry}${collection.telemetry === 'clash' ? ' (you configured telemetry yourself; JERRY leaves it alone)' : endpoint === null ? '' : ` -> ${endpoint}`}`);
  console.log('');
  console.log(`  status line last ran: ${statuslineLast === null ? 'never' : `${statuslineLast.at} (${age(statuslineLast.at, now)})`}`);
  if (statuslineLast !== null) console.log(sightings(Object.fromEntries(Object.entries(statuslineLast.byEntrypoint).map(([entrypoint, seen]) => [entrypoint, seen.at])), now).join('\n'));
  console.log(`  telemetry last arrived: ${telemetryLast === null ? 'never' : `${telemetryLast.at} (${age(telemetryLast.at, now)})`}`);
  if (telemetryLast !== null) console.log(sightings(telemetryLast.byEntrypoint, now).join('\n'));
  console.log('');
  if (summary === null) {
    console.log(mark('info', 'JERRY Core is not running: plan limits and totals are not shown (they live in its database).'));
  } else {
    const limit = (name: string, value: UsageSummary['limits']['fiveHour']): string =>
      value === null ? `  ${name.padEnd(13)} no current reading` : `  ${name.padEnd(13)} ${Math.round(value.pct)}%${value.resetsAt === null ? '' : `, resets ${value.resetsAt}`}; read ${value.readAt} (${age(value.readAt, now)}) from ${value.entrypoint ?? 'unknown'}`;
    console.log(limit('5-hour limit', summary.limits.fiveHour));
    console.log(limit('weekly limit', summary.limits.sevenDay));
    const total = (name: string, value: UsageSummary['totals']['today']): string => `  ${name.padEnd(13)} ${value.tokens.toLocaleString('en-US')} tokens, $${value.costUsd.toFixed(2)}`;
    console.log(total('today', summary.totals.today));
    console.log(total('last 7 days', summary.totals.last7d));
    console.log(total('last 30 days', summary.totals.last30d));
    console.log(`  JERRY's share ~${summary.jerryShare.estimatedTokens30d.toLocaleString('en-US')} tokens in 30 days (${summary.jerryShare.chars30d.toLocaleString('en-US')} characters)`);
  }
  if (collection.statusline !== 'on' || collection.telemetry === 'off') console.log(`\n${mark('next', 'Turn collection on in an interactive terminal: jerry usage enable')}`);
}
