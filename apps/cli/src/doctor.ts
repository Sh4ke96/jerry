import fs from 'node:fs';
import path from 'node:path';
import {
  assertJerryHomeOutsideRepositories,
  CoreUnavailableError,
  countSpooled,
  findClaudeBinary,
  jerryPaths,
  resolveCorePort,
  resolveJerryHome,
} from '@jerry/platform';
import { claudeVersion, listInstalledPlugins, PLUGIN_ID } from './claude-cli.js';
import { getCoreStatus } from './core-commands.js';

type CheckStatus = 'PASS' | 'WARN' | 'FAIL';
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Names JERRY must never create inside a project. */
const FOOTPRINT_NAMES = ['.jerry', '.harness', '.jerry.json', 'jerry.config.json'];

export async function doctor(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 22 ? 'PASS' : 'FAIL', `Node ${process.versions.node} (${process.execPath})`);

  const home = resolveJerryHome();
  try {
    assertJerryHomeOutsideRepositories(home);
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
    add('jerry-home', 'PASS', home);
  } catch (error) {
    add('jerry-home', 'FAIL', error instanceof Error ? error.message : String(error));
  }

  let pluginActive = false;
  const claude = findClaudeBinary();
  if (claude === null) {
    add('claude-cli', 'FAIL', 'Claude Code CLI not found');
  } else {
    try {
      add('claude-cli', 'PASS', `${claudeVersion(claude)} via ${claude.source}`);
      const plugin = listInstalledPlugins(claude).find((candidate) => candidate.id === PLUGIN_ID);
      if (plugin === undefined) {
        add('plugin', 'FAIL', `${PLUGIN_ID} is not installed (run "jerry install")`);
      } else if (plugin.enabled !== true) {
        add('plugin', 'FAIL', `${PLUGIN_ID} is installed but disabled`);
      } else {
        const root = plugin.readFromFolder ?? plugin.installPath ?? '';
        const hooksPresent = fs.existsSync(path.join(root, 'hooks', 'hooks.json')) && fs.existsSync(path.join(root, 'hooks', 'bridge.mjs'));
        pluginActive = hooksPresent;
        add('plugin', hooksPresent ? 'PASS' : 'FAIL', `${PLUGIN_ID} enabled (${plugin.scope ?? '?'} scope) at ${root}${hooksPresent ? '' : ' — hooks or bridge missing'}`);
      }
    } catch (error) {
      add('claude-cli', 'FAIL', error instanceof Error ? error.message : String(error));
    }
  }

  let coreHealthy = false;
  try {
    const { info, status } = await getCoreStatus(home);
    coreHealthy = true;
    add('core', 'PASS', `JERRY Core ${status.version} pid ${info.pid} on 127.0.0.1:${info.port}, ${status.taskCount} task(s)`);
    add('database', status.database.migration === null ? 'FAIL' : 'PASS', `${status.database.file} (schema ${status.database.migration ?? 'not migrated'})`);
    const expectedPort = resolveCorePort();
    if (expectedPort !== 0 && info.port !== expectedPort) {
      add('core-port', 'WARN', `Core runs on port ${info.port} instead of ${expectedPort} (port in use by another program, or Core started before this setting); the dashboard origin depends on a stable port`);
    }
  } catch (error) {
    add('core', 'FAIL', error instanceof CoreUnavailableError ? `${error.message} (run "jerry core start")` : String(error));
  }

  const paths = jerryPaths(home);
  if (fs.existsSync(paths.autostartDisabledFile)) {
    add('core-autostart', 'WARN', 'disabled by "jerry core stop"; run "jerry core start" to enable it again');
  } else if (!fs.existsSync(paths.runtimeCoreFile)) {
    add('core-autostart', 'WARN', `no Core runtime at ${paths.runtimeCoreFile} (run "jerry install")`);
  } else {
    add('core-autostart', 'PASS', `sessions start Core from ${paths.runtimeCoreFile} when it is not running`);
  }

  const usage = diskUsage(paths);
  const totalMiB = usage.total / 1024 / 1024;
  const parts = Object.entries(usage.parts)
    .map(([name, bytes]) => `${name} ${(bytes / 1024 / 1024).toFixed(1)}`)
    .join(', ');
  add('disk-usage', totalMiB > DISK_WARN_MIB ? 'WARN' : 'PASS', `${totalMiB.toFixed(1)} MiB in ${home} (${parts} MiB); events older than the retention period (default 90 days) are removed automatically`);
  const spooled = countSpooled(home);
  if (spooled > 0) {
    add('spool', coreHealthy ? 'WARN' : 'PASS', `${spooled} event(s) waiting for Core${coreHealthy ? ' (Core drains the spool every 15 s)' : ''}`);
  }

  const footprint = findFootprint(process.cwd());
  add('project-footprint', footprint.length === 0 ? 'PASS' : 'FAIL', footprint.length === 0 ? `no JERRY files under ${process.cwd()}` : `found ${footprint.join(', ')}`);

  if (!fs.existsSync(paths.installManifestFile)) {
    add('install-manifest', 'WARN', 'no install manifest (plugin may have been loaded with --plugin-dir)');
  }

  for (const check of checks) {
    console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(18)} ${check.detail}`);
  }
  const guard = pluginActive && coreHealthy
    ? 'GUARDED (monitoring on, hard rules enforced)'
    : pluginActive
      ? 'DEGRADED (Core down: monitoring off, hard rules still enforced)'
      : 'UNGUARDED (plugin not active: nothing is monitored or enforced)';
  console.log(`\nGuard status: ${guard}`);
  if (checks.some((check) => check.status === 'FAIL')) process.exitCode = 1;
}

const DISK_WARN_MIB = 1024;

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

/** Looks for JERRY artifacts at the Git root of cwd (or cwd itself). */
function findFootprint(cwd: string): string[] {
  let root = path.resolve(cwd);
  for (let current = root; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      root = current;
      break;
    }
    if (path.dirname(current) === current) break;
  }
  return FOOTPRINT_NAMES.map((name) => path.join(root, name)).filter((candidate) => fs.existsSync(candidate));
}
