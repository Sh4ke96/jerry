import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { JERRY_VERSION, type CoreRuntimeInfo } from '@jerry/contracts';
import type { FastifyInstance } from 'fastify';
import {
  acquireSingleInstanceLock,
  assertJerryHomeOutsideRepositories,
  jerryPaths,
  protectedRoots,
  resolveCorePort,
  resolveJerryHome,
  writeFileAtomic,
} from '@jerry/platform';
import { buildCoreApp, gateEvaluator } from './app.js';
import { BrowserSessions } from './auth.js';
import { drainSpool, importLegacyGateLog } from './events.js';
import { StateStore } from './state-store.js';

const SPOOL_DRAIN_INTERVAL_MS = 15_000;
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

/** Spec §18.2: events and sessions are kept 90 days unless JERRY_RETENTION_DAYS says otherwise. */
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
    process.stdout.write(`JERRY Core is already running for ${home} (pid ${lock.heldBy}); exiting.\n`);
    return;
  }
  const releaseLock = lock.release;

  let store: StateStore;
  try {
    store = await StateStore.open({ databaseFile: paths.databaseFile, backupsDir: paths.backupsDir, legacyStateFile: paths.stateFile });
  } catch (error) {
    releaseLock();
    throw error;
  }
  const token = randomBytes(32).toString('hex');
  const startedAt = new Date();
  const configuredPort = resolveCorePort();

  const guardedRoots = protectedRoots();
  let boundPort = configuredPort;
  const sessions = new BrowserSessions();
  const createApp = (): FastifyInstance =>
    buildCoreApp({
      token,
      store,
      jerryHome: home,
      protectedRoots: guardedRoots,
      startedAt,
      port: () => boundPort,
      sessions,
      onShutdownRequested: () => shutdown('shutdown requested via API'),
    });
  let app = createApp();

  // Background upkeep: events spooled while Core was down, the pre-database gate log, retention.
  const evaluate = gateEvaluator(store, guardedRoots);
  const retentionDays = resolveRetentionDays();
  const upkeep = async (): Promise<void> => {
    try {
      const imported = await importLegacyGateLog(paths.gateLogFile, store, new Date());
      if (imported > 0) process.stdout.write(`Imported ${imported} gate decisions from ${paths.gateLogFile}\n`);
      while ((await drainSpool(home, store, evaluate)) > 0) {
        // keep draining in batches until the spool is empty
      }
      const removed = await store.applyRetention(new Date(), retentionDays);
      if (removed.events + removed.sessions > 0) {
        process.stdout.write(`Retention (${retentionDays} days): removed ${removed.events} events and ${removed.sessions} sessions\n`);
      }
    } catch (error) {
      process.stderr.write(`Upkeep failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  let upkeepRunning: Promise<void> = upkeep();
  const spoolTimer = setInterval(() => {
    upkeepRunning = upkeepRunning.then(() => drainSpool(home, store, evaluate).then(() => undefined, (error: unknown) => {
      process.stderr.write(`Spool drain failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
    process.stdout.write(`Port ${configuredPort} is in use by another program; falling back to a random port.\n`);
    await app.close();
    app = createApp();
    port = await listen(app, 0);
  }
  boundPort = port;

  const info: CoreRuntimeInfo = {
    pid: process.pid,
    port,
    configuredPort,
    token,
    startedAt: startedAt.toISOString(),
    version: JERRY_VERSION,
  };
  writeFileAtomic(paths.coreInfoFile, `${JSON.stringify(info, null, 2)}\n`);
  process.stdout.write(`JERRY Core ${JERRY_VERSION} listening on 127.0.0.1:${port} (pid ${process.pid}, home ${home})\n`);

  let stopping = false;
  function cleanUp(): void {
    removeRuntimeInfoIfOwned(paths.coreInfoFile);
    releaseLock();
  }
  function shutdown(reason: string): void {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`JERRY Core stopping: ${reason}\n`);
    cleanUp();
    app
      .close()
      .then(() => store.close())
      .catch((error: unknown) => process.stderr.write(`Closing Core failed: ${String(error)}\n`))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', cleanUp);
}

/** Loopback only, never 0.0.0.0 (spec §18.1). */
async function listen(app: FastifyInstance, port: number): Promise<number> {
  await app.listen({ host: '127.0.0.1', port });
  const address = app.server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Core server did not bind to a TCP port');
  return address.port;
}

/** Only the owning process removes core.json, so a second Core never deletes the first one's file. */
function removeRuntimeInfoIfOwned(coreInfoFile: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(coreInfoFile, 'utf8')) as { pid?: unknown };
    if (current.pid === process.pid) fs.rmSync(coreInfoFile, { force: true });
  } catch {
    // already gone or unreadable: nothing of ours to remove
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`JERRY Core failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
