import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { JERRY_VERSION, type CoreRuntimeInfo } from '@jerry/contracts';
import {
  assertJerryHomeOutsideRepositories,
  CoreUnavailableError,
  jerryPaths,
  protectedRoots,
  readCoreRuntimeInfo,
  requestCore,
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

  await refuseIfAlreadyRunning(home);

  const store = new StateStore(paths.stateFile);
  const token = randomBytes(32).toString('hex');
  const startedAt = new Date();

  const server = createCoreServer({
    token,
    store,
    jerryHome: home,
    gateLogFile: paths.gateLogFile,
    protectedRoots: protectedRoots(),
    startedAt,
    onShutdownRequested: () => shutdown('shutdown requested via API'),
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Core server did not bind to a TCP port');
  }

  const info: CoreRuntimeInfo = {
    pid: process.pid,
    port: address.port,
    token,
    startedAt: startedAt.toISOString(),
    version: JERRY_VERSION,
  };
  writeFileAtomic(paths.coreInfoFile, `${JSON.stringify(info, null, 2)}\n`);
  process.stdout.write(`JERRY Core ${JERRY_VERSION} listening on 127.0.0.1:${address.port} (pid ${process.pid}, home ${home})\n`);

  let stopping = false;
  function shutdown(reason: string): void {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`JERRY Core stopping: ${reason}\n`);
    removeRuntimeInfoIfOwned(paths.coreInfoFile);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => removeRuntimeInfoIfOwned(paths.coreInfoFile));
}

async function refuseIfAlreadyRunning(home: string): Promise<void> {
  let info: CoreRuntimeInfo;
  try {
    info = readCoreRuntimeInfo(home);
  } catch (error) {
    if (error instanceof CoreUnavailableError) return;
    throw error;
  }
  try {
    await requestCore(info, { method: 'GET', path: '/api/v1/status', timeoutMs: 1000 });
  } catch {
    return; // stale runtime file from a crashed Core; it is overwritten on start
  }
  throw new Error(`JERRY Core is already running (pid ${info.pid}, port ${info.port})`);
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
