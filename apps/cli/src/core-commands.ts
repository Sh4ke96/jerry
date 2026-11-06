import { spawn } from 'node:child_process';
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
} from '@jerry/platform';

const CORE_BUNDLE = fileURLToPath(new URL('../core/core.mjs', import.meta.url));

export async function getCoreStatus(home: string = resolveJerryHome()): Promise<{ info: CoreRuntimeInfo; status: CoreStatus }> {
  const info = readCoreRuntimeInfo(home);
  const status = coreStatusSchema.parse(await requestCore(info, { method: 'GET', path: '/api/v1/status', timeoutMs: 2000 }));
  return { info, status };
}

export async function startCore(): Promise<void> {
  const home = resolveJerryHome();
  try {
    const { info } = await getCoreStatus(home);
    console.log(`JERRY Core already running (pid ${info.pid}, port ${info.port}).`);
    return;
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
  }
  if (!fs.existsSync(CORE_BUNDLE)) throw new Error(`Core bundle not found at ${CORE_BUNDLE}. Run "pnpm build" first.`);

  assertJerryHomeOutsideRepositories(home);
  const paths = jerryPaths(home);
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const log = fs.openSync(`${paths.logsDir}/core.log`, 'a');
  const child = spawn(process.execPath, [CORE_BUNDLE], {
    // Never inherit a repository as working directory: on Windows a running process's cwd
    // cannot be deleted or renamed, so Core would lock the user's project folder.
    cwd: home,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, JERRY_HOME: home },
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      const { info } = await getCoreStatus(home);
      console.log(`JERRY Core started (pid ${info.pid}, port ${info.port}, home ${home}).`);
      return;
    } catch {
      // not ready yet
    }
  }
  throw new Error(`JERRY Core did not become healthy within 10 s; see ${paths.logsDir}\\core.log`);
}

export async function stopCore(): Promise<void> {
  const home = resolveJerryHome();
  let info: CoreRuntimeInfo;
  try {
    info = readCoreRuntimeInfo(home);
  } catch (error) {
    if (error instanceof CoreUnavailableError) {
      console.log('JERRY Core is not running.');
      return;
    }
    throw error;
  }
  try {
    await requestCore(info, { method: 'POST', path: '/api/v1/shutdown', body: {}, timeoutMs: 2000 });
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
    console.log(`JERRY Core (pid ${info.pid}) did not answer; it is probably already stopped.`);
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && fs.existsSync(jerryPaths(home).coreInfoFile)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(`JERRY Core (pid ${info.pid}) stopped.`);
}
