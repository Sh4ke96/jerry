import os from 'node:os';
import path from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * JERRY data directory. Never inside a project repository.
 * Windows default: %LOCALAPPDATA%\JERRY. Overridable with JERRY_HOME.
 */
export function resolveJerryHome(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env['JERRY_HOME'];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData === undefined || localAppData.trim() === '') {
      throw new Error('Cannot resolve JERRY_HOME: LOCALAPPDATA is not set. Set JERRY_HOME explicitly.');
    }
    return path.join(localAppData, 'JERRY');
  }
  return path.join(os.homedir(), '.local', 'share', 'jerry');
}

export interface JerryPaths {
  home: string;
  runDir: string;
  coreInfoFile: string;
  coreLockFile: string;
  autostartStampFile: string;
  /** Present after "jerry core stop": hooks must not restart Core against the user's wish. */
  autostartDisabledFile: string;
  /** Installed copy of Core that the hooks may start automatically. */
  runtimeDir: string;
  runtimeCoreFile: string;
  stateDir: string;
  stateFile: string;
  databaseDir: string;
  databaseFile: string;
  backupsDir: string;
  /** Events written by hooks while Core was unreachable; drained by Core. */
  spoolDir: string;
  logsDir: string;
  /** Gate log from before the database existed; imported into the database once, then renamed. */
  gateLogFile: string;
  coreLogFile: string;
  configDir: string;
  installManifestFile: string;
  marketplaceDir: string;
}

export function jerryPaths(home: string): JerryPaths {
  const runDir = path.join(home, 'run');
  const stateDir = path.join(home, 'state');
  const logsDir = path.join(home, 'logs');
  const configDir = path.join(home, 'config');
  const runtimeDir = path.join(home, 'runtime');
  return {
    home,
    runDir,
    coreInfoFile: path.join(runDir, 'core.json'),
    coreLockFile: path.join(runDir, 'core.lock'),
    autostartStampFile: path.join(runDir, 'autostart.stamp'),
    autostartDisabledFile: path.join(runDir, 'autostart.disabled'),
    runtimeDir,
    runtimeCoreFile: path.join(runtimeDir, 'core', 'core.mjs'),
    stateDir,
    stateFile: path.join(stateDir, 'core-state.json'),
    databaseDir: path.join(home, 'database'),
    databaseFile: path.join(home, 'database', 'jerry.sqlite'),
    backupsDir: path.join(home, 'backups'),
    spoolDir: path.join(home, 'spool'),
    logsDir,
    gateLogFile: path.join(logsDir, 'gate-decisions.jsonl'),
    coreLogFile: path.join(logsDir, 'core.log'),
    configDir,
    installManifestFile: path.join(configDir, 'install-manifest.json'),
    marketplaceDir: path.join(home, 'marketplace'),
  };
}

/** Claude Code user config dir (~/.claude), honouring CLAUDE_CONFIG_DIR. */
export function resolveClaudeConfigDir(env: Env = process.env): string {
  const override = env['CLAUDE_CONFIG_DIR'];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.claude');
}

/**
 * Paths an agent must never write to: JERRY's own data (state, token, approvals)
 * and the Claude Code settings/plugins that keep the JERRY guard enabled.
 */
export function protectedRoots(env: Env = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const claudeDir = resolveClaudeConfigDir(env);
  return [
    resolveJerryHome(env, platform),
    path.join(claudeDir, 'settings.json'),
    path.join(claudeDir, 'settings.local.json'),
    path.join(claudeDir, 'plugins'),
  ];
}
