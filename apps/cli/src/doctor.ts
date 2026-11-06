import fs from 'node:fs';
import path from 'node:path';
import { CoreUnavailableError, findClaudeBinary, jerryPaths, resolveJerryHome } from '@jerry/platform';
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
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
    add('jerry-home', 'PASS', home);
  } catch (error) {
    add('jerry-home', 'FAIL', `${home} is not writable: ${error instanceof Error ? error.message : String(error)}`);
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
  } catch (error) {
    add('core', 'FAIL', error instanceof CoreUnavailableError ? `${error.message} (run "jerry core start")` : String(error));
  }

  const footprint = findFootprint(process.cwd());
  add('project-footprint', footprint.length === 0 ? 'PASS' : 'FAIL', footprint.length === 0 ? `no JERRY files under ${process.cwd()}` : `found ${footprint.join(', ')}`);

  if (!fs.existsSync(jerryPaths(home).installManifestFile)) {
    add('install-manifest', 'WARN', 'no install manifest (plugin may have been loaded with --plugin-dir)');
  }

  for (const check of checks) {
    console.log(`${check.status.padEnd(4)}  ${check.name.padEnd(18)} ${check.detail}`);
  }
  const guard = pluginActive && coreHealthy ? 'GUARDED' : pluginActive ? 'DEGRADED (writes blocked: Core down)' : 'UNGUARDED';
  console.log(`\nGuard status: ${guard}`);
  if (checks.some((check) => check.status === 'FAIL')) process.exitCode = 1;
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
