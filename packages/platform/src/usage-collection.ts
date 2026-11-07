import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-atomic.js';
import { DEFAULT_CORE_PORT, resolveCorePort } from './core-runtime.js';
import { assertJerryHomeOutsideRepositories } from './home-safety.js';
import { jerryPaths, type Env } from './jerry-home.js';
import { readStatuslineConfig, writeStatuslineConfig, type StatusLineSetting } from './statusline.js';

/**
 * Claude usage collection: the two documented sources JERRY turns on in the user's Claude Code
 * settings (CLAUDE_CONFIG_DIR/settings.json), shared by the CLI ("jerry install", "jerry usage …",
 * "jerry statusline …") and Core (the dashboard's switch).
 *
 *   - the status line ("statusLine"): plan limits and the session cost, in terminal sessions;
 *   - telemetry ("env"): Claude Code's OpenTelemetry metrics (tokens and cost of every session,
 *     including the VS Code extension), sent to Core's /v1/metrics on 127.0.0.1.
 *
 * Every change takes a timestamped backup of settings.json first and keeps every other key as it is.
 * JERRY remembers what it set (JERRY_HOME/config), so turning a source off removes exactly that and
 * never something the user set. Telemetry the user configured themselves is never overwritten.
 */

// --- settings.json --------------------------------------------------------------------------

/** Settings backups JERRY keeps; older ones are deleted. */
const SETTINGS_BACKUPS_TO_KEEP = 10;
const SETTINGS_BACKUP_PATTERN = /^claude-settings-.*\.json$/;

export function claudeSettingsFile(claudeConfigDir: string): string {
  return path.join(claudeConfigDir, 'settings.json');
}

/** settings.json as an object; {} when it does not exist. Anything unreadable stops the change. */
export function readClaudeSettings(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`);
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message}); JERRY changed nothing. Fix the file, then try again.`);
  }
  if (!isRecord(parsed)) throw new Error(`${file} does not hold a JSON object; JERRY changed nothing.`);
  return parsed;
}

/** A timestamped copy in JERRY_HOME/backups; null when there was no settings file to back up. */
export function backupClaudeSettings(home: string, file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const { backupsDir } = jerryPaths(home);
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = path.join(backupsDir, `claude-settings-${stamp}.json`);
  for (let suffix = 2; fs.existsSync(target); suffix += 1) target = path.join(backupsDir, `claude-settings-${stamp}-${suffix}.json`);
  fs.copyFileSync(file, target);
  const backups = fs
    .readdirSync(backupsDir)
    .filter((name) => SETTINGS_BACKUP_PATTERN.test(name))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - SETTINGS_BACKUPS_TO_KEEP))) fs.rmSync(path.join(backupsDir, name), { force: true });
  return target;
}

export function writeClaudeSettings(file: string, settings: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface UsageLocations {
  home: string;
  claudeConfigDir: string;
}

// --- Status line ------------------------------------------------------------------------------

export interface StatuslineLocations extends UsageLocations {
  /** The built script to install; default: the copy in JERRY's plugin, else the one already installed. */
  payload?: string;
}

export type StatuslineChange = 'enabled' | 'updated' | 'unchanged' | 'restored' | 'removed' | 'not-jerry' | 'not-enabled';

export interface StatuslineResult {
  change: StatuslineChange;
  settingsFile: string;
  backupFile: string | null;
  previous: StatusLineSetting | null;
}

/** Forward slashes: Claude Code runs the command through Git Bash on Windows, where backslashes are escapes. */
function forwardSlashes(file: string): string {
  return file.replaceAll('\\', '/');
}

/** The statusLine value that runs JERRY's installed script. */
export function jerryStatusLine(home: string): StatusLineSetting {
  return { type: 'command', command: `node "${forwardSlashes(jerryPaths(home).runtimeStatuslineFile)}"`, padding: 0 };
}

/** True when a statusLine value runs JERRY's script from this JERRY home. */
export function isJerryStatusLine(value: unknown, home: string): boolean {
  if (!isRecord(value)) return false;
  const command = value['command'];
  if (typeof command !== 'string') return false;
  const key = (text: string): string => {
    const forward = forwardSlashes(text);
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
  };
  return key(command).includes(key(jerryPaths(home).runtimeStatuslineFile));
}

/** The status-line script inside the plugin "jerry install" published (Core installs it from there). */
export function pluginStatuslinePayload(home: string): string {
  return path.join(jerryPaths(home).marketplaceDir, 'plugins', 'jerry', 'statusline', 'statusline.mjs');
}

/**
 * Copies the built script to JERRY_HOME/runtime/statusline (staged, then renamed). Without a payload
 * it uses the plugin's copy, or keeps the script already installed.
 */
export function installStatuslineScript(home: string, payload?: string): void {
  const target = jerryPaths(home).runtimeStatuslineFile;
  const source = payload ?? (fs.existsSync(pluginStatuslinePayload(home)) ? pluginStatuslinePayload(home) : null);
  if (source === null) {
    if (fs.existsSync(target)) return;
    throw new Error(`JERRY's status-line script is not installed (${target}). Run "jerry install" first.`);
  }
  if (!fs.existsSync(source)) throw new Error(`Status-line script not found at ${source}. Run "pnpm build" first.`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = `${target}.${process.pid}.staging`;
  fs.copyFileSync(source, staging);
  fs.renameSync(staging, target);
}

/**
 * Makes JERRY's script the Claude Code status line. The one it replaces is saved (and chained);
 * every other key of settings.json stays. Running it again changes nothing.
 */
export function applyStatusline(locations: StatuslineLocations): StatuslineResult {
  const { home, claudeConfigDir } = locations;
  assertJerryHomeOutsideRepositories(home);
  const settingsFile = claudeSettingsFile(claudeConfigDir);
  const settings = readClaudeSettings(settingsFile);
  installStatuslineScript(home, locations.payload);
  const desired = jerryStatusLine(home);
  const current = settings['statusLine'];
  const config = readStatuslineConfig(home);

  if (isJerryStatusLine(current, home)) {
    if (config === null) writeStatuslineConfig(home, { previous: null, enabledAt: new Date().toISOString() });
    const previous = config?.previous ?? null;
    if (sameJson(current, desired)) return { change: 'unchanged', settingsFile, backupFile: null, previous };
    const backupFile = backupClaudeSettings(home, settingsFile);
    writeClaudeSettings(settingsFile, { ...settings, statusLine: desired });
    return { change: 'updated', settingsFile, backupFile, previous };
  }

  const previous = isRecord(current) ? current : null;
  // Saved before settings.json changes, so the user's status line can always be restored.
  writeStatuslineConfig(home, { previous, enabledAt: new Date().toISOString() });
  const backupFile = backupClaudeSettings(home, settingsFile);
  writeClaudeSettings(settingsFile, { ...settings, statusLine: desired });
  return { change: 'enabled', settingsFile, backupFile, previous };
}

/**
 * Puts back the status line JERRY's replaced (or removes the key when there was none). A status line
 * the user set after JERRY's is left alone. Running it again changes nothing.
 */
export function removeStatusline(locations: UsageLocations): StatuslineResult {
  const { home, claudeConfigDir } = locations;
  const settingsFile = claudeSettingsFile(claudeConfigDir);
  const config = readStatuslineConfig(home);
  const previous = config?.previous ?? null;
  const settings = fs.existsSync(settingsFile) ? readClaudeSettings(settingsFile) : null;
  const { statuslineConfigFile } = jerryPaths(home);

  if (settings === null || !isJerryStatusLine(settings['statusLine'], home)) {
    fs.rmSync(statuslineConfigFile, { force: true });
    return { change: config === null ? 'not-enabled' : 'not-jerry', settingsFile, backupFile: null, previous };
  }
  const backupFile = backupClaudeSettings(home, settingsFile);
  const restored: Record<string, unknown> = { ...settings, statusLine: previous };
  if (previous === null) delete restored['statusLine'];
  writeClaudeSettings(settingsFile, restored);
  fs.rmSync(statuslineConfigFile, { force: true });
  return { change: previous === null ? 'removed' : 'restored', settingsFile, backupFile, previous };
}

/** on: JERRY's status line is set; not-jerry: another status line is; off: none is. */
export type StatuslineState = 'on' | 'off' | 'not-jerry';

export function statuslineState(settings: Record<string, unknown>, home: string): StatuslineState {
  const current = settings['statusLine'];
  if (isJerryStatusLine(current, home)) return 'on';
  return current === undefined || current === null ? 'off' : 'not-jerry';
}

// --- Telemetry --------------------------------------------------------------------------------

/** The header Claude Code's OTLP exporter sends with every export; Core checks it. */
export const TELEMETRY_KEY_HEADER = 'x-jerry-telemetry-key';
/** The OTLP/HTTP path Core receives metrics on. */
export const TELEMETRY_METRICS_PATH = '/v1/metrics';

/** JERRY_HOME/config/telemetry.json. */
export interface TelemetryConfig {
  /** Random, 32 bytes as hex; created once, kept when telemetry is turned off. */
  key: string;
  /** The env keys and values JERRY wrote into settings.json; null while JERRY's telemetry is off. */
  setByJerry: Record<string, string> | null;
  /** True when settings.json had no "env" before JERRY's keys, so turning off removes the empty object. */
  createdEnv: boolean;
  enabledAt: string | null;
}

export function readTelemetryConfig(home: string): TelemetryConfig | null {
  const parsed = readJson(jerryPaths(home).telemetryConfigFile);
  if (!isRecord(parsed) || typeof parsed['key'] !== 'string' || !/^[0-9a-f]{64}$/.test(parsed['key'])) return null;
  const set = parsed['setByJerry'];
  const setByJerry = isRecord(set) && Object.values(set).every((value) => typeof value === 'string') ? (set as Record<string, string>) : null;
  return { key: parsed['key'], setByJerry, createdEnv: parsed['createdEnv'] === true, enabledAt: typeof parsed['enabledAt'] === 'string' ? parsed['enabledAt'] : null };
}

function writeTelemetryConfig(home: string, config: TelemetryConfig): void {
  writeFileAtomic(jerryPaths(home).telemetryConfigFile, `${JSON.stringify(config, null, 2)}\n`);
}

/** The telemetry key, created on first use (random, never a fixed value). */
export function ensureTelemetryKey(home: string): TelemetryConfig {
  const existing = readTelemetryConfig(home);
  if (existing !== null) return existing;
  const created: TelemetryConfig = { key: randomBytes(32).toString('hex'), setByJerry: null, createdEnv: false, enabledAt: null };
  writeTelemetryConfig(home, created);
  return created;
}

/** The env keys JERRY writes: metrics only, OTLP over HTTP/JSON, to Core on 127.0.0.1. */
export function telemetryEnv(key: string, port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}${TELEMETRY_METRICS_PATH}`,
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: `${TELEMETRY_KEY_HEADER}=${key}`,
  };
}

/**
 * The Core port the metrics endpoint names: the configured one (JERRY_CORE_PORT, default 47823). With
 * "any free port" (0, tests) the running Core's port, else the default.
 */
export function telemetryPort(home: string, env: Env = process.env): number {
  const configured = resolveCorePort(env);
  if (configured !== 0) return configured;
  const info = readJson(jerryPaths(home).coreInfoFile);
  const running = isRecord(info) ? info['port'] : undefined;
  return typeof running === 'number' && Number.isInteger(running) && running > 0 ? running : DEFAULT_CORE_PORT;
}

/** Keys that mean the user configured telemetry (or an exporter) themselves. */
function isTelemetryKey(name: string): boolean {
  return name === 'CLAUDE_CODE_ENABLE_TELEMETRY' || (name.startsWith('OTEL_') && /EXPORTER|ENDPOINT|PROTOCOL|HEADERS/.test(name));
}

/** Telemetry keys in env that JERRY did not set (or whose value the user changed). */
export function telemetryClashKeys(env: Record<string, unknown>, config: TelemetryConfig | null): string[] {
  return Object.keys(env)
    .filter(isTelemetryKey)
    .filter((name) => config?.setByJerry?.[name] === undefined || config.setByJerry[name] !== env[name])
    .sort();
}

/** on: JERRY's keys are all in place; clash: telemetry the user configured; off: neither. */
export type TelemetryState = 'on' | 'off' | 'clash';

function envOf(settings: Record<string, unknown>, file: string): Record<string, unknown> {
  const env = settings['env'];
  if (env === undefined || env === null) return {};
  if (!isRecord(env)) throw new Error(`"env" in ${file} is not an object; JERRY changed nothing.`);
  return env;
}

export function telemetryState(settings: Record<string, unknown>, config: TelemetryConfig | null): TelemetryState {
  const env = isRecord(settings['env']) ? settings['env'] : {};
  const set = config?.setByJerry ?? null;
  if (set !== null && Object.keys(set).length > 0 && Object.entries(set).every(([name, value]) => env[name] === value)) return 'on';
  return telemetryClashKeys(env, config).length > 0 ? 'clash' : 'off';
}

export type TelemetryChange = 'enabled' | 'updated' | 'unchanged' | 'clash' | 'removed' | 'not-jerry' | 'not-enabled';

export interface TelemetryResult {
  change: TelemetryChange;
  settingsFile: string;
  backupFile: string | null;
  /** With 'clash': the keys the user set, which JERRY leaves alone. */
  clashKeys: string[];
  /** The metrics endpoint JERRY configured (enable only). */
  endpoint: string | null;
}

/**
 * Writes JERRY's telemetry keys into settings.json "env" (and nothing else). When the user
 * configured telemetry or an OTLP exporter themselves, nothing changes and the result is 'clash'.
 * Running it again changes nothing; a new Core port updates JERRY's own keys.
 */
export function applyTelemetry(locations: UsageLocations & { port: number }): TelemetryResult {
  const { home, claudeConfigDir, port } = locations;
  assertJerryHomeOutsideRepositories(home);
  const settingsFile = claudeSettingsFile(claudeConfigDir);
  const settings = readClaudeSettings(settingsFile);
  const env = envOf(settings, settingsFile);
  const config = ensureTelemetryKey(home);
  const desired = telemetryEnv(config.key, port);
  const endpoint = desired['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']!;
  const clashKeys = telemetryClashKeys(env, config);
  if (clashKeys.length > 0) return { change: 'clash', settingsFile, backupFile: null, clashKeys, endpoint: null };

  const jerryKeysPresent = config.setByJerry !== null && Object.keys(config.setByJerry).some((name) => env[name] !== undefined);
  if (Object.entries(desired).every(([name, value]) => env[name] === value) && sameJson(config.setByJerry, desired)) {
    return { change: 'unchanged', settingsFile, backupFile: null, clashKeys: [], endpoint };
  }
  // Saved before settings.json changes, so JERRY's keys can always be removed again.
  const createdEnv = jerryKeysPresent ? config.createdEnv : settings['env'] === undefined;
  writeTelemetryConfig(home, { ...config, setByJerry: desired, createdEnv, enabledAt: new Date().toISOString() });
  const backupFile = backupClaudeSettings(home, settingsFile);
  writeClaudeSettings(settingsFile, { ...settings, env: { ...env, ...desired } });
  return { change: jerryKeysPresent ? 'updated' : 'enabled', settingsFile, backupFile, clashKeys: [], endpoint };
}

/**
 * Removes exactly the env keys JERRY set, and only where they still hold JERRY's values; keys the
 * user changed stay. Running it again changes nothing.
 */
export function removeTelemetry(locations: UsageLocations): TelemetryResult {
  const { home, claudeConfigDir } = locations;
  const settingsFile = claudeSettingsFile(claudeConfigDir);
  const config = readTelemetryConfig(home);
  const none = (change: TelemetryChange): TelemetryResult => ({ change, settingsFile, backupFile: null, clashKeys: [], endpoint: null });
  if (config === null || config.setByJerry === null) return none('not-enabled');
  const forget = (): void => writeTelemetryConfig(home, { ...config, setByJerry: null, createdEnv: false, enabledAt: null });
  const settings = fs.existsSync(settingsFile) ? readClaudeSettings(settingsFile) : null;
  const env = settings === null ? {} : envOf(settings, settingsFile);
  const ours = Object.entries(config.setByJerry).filter(([name, value]) => env[name] === value).map(([name]) => name);
  if (settings === null || ours.length === 0) {
    forget();
    return none('not-jerry');
  }
  const backupFile = backupClaudeSettings(home, settingsFile);
  const remaining = Object.fromEntries(Object.entries(env).filter(([name]) => !ours.includes(name)));
  const restored: Record<string, unknown> = { ...settings, env: remaining };
  if (Object.keys(remaining).length === 0 && config.createdEnv) delete restored['env'];
  writeClaudeSettings(settingsFile, restored);
  forget();
  return { change: 'removed', settingsFile, backupFile, clashKeys: [], endpoint: null };
}

// --- Both sources -----------------------------------------------------------------------------

export interface UsageCollectionStatus {
  statusline: StatuslineState;
  telemetry: TelemetryState;
  settingsFile: string;
  /** Why settings.json could not be read, else null (both sources then count as off). */
  problem: string | null;
}

/** Read-only. */
export function usageCollectionStatus(locations: UsageLocations): UsageCollectionStatus {
  const settingsFile = claudeSettingsFile(locations.claudeConfigDir);
  try {
    const settings = readClaudeSettings(settingsFile);
    return { statusline: statuslineState(settings, locations.home), telemetry: telemetryState(settings, readTelemetryConfig(locations.home)), settingsFile, problem: null };
  } catch (error) {
    return { statusline: 'off', telemetry: 'off', settingsFile, problem: (error as Error).message };
  }
}

/** One source's outcome: its result, or why it failed (the other source is still changed). */
export type SourceOutcome<T> = { ok: true; result: T } | { ok: false; error: string };

export interface UsageCollectionChange {
  statusline: SourceOutcome<StatuslineResult>;
  telemetry: SourceOutcome<TelemetryResult>;
}

function attempt<T>(work: () => T): SourceOutcome<T> {
  try {
    return { ok: true, result: work() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Turns both sources on; each is attempted even when the other fails. */
export function enableUsageCollection(locations: StatuslineLocations & { port: number }): UsageCollectionChange {
  return { statusline: attempt(() => applyStatusline(locations)), telemetry: attempt(() => applyTelemetry(locations)) };
}

/** Turns both sources off; each is attempted even when the other fails. */
export function disableUsageCollection(locations: UsageLocations): UsageCollectionChange {
  return { statusline: attempt(() => removeStatusline(locations)), telemetry: attempt(() => removeTelemetry(locations)) };
}

// --- What arrived last (no usage numbers) -----------------------------------------------------

/**
 * JERRY_HOME/run/telemetry-last.json: when Core last received metrics, overall and per entrypoint,
 * and the attribute names (never values) on the last request, for diagnosis.
 */
export interface TelemetryLast {
  at: string;
  byEntrypoint: Record<string, string>;
  /** Sorted attribute keys of the last request's resources and points; names only. */
  attributeKeys: string[];
}

/** Attribute keys remembered from the last request. */
export const MAX_TELEMETRY_ATTRIBUTE_KEYS = 50;

function attributeKeysOf(keys: readonly unknown[]): string[] {
  return [...new Set(keys.filter((key): key is string => typeof key === 'string' && key !== ''))].sort().slice(0, MAX_TELEMETRY_ATTRIBUTE_KEYS);
}

export function readTelemetryLast(home: string): TelemetryLast | null {
  const parsed = readJson(jerryPaths(home).telemetryLastFile);
  if (!isRecord(parsed) || typeof parsed['at'] !== 'string') return null;
  const byEntrypoint: Record<string, string> = {};
  if (isRecord(parsed['byEntrypoint'])) {
    for (const [entrypoint, at] of Object.entries(parsed['byEntrypoint'])) if (typeof at === 'string') byEntrypoint[entrypoint] = at;
  }
  const attributeKeys = Array.isArray(parsed['attributeKeys']) ? attributeKeysOf(parsed['attributeKeys']) : [];
  return { at: parsed['at'], byEntrypoint, attributeKeys };
}

/** Entrypoints remembered; older ones drop out. */
const MAX_TELEMETRY_ENTRYPOINTS = 10;

export function writeTelemetryLast(home: string, at: string, entrypoints: readonly string[], attributeKeys: readonly string[] = []): TelemetryLast {
  const previous = readTelemetryLast(home)?.byEntrypoint ?? {};
  const merged = { ...previous };
  for (const entrypoint of entrypoints) merged[entrypoint] = at;
  const byEntrypoint = Object.fromEntries(
    Object.entries(merged)
      .sort(([, a], [, b]) => b.localeCompare(a))
      .slice(0, MAX_TELEMETRY_ENTRYPOINTS),
  );
  const content: TelemetryLast = { at, byEntrypoint, attributeKeys: attributeKeysOf(attributeKeys) };
  writeFileAtomic(jerryPaths(home).telemetryLastFile, `${JSON.stringify(content, null, 2)}\n`);
  return content;
}
