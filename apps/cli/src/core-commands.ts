import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { coreStatusSchema, type CoreRuntimeInfo, type CoreStatus } from '@jerry/contracts';
import {
  assertJerryHomeOutsideRepositories,
  CoreUnavailableError,
  jerryPaths,
  readCoreRuntimeInfo,
  requestCore,
  resolveJerryHome,
  spawnDetachedCore,
} from '@jerry/platform';
import { mark } from './emoji.js';

/** Core from the same build as this CLI; falls back to the installed runtime copy. */
const SIBLING_CORE = fileURLToPath(new URL('../core/core.mjs', import.meta.url));

export async function getCoreStatus(home: string = resolveJerryHome()): Promise<{ info: CoreRuntimeInfo; status: CoreStatus }> {
  const info = readCoreRuntimeInfo(home);
  const status = coreStatusSchema.parse(await requestCore(info, { method: 'GET', path: '/api/v1/status', timeoutMs: 2000 }));
  return { info, status };
}

export async function startCore(): Promise<void> {
  const home = resolveJerryHome();
  assertJerryHomeOutsideRepositories(home);
  const paths = jerryPaths(home);
  fs.rmSync(paths.autostartDisabledFile, { force: true });

  try {
    const { info } = await getCoreStatus(home);
    console.log(mark('info', `JERRY Core already running (pid ${info.pid}, port ${info.port}).`));
    return;
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
  }

  const coreScript = fs.existsSync(SIBLING_CORE) ? SIBLING_CORE : paths.runtimeCoreFile;
  if (!fs.existsSync(coreScript)) throw new Error(`Core not found at ${SIBLING_CORE} or ${paths.runtimeCoreFile}. Run "pnpm build" or "jerry install".`);
  spawnDetachedCore(home, coreScript);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      const { info } = await getCoreStatus(home);
      const fallback = info.configuredPort !== undefined && info.configuredPort !== 0 && info.configuredPort !== info.port;
      console.log(mark('pass', `JERRY Core started (pid ${info.pid}, port ${info.port}${fallback ? `, configured port ${info.configuredPort} was in use` : ''}, home ${home}).`));
      return;
    } catch {
      // not ready yet
    }
  }
  throw new Error(`JERRY Core did not become healthy within 10 s; see ${paths.logsDir}\\core.log`);
}

/** Stops Core and disables automatic starts until the user runs "jerry core start" again. */
export async function stopCore(): Promise<void> {
  const home = resolveJerryHome();
  const paths = jerryPaths(home);
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(paths.autostartDisabledFile, new Date().toISOString());

  let info: CoreRuntimeInfo;
  try {
    info = readCoreRuntimeInfo(home);
  } catch (error) {
    if (error instanceof CoreUnavailableError) {
      console.log(mark('paused', 'JERRY Core is not running. Automatic start is disabled until "jerry core start".'));
      return;
    }
    throw error;
  }
  try {
    await requestCore(info, { method: 'POST', path: '/api/v1/shutdown', body: {}, timeoutMs: 2000 });
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
    console.log(mark('warning', `JERRY Core (pid ${info.pid}) did not answer; it is probably already stopped.`));
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && fs.existsSync(paths.coreInfoFile)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(mark('paused', `JERRY Core (pid ${info.pid}) stopped. Automatic start is disabled until "jerry core start".`));
}
