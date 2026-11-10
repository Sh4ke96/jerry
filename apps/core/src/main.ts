import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JERRY_VERSION, type CoreRuntimeInfo, type CoreShutdownRequest, type CoreUserInfo } from '@jerry/contracts';
import type { FastifyInstance } from 'fastify';
import {
  acquireSingleInstanceLock,
  assertJerryHomeOutsideRepositories,
  buildHash,
  describeUncleanEnd,
  jerryPaths,
  protectedRoots,
  readCoreHeartbeat,
  resolveCorePort,
  resolveJerryHome,
  writeFileAtomic,
} from '@jerry/platform';
import { protectedReadRoots } from '@jerry/policy-engine';
import { buildCoreApp, gateEvaluator } from './app.js';
import { BrowserSessions } from './auth.js';
import { describeError, log, logError } from './core-log.js';
import { drainSpool, importLegacyGateLog } from './events.js';
import { StateStore } from './state-store.js';
import { QualityScheduler } from './quality-scheduler.js';
import { drainUsageSpool, UsageStore } from './usage-store.js';

const SPOOL_DRAIN_INTERVAL_MS = 15_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
/** How often Core refreshes its heartbeat (run/core-alive.json). */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** The stop line for an API shutdown: who asked and why, as the client said. */
function shutdownReason(request: CoreShutdownRequest): string {
  const by = request.requestedBy === undefined ? ' (requester not given)' : ` by ${request.requestedBy}`;
  const why = request.reason === undefined || request.reason === '' ? '' : `: ${request.reason}`;
  return `shutdown requested via API${by}${why}`;
}

/** Events and sessions are kept 90 days unless JERRY_RETENTION_DAYS says otherwise. */
function resolveRetentionDays(): number {
  const raw = process.env['JERRY_RETENTION_DAYS'];
  const days = raw === undefined || raw.trim() === '' ? DEFAULT_RETENTION_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1) throw new Error(`JERRY_RETENTION_DAYS must be a positive integer, got "${raw}"`);
  return days;
}

async function main(): Promise<void> {
  const home = resolveJerryHome();
  assertJerryHomeOutsideRepositories(home);
  const paths = jerryPaths(home);
  for (const dir of [paths.runDir, paths.stateDir, paths.logsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // One Core per JERRY_HOME. A concurrent start (two sessions at once) exits quietly.
  const lock = acquireSingleInstanceLock(paths.coreLockFile);
  if (!lock.acquired) {
    log(`JERRY Core is already running for ${home} (pid ${lock.heldBy}); exiting.`);
    return;
  }
  const releaseLock = lock.release;
  // A heartbeat left behind means the previous Core never stopped cleanly; say so before replacing it.
  const uncleanEnd = describeUncleanEnd(readCoreHeartbeat(paths.coreAliveFile), process.pid);
  if (uncleanEnd !== null) log(uncleanEnd);

  let store: StateStore;
  try {
    store = await StateStore.open({ databaseFile: paths.databaseFile, backupsDir: paths.backupsDir, legacyStateFile: paths.stateFile, projectsFile: paths.projectsFile });
  } catch (error) {
    releaseLock();
    throw error;
  }
  // Two credentials, new at every start. The agent token goes to core.json (hooks, MCP server, status
  // line); the user's token to core-user.json (jerry CLI, desktop app). Only the user's token, or a
  // dashboard session, makes user decisions, mints login codes and stops Core.
  const agentToken = randomBytes(32).toString('hex');
  const userToken = randomBytes(32).toString('hex');
  const startedAt = new Date();
  const configuredPort = resolveCorePort();

  const guardedRoots = protectedRoots();
  const build = buildHash(fileURLToPath(import.meta.url));
  let boundPort = configuredPort;
  const sessions = new BrowserSessions();
  // The quiet period before quality checks; tests shorten it.
  const debounce = Number(process.env['JERRY_QUALITY_DEBOUNCE_MS']);
  const quality = new QualityScheduler({ store, git: store.gitReader, ...(Number.isInteger(debounce) && debounce >= 0 && debounce <= 60_000 ? { debounceMs: debounce } : {}) });
  const retentionDays = resolveRetentionDays();
  const usage = new UsageStore(store, startedAt);
  const createApp = (): FastifyInstance =>
    buildCoreApp({
      quality,
      retentionDays,
      usage,
      // Claude Code's telemetry goes to the configured port; with any free port (0), to the one bound.
      telemetryPort: () => (configuredPort === 0 ? boundPort : configuredPort),
      token: userToken,
      agentToken,
      store,
      jerryHome: home,
      protectedRoots: guardedRoots,
      startedAt,
      port: () => boundPort,
      sessions,
      dashboardDir: fileURLToPath(new URL('./dashboard/', import.meta.url)),
      ...(build === null ? {} : { build }),
      onShutdownRequested: (request) => shutdown(shutdownReason(request)),
    });
  let app = createApp();

  // Background upkeep: events spooled while Core was down, the pre-database gate log, retention.
  const evaluate = gateEvaluator(store, guardedRoots, undefined, undefined, undefined, protectedReadRoots(home));
  const upkeep = async (): Promise<void> => {
    try {
      const imported = await importLegacyGateLog(paths.gateLogFile, store, new Date());
      if (imported > 0) log(`Imported ${imported} gate decisions from ${paths.gateLogFile}`);
      while ((await drainSpool(home, store, evaluate)) > 0) {
        // keep draining in batches until the spool is empty
      }
      await drainUsageSpool(home, usage);
      const removed = await store.applyRetention(new Date(), retentionDays);
      if (removed.events + removed.sessions + removed.usage > 0) {
        log(`Retention (${retentionDays} days): removed ${removed.events} events, ${removed.sessions} sessions and ${removed.usage} usage rows`);
      }
    } catch (error) {
      logError(`Upkeep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let upkeepRunning: Promise<void> = upkeep();
  const spoolTimer = setInterval(() => {
    upkeepRunning = upkeepRunning.then(() => drainSpool(home, store, evaluate).then(() => drainUsageSpool(home, usage)).then(() => undefined, (error: unknown) => {
      logError(`Spool drain failed: ${error instanceof Error ? error.message : String(error)}`);
    }));
  }, SPOOL_DRAIN_INTERVAL_MS);
  const retentionTimer = setInterval(() => {
    upkeepRunning = upkeepRunning.then(upkeep);
  }, RETENTION_INTERVAL_MS);
  spoolTimer.unref();
  retentionTimer.unref();

  let port: number;
  try {
    port = await listen(app, configuredPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || configuredPort === 0) throw error;
    // Another program holds the port: keep guarding on a random port; doctor reports the fallback.
    log(`Port ${configuredPort} is in use by another program; falling back to a random port.`);
    await app.close();
    app = createApp();
    port = await listen(app, 0);
  }
  boundPort = port;

  const info: CoreRuntimeInfo = {
    pid: process.pid,
    port,
    configuredPort,
    token: agentToken,
    startedAt: startedAt.toISOString(),
    version: JERRY_VERSION,
  };
  writeFileAtomic(paths.coreInfoFile, `${JSON.stringify(info, null, 2)}\n`);
  const userInfo: CoreUserInfo = { pid: process.pid, token: userToken };
  writeFileAtomic(paths.coreUserFile, `${JSON.stringify(userInfo, null, 2)}\n`);
  log(`JERRY Core ${JERRY_VERSION} listening on 127.0.0.1:${port} (pid ${process.pid}, home ${home})`);

  // The heartbeat: a clean stop removes it, so one found at the next start marks an unclean end.
  const heartbeat = (): void => {
    try {
      writeFileAtomic(paths.coreAliveFile, `${JSON.stringify({ pid: process.pid, version: JERRY_VERSION, startedAt: startedAt.toISOString(), aliveAt: new Date().toISOString() })}\n`);
    } catch (error) {
      logError(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS).unref();

  let stopping = false;
  let cleanedUp = false;
  function cleanUp(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    removeRuntimeInfoIfOwned(paths.coreInfoFile);
    removeRuntimeInfoIfOwned(paths.coreUserFile);
    removeHeartbeatIfOwned(paths.coreAliveFile);
    releaseLock();
  }
  function shutdown(reason: string): void {
    if (stopping) return;
    stopping = true;
    log(`JERRY Core stopping: ${reason}`);
    cleanUp();
    app
      .close()
      .then(() => store.close())
      .catch((error: unknown) => logError(`Closing Core failed: ${describeError(error)}`))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows: SIGHUP when the console or session that owns Core closes, SIGBREAK on Ctrl+Break.
  process.on('SIGHUP', () => shutdown('SIGHUP (the console or session that owns Core closed)'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  // A crash stays a crash, but now it is in the log with its stack, and the lock is released.
  process.on('uncaughtException', (error) => {
    logError(`JERRY Core crashed: uncaught exception: ${describeError(error)}`);
    cleanUp();
    process.exit(1);
  });
  // A rejected promise nobody handled is a bug in one request or job, not in the guard: logged, Core keeps running.
  process.on('unhandledRejection', (reason) => {
    logError(`Unhandled promise rejection (Core keeps running): ${describeError(reason)}`);
  });
  process.on('exit', (code) => {
    cleanUp();
    log(`JERRY Core exited with code ${code}`);
  });
}

/** Only the owning process removes its heartbeat; a heartbeat of another pid is evidence about that Core. */
function removeHeartbeatIfOwned(coreAliveFile: string): void {
  if (readCoreHeartbeat(coreAliveFile)?.pid === process.pid) fs.rmSync(coreAliveFile, { force: true });
}

/** Loopback only, never 0.0.0.0. */
async function listen(app: FastifyInstance, port: number): Promise<number> {
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Core server did not bind to a TCP port');
  return address.port;
}

/**
 * Only the owning process removes core.json and core-user.json, so a second Core never deletes the
 * first one's files.
 */
function removeRuntimeInfoIfOwned(coreInfoFile: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(coreInfoFile, 'utf8')) as { pid?: unknown };
    if (current.pid === process.pid) fs.rmSync(coreInfoFile, { force: true });
  } catch {
    // already gone or unreadable: nothing of ours to remove
  }
}

main().catch((error: unknown) => {
  logError(`JERRY Core failed to start: ${describeError(error)}`);
  process.exit(1);
});
