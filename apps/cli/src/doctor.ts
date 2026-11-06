import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ROLES, JERRY_VERSION } from '@jerry/contracts';
import {
  assertJerryHomeOutsideRepositories,
  buildHash,
  CoreHttpError,
  CoreUnavailableError,
  countSpooled,
  findClaudeBinary,
  jerryPaths,
  readCoreRuntimeInfo,
  requestCore,
  resolveClaudeConfigDir,
  resolveCorePort,
  resolveJerryHome,
  type ClaudeBinary,
} from '@jerry/platform';
import { claudeVersion, listInstalledPlugins, listMarketplaceNames, MARKETPLACE_NAME, PLUGIN_ID, runClaudeOrThrow } from './claude-cli.js';
import { getCoreStatus } from './core-commands.js';

/**
 * Spec §20: everything that decides whether JERRY actually guards the sessions, grouped by area.
 * Read-only: it never repairs anything, it says what to run.
 */

type CheckStatus = 'PASS' | 'WARN' | 'FAIL';
interface Check {
  section: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

/** The hook config uses `onFailure` (Claude Code 2.1.295+), see ADR 0001 and ADR 0003. */
const MIN_CLAUDE_VERSION = [2, 1, 295] as const;
/** node:sqlite without a flag (ADR 0005); Core is started with the `node` the hooks find on PATH. */
const MIN_NODE_VERSION = [22, 13, 0] as const;
const DISK_WARN_MIB = 1024;
/** Names JERRY must never create inside a project. */
const FOOTPRINT_NAMES = ['.jerry', '.harness', '.jerry.json', 'jerry.config.json'];
/** The plugin payload and Core built next to this CLI, to detect an installation that is out of date. */
const SIBLING_PLUGIN = fileURLToPath(new URL('../plugin/', import.meta.url));
const SIBLING_CORE = fileURLToPath(new URL('../core/core.mjs', import.meta.url));

export async function doctor(): Promise<void> {
  const checks: Check[] = [];
  let section = '';
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ section, name, status, detail });
  };

  // --- System --------------------------------------------------------------------------------
  section = 'System';
  add('os', 'PASS', `${os.version()} ${os.release()} (${os.arch()})`);
  const pathNode = findOnPath('node');
  if (pathNode === null) {
    add('node-for-hooks', 'FAIL', 'hooks run "node" from PATH, and none was found: every guarded tool call would be blocked (onFailure: block)');
  } else {
    const version = spawnSync(pathNode, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    const ok = atLeast(parseVersion(version), MIN_NODE_VERSION);
    add('node-for-hooks', ok ? 'PASS' : 'FAIL', `${version} at ${pathNode}${ok ? '' : ` (Core needs Node ${MIN_NODE_VERSION.join('.')}+ for node:sqlite)`}`);
  }
  const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((candidate) => fs.existsSync(candidate));
  const pwsh = findOnPath('pwsh');
  add('shells', 'PASS', `Git Bash ${gitBash === undefined ? 'not found (Claude Code uses its PowerShell tool only)' : `at ${gitBash}`}; PowerShell ${pwsh === null ? '5.1' : `7 at ${pwsh}`}; JERRY guards both shell tools`);

  // --- Claude Code ---------------------------------------------------------------------------
  section = 'Claude Code';
  let pluginRoot: string | null = null;
  const claude = findClaudeBinary();
  if (claude === null) {
    add('claude-cli', 'FAIL', 'Claude Code CLI not found (checked JERRY_CLAUDE_BIN, PATH, ~/.local/bin and the VS Code extension)');
  } else {
    pluginRoot = checkClaude(claude, add);
  }
  checkSettings(add);

  // --- JERRY Core ----------------------------------------------------------------------------
  section = 'JERRY Core';
  const home = resolveJerryHome();
  const paths = jerryPaths(home);
  let coreHealthy = false;
  try {
    assertJerryHomeOutsideRepositories(home);
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
    add('jerry-home', 'PASS', home);
  } catch (error) {
    add('jerry-home', 'FAIL', error instanceof Error ? error.message : String(error));
  }
  try {
    const { info, status } = await getCoreStatus(home);
    coreHealthy = true;
    add('core', 'PASS', `version ${status.version}, pid ${info.pid}, 127.0.0.1:${info.port}, ${status.taskCount} task(s), ${status.sessionCount} session(s)`);
    const knownBuilds = [buildHash(paths.runtimeCoreFile), buildHash(SIBLING_CORE)].filter((hash): hash is string => hash !== null);
    if (status.version !== JERRY_VERSION || status.build === undefined || (knownBuilds.length > 0 && !knownBuilds.includes(status.build))) {
      add('core-build', 'WARN', 'the running Core is older than the installed one: run "jerry core stop" and "jerry core start"');
    } else {
      add('core-build', 'PASS', `running build ${status.build}`);
    }
    const runtimeBuild = buildHash(paths.runtimeCoreFile);
    const siblingBuild = buildHash(SIBLING_CORE);
    if (runtimeBuild !== null && siblingBuild !== null && runtimeBuild !== siblingBuild) {
      add('core-runtime', 'WARN', 'the installed Core runtime differs from this build: run "jerry install"');
    }
    const expectedPort = resolveCorePort();
    if (expectedPort !== 0 && info.port !== expectedPort) {
      add('core-port', 'WARN', `Core listens on ${info.port} instead of ${expectedPort} (port taken by another program?); the dashboard origin depends on a stable port`);
    }
    const unauthenticated = await statusWithoutToken(info.port);
    add('api-auth', unauthenticated === 401 ? 'PASS' : 'FAIL', unauthenticated === 401 ? 'the API refuses requests without the token' : `the API answered ${unauthenticated} without a token`);
  } catch (error) {
    add('core', 'FAIL', error instanceof CoreUnavailableError ? `${error.message} (run "jerry core start")` : String(error));
  }
  if (fs.existsSync(paths.autostartDisabledFile)) {
    add('core-autostart', 'WARN', 'paused by "jerry core stop"; "jerry core start" enables it again');
  } else if (!fs.existsSync(paths.runtimeCoreFile)) {
    add('core-autostart', 'WARN', `no Core runtime at ${paths.runtimeCoreFile} (run "jerry install")`);
  } else {
    add('core-autostart', 'PASS', 'Claude Code sessions start Core when it is not running');
  }

  // --- Data ----------------------------------------------------------------------------------
  section = 'Data';
  if (coreHealthy) {
    try {
      const health = (await requestCore(readCoreRuntimeInfo(home), { method: 'GET', path: '/api/v1/database/health', timeoutMs: 15_000 })) as { integrity: string; migration: string | null; file: string };
      add('database', health.integrity === 'ok' && health.migration !== null ? 'PASS' : 'FAIL', `${health.file}, schema ${health.migration ?? 'not migrated'}, integrity ${health.integrity}`);
    } catch (error) {
      if (error instanceof CoreHttpError && error.statusCode === 404) {
        add('database', 'WARN', 'not checked: the running Core is too old to report database health (restart Core)');
      } else {
        add('database', 'FAIL', `integrity check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    add('database', 'WARN', 'not checked: Core is not running');
  }
  const usage = diskUsage(paths);
  const totalMiB = usage.total / 1024 / 1024;
  const parts = Object.entries(usage.parts)
    .map(([name, bytes]) => `${name} ${(bytes / 1024 / 1024).toFixed(1)}`)
    .join(', ');
  add('disk-usage', totalMiB > DISK_WARN_MIB ? 'WARN' : 'PASS', `${totalMiB.toFixed(1)} MiB (${parts} MiB); events older than the retention period (default 90 days) are removed automatically`);
  const spooled = countSpooled(home);
  if (spooled > 0) add('spool', coreHealthy ? 'WARN' : 'PASS', `${spooled} event(s) waiting for Core${coreHealthy ? ' (Core drains the spool every 15 s)' : ''}`);

  // --- Project -------------------------------------------------------------------------------
  section = 'Project';
  const footprint = findFootprint(process.cwd());
  add('project-footprint', footprint.length === 0 ? 'PASS' : 'FAIL', footprint.length === 0 ? `no JERRY files under ${process.cwd()}` : `found ${footprint.join(', ')}`);

  // --- Report --------------------------------------------------------------------------------
  let printed = '';
  for (const check of checks) {
    if (check.section !== printed) {
      console.log(`${printed === '' ? '' : '\n'}${check.section}`);
      printed = check.section;
    }
    console.log(`  ${check.status.padEnd(4)}  ${check.name.padEnd(18)} ${check.detail}`);
  }
  const pluginActive = pluginRoot !== null && !checks.some((check) => check.section === 'Claude Code' && check.status === 'FAIL');
  const guard = pluginActive && coreHealthy
    ? 'GUARDED (monitoring on, hard rules enforced)'
    : pluginActive
      ? 'DEGRADED (Core down: monitoring off, hard rules still enforced)'
      : 'UNGUARDED (plugin not active: nothing is monitored or enforced)';
  console.log(`\nGuard status: ${guard}`);
  if (checks.some((check) => check.status === 'FAIL')) process.exitCode = 1;
}

/** Version, plugin state, hook files, marketplace and whether the installed plugin matches this build. */
/** Files of the installed plugin: hooks, MCP server and one subagent definition per role (ADR 0022). */
const PLUGIN_FILES: readonly string[] = ['hooks/hooks.json', 'hooks/bridge.mjs', 'mcp/server.mjs', '.mcp.json', ...AGENT_ROLES.map((role) => `agents/${role.id}.md`)];

function checkClaude(claude: ClaudeBinary, add: (name: string, status: CheckStatus, detail: string) => void): string | null {
  try {
    const version = claudeVersion(claude);
    const ok = atLeast(parseVersion(version), MIN_CLAUDE_VERSION);
    add('claude-cli', ok ? 'PASS' : 'FAIL', `${version} via ${claude.source}${ok ? '' : ` (JERRY's hooks need ${MIN_CLAUDE_VERSION.join('.')}+ for onFailure)`}`);
  } catch (error) {
    add('claude-cli', 'FAIL', error instanceof Error ? error.message : String(error));
    return null;
  }

  let root: string | null = null;
  try {
    const plugin = listInstalledPlugins(claude).find((candidate) => candidate.id === PLUGIN_ID);
    if (plugin === undefined) {
      add('plugin', 'FAIL', `${PLUGIN_ID} is not installed (run "jerry install")`);
    } else if (plugin.enabled !== true) {
      add('plugin', 'FAIL', `${PLUGIN_ID} is installed but disabled`);
    } else {
      root = plugin.readFromFolder ?? plugin.installPath ?? null;
      const missing = PLUGIN_FILES.filter((file) => root === null || !fs.existsSync(path.join(root, file)));
      add('plugin', missing.length === 0 ? 'PASS' : 'FAIL', `${PLUGIN_ID} enabled (${plugin.scope ?? '?'} scope) at ${root}${missing.length === 0 ? '' : `; missing ${missing.join(', ')}`}`);
      if (missing.length > 0) root = null;
    }
  } catch (error) {
    add('plugin', 'FAIL', error instanceof Error ? error.message : String(error));
  }

  try {
    const marketplaces = JSON.parse(runClaudeOrThrow(claude, ['plugin', 'marketplace', 'list', '--json']).stdout) as Array<{ name?: string; path?: string }>;
    const marketplace = marketplaces.find((entry) => entry.name === MARKETPLACE_NAME);
    const expected = jerryPaths(resolveJerryHome()).marketplaceDir;
    if (marketplace === undefined) add('marketplace', listMarketplaceNames(claude).length === 0 ? 'FAIL' : 'FAIL', `${MARKETPLACE_NAME} is not registered (run "jerry install")`);
    else if (path.resolve(marketplace.path ?? '').toLowerCase() !== path.resolve(expected).toLowerCase()) add('marketplace', 'WARN', `${MARKETPLACE_NAME} points to ${marketplace.path}, expected ${expected}`);
    else add('marketplace', 'PASS', `${MARKETPLACE_NAME} -> ${expected}`);
  } catch (error) {
    add('marketplace', 'WARN', `could not list marketplaces: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (root !== null && fs.existsSync(SIBLING_PLUGIN)) {
    const stale = PLUGIN_FILES.filter((file) => fileHash(path.join(root!, file)) !== fileHash(path.join(SIBLING_PLUGIN, file)));
    add('plugin-build', stale.length === 0 ? 'PASS' : 'WARN', stale.length === 0 ? 'the installed plugin matches this build' : `the installed plugin differs from this build (${stale.join(', ')}): run "jerry install" and reload Claude Code`);
  }
  return root;
}

/** Settings that silently switch JERRY off: all hooks disabled, or the plugin disabled for this project. */
function checkSettings(add: (name: string, status: CheckStatus, detail: string) => void): void {
  const claudeDir = resolveClaudeConfigDir();
  const repoRoot = findRepoRoot(process.cwd());
  const files = [
    path.join(claudeDir, 'settings.json'),
    path.join(claudeDir, 'settings.local.json'),
    ...(repoRoot === null ? [] : [path.join(repoRoot, '.claude', 'settings.json'), path.join(repoRoot, '.claude', 'settings.local.json')]),
  ];
  const problems: string[] = [];
  for (const file of files) {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (settings['disableAllHooks'] === true) problems.push(`${file} sets disableAllHooks: JERRY's hooks do not run`);
    const enabled = settings['enabledPlugins'] as Record<string, unknown> | undefined;
    if (enabled?.[PLUGIN_ID] === false) problems.push(`${file} disables ${PLUGIN_ID}`);
  }
  add('settings', problems.length === 0 ? 'PASS' : 'FAIL', problems.length === 0 ? `nothing disables JERRY's hooks (${files.filter((file) => fs.existsSync(file)).length} settings file(s) checked)` : problems.join('; '));
}

function parseVersion(text: string): number[] {
  return (/(\d+)\.(\d+)\.(\d+)/.exec(text) ?? []).slice(1).map(Number);
}

function atLeast(version: number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const value = version[index] ?? 0;
    if (value !== minimum[index]) return value > minimum[index]!;
  }
  return true;
}

function findOnPath(command: string): string | null {
  const result = process.platform === 'win32' ? spawnSync('where', [command], { encoding: 'utf8', windowsHide: true }) : spawnSync('which', [command], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? null;
}

function fileHash(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** Status code of an API request sent deliberately without the token. */
function statusWithoutToken(port: number): Promise<number> {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/api/v1/status', method: 'GET', timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', () => resolve(0));
    request.on('timeout', () => request.destroy());
    request.end();
  });
}

function directorySize(target: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        // file disappeared while measuring
      }
    }
  }
  return total;
}

function diskUsage(paths: ReturnType<typeof jerryPaths>): { total: number; parts: Record<string, number> } {
  const parts = {
    database: directorySize(paths.databaseDir),
    backups: directorySize(paths.backupsDir),
    logs: directorySize(paths.logsDir),
    spool: directorySize(paths.spoolDir),
  };
  return { total: directorySize(paths.home), parts };
}

function findRepoRoot(cwd: string): string | null {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return null;
  }
}

/** Looks for JERRY artifacts at the Git root of cwd (or cwd itself). */
function findFootprint(cwd: string): string[] {
  const root = findRepoRoot(cwd) ?? path.resolve(cwd);
  return FOOTPRINT_NAMES.map((name) => path.join(root, name)).filter((candidate) => fs.existsSync(candidate));
}
