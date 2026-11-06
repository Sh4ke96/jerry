import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JERRY_VERSION } from '@jerry/contracts';
import {
  assertJerryHomeOutsideRepositories,
  JERRY_HOME_ENTRIES,
  jerryPaths,
  resolveClaudeConfigDir,
  resolveJerryHome,
  writeFileAtomic,
} from '@jerry/platform';
import {
  claudeVersion,
  listInstalledPlugins,
  listMarketplaceNames,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  PLUGIN_NAME,
  requireClaudeBinary,
  runClaude,
  runClaudeOrThrow,
} from './claude-cli.js';
import { getCoreStatus, stopCore } from './core-commands.js';

const PLUGIN_PAYLOAD = fileURLToPath(new URL('../plugin/', import.meta.url));
const CORE_PAYLOAD = fileURLToPath(new URL('../core/', import.meta.url));

/** Stage then swap, so a session never loads a half-copied plugin or Core. */
function copyStagedThenSwap(source: string, target: string): void {
  const staging = `${target}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, staging, { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
}

/**
 * Global, user-scope install. Copies the plugin payload into JERRY_HOME, publishes it through a
 * local marketplace and registers both via the official Claude Code CLI, which merges its own
 * keys into settings.json. JERRY never edits Claude settings files directly.
 */
export async function install(): Promise<void> {
  const claude = requireClaudeBinary();
  console.log(`Claude Code: ${claudeVersion(claude)} (${claude.source}: ${claude.path})`);

  if (!fs.existsSync(path.join(PLUGIN_PAYLOAD, 'hooks', 'bridge.mjs')) || !fs.existsSync(path.join(CORE_PAYLOAD, 'core.mjs'))) {
    throw new Error(`Build output not found next to the CLI (${PLUGIN_PAYLOAD}, ${CORE_PAYLOAD}). Run "pnpm build" first.`);
  }

  const home = resolveJerryHome();
  assertJerryHomeOutsideRepositories(home);
  const paths = jerryPaths(home);
  const pluginDir = path.join(paths.marketplaceDir, 'plugins', PLUGIN_NAME);

  copyStagedThenSwap(PLUGIN_PAYLOAD, pluginDir);
  // The runtime copy of Core is what the hooks start automatically (ADR 0003 keeps work going
  // without Core, but monitoring needs it running).
  copyStagedThenSwap(CORE_PAYLOAD, path.dirname(paths.runtimeCoreFile));

  writeFileAtomic(
    path.join(paths.marketplaceDir, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify(
      {
        name: MARKETPLACE_NAME,
        description: 'Local marketplace that serves the JERRY plugin from JERRY_HOME.',
        owner: { name: 'JERRY (local)' },
        plugins: [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}`, description: 'JERRY Development Guardian' }],
      },
      null,
      2,
    )}\n`,
  );

  if (!listMarketplaceNames(claude).includes(MARKETPLACE_NAME)) {
    runClaudeOrThrow(claude, ['plugin', 'marketplace', 'add', paths.marketplaceDir, '--scope', 'user', '--json']);
    console.log(`Registered marketplace ${MARKETPLACE_NAME} -> ${paths.marketplaceDir}`);
  }
  runClaudeOrThrow(claude, ['plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json']);

  const installed = listInstalledPlugins(claude).find((plugin) => plugin.id === PLUGIN_ID);
  if (installed === undefined || installed.enabled !== true || installed.scope !== 'user') {
    throw new Error(`Install reported success but ${PLUGIN_ID} is not enabled in user scope: ${JSON.stringify(installed)}`);
  }

  writeFileAtomic(
    paths.installManifestFile,
    `${JSON.stringify(
      {
        jerryVersion: JERRY_VERSION,
        installedAt: new Date().toISOString(),
        claudeConfigDir: resolveClaudeConfigDir(),
        claudeBinary: claude.path,
        marketplaceName: MARKETPLACE_NAME,
        marketplaceDir: paths.marketplaceDir,
        pluginId: PLUGIN_ID,
        pluginDir,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Installed ${PLUGIN_ID} (user scope), loaded from ${installed.readFromFolder ?? installed.installPath ?? pluginDir}.`);
  console.log(`Installed JERRY Core runtime at ${paths.runtimeCoreFile}; Claude Code sessions start it automatically.`);

  try {
    const { status } = await getCoreStatus(home);
    if (status.version !== JERRY_VERSION) {
      console.log(`A JERRY Core ${status.version} is still running; restart it to use ${JERRY_VERSION}: jerry core stop, then jerry core start.`);
    }
  } catch {
    // Core not running: the next session starts the new runtime.
  }
  console.log('Restart Claude Code sessions (or run /reload-plugins) so they pick up the plugin. Then run "jerry doctor".');
}

/**
 * Removes only what JERRY added: its plugin, its marketplace, its plugin payload and Core runtime,
 * and stops Core. JERRY data (state, logs) is kept unless purgeData is set. Never touches project
 * repositories.
 */
export async function uninstall(options: { purgeData: boolean }): Promise<void> {
  const claude = requireClaudeBinary();
  const home = resolveJerryHome();
  const paths = jerryPaths(home);

  const uninstallResult = runClaude(claude, ['plugin', 'uninstall', PLUGIN_ID, '--scope', 'user', '--json']);
  reportIdempotent(uninstallResult, 'not_installed', `Uninstalled ${PLUGIN_ID}`, `${PLUGIN_ID} was not installed`);

  const removeResult = runClaude(claude, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']);
  reportIdempotent(removeResult, 'not_configured', `Removed marketplace ${MARKETPLACE_NAME}`, `Marketplace ${MARKETPLACE_NAME} was not configured`);

  assertJerryHomeOutsideRepositories(home);
  await stopCore();
  fs.rmSync(paths.marketplaceDir, { recursive: true, force: true });
  fs.rmSync(paths.runtimeDir, { recursive: true, force: true });
  fs.rmSync(paths.installManifestFile, { force: true });

  if (options.purgeData) {
    // Delete only what JERRY created, never the whole directory tree: a misconfigured
    // JERRY_HOME (e.g. "D:\") must not take anything else with it.
    for (const entry of JERRY_HOME_ENTRIES) {
      fs.rmSync(path.join(home, entry), { recursive: true, force: true });
    }
    const leftovers = fs.existsSync(home) ? fs.readdirSync(home) : [];
    if (leftovers.length === 0) {
      fs.rmSync(home, { recursive: true, force: true });
      console.log(`Deleted JERRY data directory ${home}.`);
    } else {
      console.log(`Deleted JERRY data in ${home}; left ${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'} JERRY did not create: ${leftovers.join(', ')}`);
    }
  } else {
    console.log(`Kept JERRY data (state, logs) in ${home}. Use --purge-data to delete it.`);
  }
}

function reportIdempotent(result: { exitCode: number; stdout: string; stderr: string }, absentCode: string, done: string, absent: string): void {
  if (result.exitCode === 0) {
    console.log(done);
    return;
  }
  const firstLine = result.stdout.split(/\r?\n/)[0] ?? '';
  let failureCode: unknown;
  try {
    failureCode = (JSON.parse(firstLine) as { failureCode?: unknown }).failureCode;
  } catch {
    failureCode = undefined;
  }
  if (failureCode === absentCode) {
    console.log(absent);
    return;
  }
  throw new Error(`Claude Code CLI failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
}
