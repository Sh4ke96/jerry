import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JERRY_VERSION } from '@jerry/contracts';
import {
  applyTelemetry,
  assertJerryHomeOutsideRepositories,
  JERRY_HOME_ENTRIES,
  jerryPaths,
  resolveClaudeConfigDir,
  resolveJerryHome,
  telemetryPort,
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
import { mark } from './emoji.js';
import { disableUsage, enableUsage, reportCollectionChange, reportTelemetryEnabled } from './usage-commands.js';

const PLUGIN_PAYLOAD = fileURLToPath(new URL('../plugin/', import.meta.url));
const CORE_PAYLOAD = fileURLToPath(new URL('../core/', import.meta.url));
const CLI_PAYLOAD = fileURLToPath(new URL('../cli/', import.meta.url));
const CASES_PAYLOAD = fileURLToPath(new URL('../evals/cases/', import.meta.url));

/**
 * Runs a settings change and returns what went wrong, or null. Its failure never undoes the rest
 * of an install or uninstall: the caller tells the user and how to finish it by hand.
 */
function settingsProblem(change: () => void): string | null {
  try {
    change();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Stage then swap, so a session never loads a half-copied plugin or Core. */
function copyStagedThenSwap(source: string, target: string): void {
  // An install run by the runtime CLI itself: its payload already is the target.
  const same = (a: string): string => (process.platform === 'win32' ? path.resolve(a).toLowerCase() : path.resolve(a));
  if (same(source) === same(target)) return;
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
 * keys into settings.json. JERRY writes two things itself, a plugin cannot: the "statusLine" (the
 * user's previous one kept and chained) and its telemetry keys in "env" (never over telemetry the
 * user configured), each with a backup first. --no-usage skips both; --no-statusline only the first.
 */
export async function install(options: { statusline: boolean; usage: boolean } = { statusline: true, usage: true }): Promise<void> {
  const claude = requireClaudeBinary();
  console.log(mark('agent', `Claude Code: ${claudeVersion(claude)} (${claude.source}: ${claude.path})`));

  if (!fs.existsSync(path.join(PLUGIN_PAYLOAD, 'hooks', 'bridge.mjs')) || !fs.existsSync(path.join(CORE_PAYLOAD, 'core.mjs'))) {
    throw new Error(`Build output not found next to the CLI (${PLUGIN_PAYLOAD}, ${CORE_PAYLOAD}). Run "pnpm build" first.`);
  }

  const home = resolveJerryHome();
  assertJerryHomeOutsideRepositories(home);
  const paths = jerryPaths(home);
  const pluginDir = path.join(paths.marketplaceDir, 'plugins', PLUGIN_NAME);

  copyStagedThenSwap(PLUGIN_PAYLOAD, pluginDir);
  // The runtime copy of Core is what the hooks start automatically (work goes on without Core,
  // but monitoring needs it running).
  copyStagedThenSwap(CORE_PAYLOAD, path.dirname(paths.runtimeCoreFile));
  // The runtime mirrors dist: "Run evals" in the dashboard starts the CLI next to Core, and that CLI
  // finds the Core bundle, the plugin under test and the bundled cases next to itself.
  copyStagedThenSwap(CLI_PAYLOAD, path.join(paths.runtimeDir, 'cli'));
  copyStagedThenSwap(PLUGIN_PAYLOAD, path.join(paths.runtimeDir, 'plugin'));
  const hasCases = fs.existsSync(CASES_PAYLOAD);
  if (hasCases) copyStagedThenSwap(CASES_PAYLOAD, path.join(paths.runtimeDir, 'evals', 'cases'));

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
    console.log(mark('pass', `Registered marketplace ${MARKETPLACE_NAME} -> ${paths.marketplaceDir}`));
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
  console.log(mark('pass', `Installed ${PLUGIN_ID} (user scope), loaded from ${installed.readFromFolder ?? installed.installPath ?? pluginDir}.`));
  console.log(mark('pass', `Installed JERRY Core runtime at ${paths.runtimeCoreFile}; Claude Code sessions start it automatically.`));
  console.log(mark('pass', `Installed the CLI and plugin next to it${hasCases ? ' with the eval cases' : ''}, so the dashboard can run evals.`));

  // Installing is the user's explicit action; Claude usage collection is part of it, and easy to turn off.
  const locations = { home, claudeConfigDir: resolveClaudeConfigDir() };
  if (options.usage && options.statusline) {
    if (reportCollectionChange(enableUsage(locations), true)) {
      console.log(mark('info', 'Turn Claude usage collection off with "jerry usage disable" (or install with --no-usage).'));
    }
  } else if (options.usage) {
    // --no-statusline: telemetry only; the status line stays as it is.
    const problem = settingsProblem(() => reportTelemetryEnabled(applyTelemetry({ ...locations, port: telemetryPort(home) })));
    if (problem !== null) console.log(mark('warning', `Claude Code telemetry was not changed: ${problem} Once fixed, run "jerry usage enable".`));
    console.log(mark('info', "Left Claude Code's status line as it is (--no-statusline). Turn JERRY's on with: jerry statusline enable"));
  } else {
    console.log(mark('info', "Left Claude Code's status line and telemetry as they are (--no-usage). Turn usage collection on with: jerry usage enable"));
  }

  try {
    const { status } = await getCoreStatus(home);
    if (status.version !== JERRY_VERSION) {
      console.log(mark('warning', `A JERRY Core ${status.version} is still running; restart it to use ${JERRY_VERSION}: jerry core stop, then jerry core start.`));
    }
  } catch {
    // Core not running: the next session starts the new runtime.
  }
  console.log(mark('next', 'Restart Claude Code sessions (or run /reload-plugins) so they pick up the plugin. Then run "jerry doctor".'));
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
  // Before the runtime (and with --purge-data the saved previous status line and telemetry keys) is deleted.
  reportCollectionChange(disableUsage({ home, claudeConfigDir: resolveClaudeConfigDir() }), false);
  await stopCore('jerry uninstall');
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
      console.log(mark('pass', `Deleted JERRY data directory ${home}.`));
    } else {
      console.log(mark('warning', `Deleted JERRY data in ${home}; left ${leftovers.length} entr${leftovers.length === 1 ? 'y' : 'ies'} JERRY did not create: ${leftovers.join(', ')}`));
    }
  } else {
    console.log(mark('info', `Kept JERRY data (state, logs) in ${home}. Use --purge-data to delete it.`));
  }
}

function reportIdempotent(result: { exitCode: number; stdout: string; stderr: string }, absentCode: string, done: string, absent: string): void {
  if (result.exitCode === 0) {
    console.log(mark('pass', done));
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
    console.log(mark('info', absent));
    return;
  }
  throw new Error(`Claude Code CLI failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
}
