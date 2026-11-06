import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import { JERRY_VERSION, type CoreRuntimeInfo } from '@jerry/contracts';
import {
  acquireSingleInstanceLock,
  assertJerryHomeOutsideRepositories,
  jerryPaths,
  protectedRoots,
  resolveCorePort,
  resolveJerryHome,
  writeFileAtomic,
} from '@jerry/platform';
import { createCoreServer } from './server.js';
import { StateStore } from './state-store.js';

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

  const server = createCoreServer({
    token,
    store,
    jerryHome: home,
    gateLogFile: paths.gateLogFile,
    protectedRoots: protectedRoots(),
    startedAt,
    onShutdownRequested: () => shutdown('shutdown requested via API'),
  });

  let port: number;
  try {
    port = await listen(server, configuredPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || configuredPort === 0) throw error;
    // Another program holds the port: keep guarding on a random port; doctor reports the fallback.
    process.stdout.write(`Port ${configuredPort} is in use by another program; falling back to a random port.\n`);
    port = await listen(server, 0);
  }

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
    server.close(() => {
      store
        .close()
        .catch((error: unknown) => process.stderr.write(`Closing the database failed: ${String(error)}\n`))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', cleanUp);
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('Core server did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
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
