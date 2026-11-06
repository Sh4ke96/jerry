import fs from 'node:fs';
import { storedEventSchema, taskWithDecisionSchema } from '@jerry/contracts';
import { CoreUnavailableError, jerryPaths, readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';
import { getCoreStatus } from './core-commands.js';

/**
 * Quick summary for everyday use (no Claude Code calls, so it answers instantly). "jerry doctor"
 * does the thorough check, including whether the plugin is actually enabled.
 */
export async function showStatus(): Promise<void> {
  const home = resolveJerryHome();
  const paths = jerryPaths(home);
  const installed = fs.existsSync(paths.installManifestFile);

  let core: Awaited<ReturnType<typeof getCoreStatus>> | null = null;
  try {
    core = await getCoreStatus(home);
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
  }

  const guard = !installed ? 'UNGUARDED (JERRY is not installed: run "jerry install")' : core === null ? 'DEGRADED (Core is not running: monitoring off, hard rules still enforced)' : 'GUARDED (monitoring on, hard rules enforced)';
  console.log(`JERRY: ${guard}`);
  if (core === null) {
    const paused = fs.existsSync(paths.autostartDisabledFile);
    console.log(paused ? 'Core was stopped with "jerry core stop"; start it with "jerry core start".' : 'Core starts with the next Claude Code session, or now with "jerry core start".');
    return;
  }

  const info = readCoreRuntimeInfo(home);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [tasks, flagged] = await Promise.all([
    requestCore(info, { method: 'GET', path: '/api/v1/tasks', timeoutMs: 5000 }).then((body) => z.array(taskWithDecisionSchema).parse(body)),
    requestCore(info, { method: 'GET', path: `/api/v1/events?verdict=WARN,DENY&since=${encodeURIComponent(startOfDay.toISOString())}&limit=500`, timeoutMs: 5000 }).then((body) => z.array(storedEventSchema).parse(body)),
  ]);
  const approved = tasks.filter((candidate) => candidate.planDecision?.decision === 'APPROVED').length;
  const waiting = tasks.filter((candidate) => candidate.planDecision === null).length;
  const uptimeMinutes = Math.round((Date.now() - Date.parse(core.status.startedAt)) / 60_000);

  console.log(`Core:      ${core.status.version}, pid ${core.info.pid}, up ${uptimeMinutes < 120 ? `${uptimeMinutes} min` : `${Math.round(uptimeMinutes / 60)} h`}, ${core.status.sessionCount} session(s)`);
  console.log(`Plans:     ${approved} approved, ${waiting} waiting for your decision`);
  console.log(`Today:     ${flagged.filter((event) => event.verdict === 'WARN').length} deviation(s), ${flagged.filter((event) => event.verdict === 'DENY').length} blocked`);
  console.log(`Dashboard: http://127.0.0.1:${core.info.port} (open with "jerry ui")`);
}
