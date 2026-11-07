import type { CoreStatus, ProjectSummary, RepositorySummary, StoredEvent, TaskSummary, WorkspaceGraph } from '@jerry/contracts';
import { reactive } from 'vue';
import { api, HttpError, SignedOutError, startSession } from './api.js';
import type { WorkflowSettings } from './settings.js';
import { readUsage, type UsageSummary } from './usage.js';

/** Polling interval while the page is visible; nothing is fetched while the tab is hidden. */
export const REFRESH_MS = 5000;

/** Usage is summed over 30 days by Core: it is read again at most this often by the regular refresh. */
export const USAGE_REFRESH_MS = 30_000;

export interface DashboardState {
  phase: 'loading' | 'ready' | 'signed-out' | 'error';
  error: string | null;
  notice: string | null;
  status: CoreStatus | null;
  tasks: TaskSummary[];
  events: StoredEvent[];
  /** The repositories the user added; JERRY monitors only these. */
  projects: ProjectSummary[];
  repositories: RepositorySummary[];
  graph: WorkspaceGraph;
  /** The workflow settings; null until loaded, or when this Core has none (older versions). */
  settings: WorkflowSettings | null;
  refreshedAt: Date | null;
  /** Claude Code usage; null until read, or when this Core has none. */
  usage: UsageSummary | null;
  /** unknown until the first answer; unavailable on a Core without usage (404); error keeps the last summary. */
  usageState: 'unknown' | 'ready' | 'unavailable' | 'error';
  usageError: string | null;
  /** When usage was last read (ms since the epoch; 0: never). */
  usageLoadedAt: number;
}

export const state = reactive<DashboardState>({
  phase: 'loading',
  error: null,
  notice: null,
  status: null,
  tasks: [],
  events: [],
  projects: [],
  repositories: [],
  graph: { nodes: [], edges: [] },
  settings: null,
  refreshedAt: null,
  usage: null,
  usageState: 'unknown',
  usageError: null,
  usageLoadedAt: 0,
});

/**
 * Fills fields that an older Core does not send yet with their defaults, so the dashboard never
 * breaks on a version mismatch (it renders less, not nothing).
 */
export function withDefaults(task: TaskSummary): TaskSummary {
  const partial = task as Partial<TaskSummary> & Pick<TaskSummary, 'taskId'>;
  return {
    ...task,
    planDecision: partial.planDecision ?? null,
    finalCheck: partial.finalCheck ?? null,
    lastCheckpoint: partial.lastCheckpoint ?? null,
    lastReport: partial.lastReport ?? null,
    reportDecision: partial.reportDecision ?? null,
    analyses: partial.analyses ?? [],
    agentRuns: partial.agentRuns ?? [],
    planGrade: partial.planGrade ?? null,
    findings: partial.findings ?? null,
    lastTestRun: partial.lastTestRun ?? null,
    activity: partial.activity ?? { sessionCount: 0, lastSessionId: null, lastActivityAt: null, lastSessionEndedAt: null },
  };
}

export async function refresh(): Promise<void> {
  try {
    const [status, tasks, events, projects, repositories, graph] = await Promise.all([api.status(), api.tasks(), api.events({ limit: 300 }), api.projects(), api.repositories(), api.workspaceGraph()]);
    Object.assign(state, { status, tasks: tasks.map(withDefaults), events, projects, repositories, graph, refreshedAt: new Date(), phase: 'ready', error: null });
    await Promise.all([loadSettings(), loadUsage()]);
  } catch (error) {
    handleError(error);
  }
}

/** The current time, read through the last refresh: views showing "resets in 2 h" re-render with every refresh. */
export function renderTime(): Date {
  return new Date(Math.max(Date.now(), state.refreshedAt?.getTime() ?? 0));
}

/**
 * Claude Code usage, read at most every USAGE_REFRESH_MS unless `force`. A Core without usage
 * (404) leaves it unavailable; any other failure keeps the last summary and says why.
 */
export async function loadUsage(force = false): Promise<void> {
  if (!force && state.usageLoadedAt !== 0 && Date.now() - state.usageLoadedAt < USAGE_REFRESH_MS) return;
  state.usageLoadedAt = Date.now();
  try {
    state.usage = readUsage(await api.usage());
    Object.assign(state, { usageState: 'ready', usageError: null });
  } catch (error) {
    if (error instanceof SignedOutError) {
      state.phase = 'signed-out';
    } else if (error instanceof HttpError && error.status === 404) {
      Object.assign(state, { usage: null, usageState: 'unavailable', usageError: null });
    } else {
      Object.assign(state, { usageState: 'error', usageError: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** The workflow settings; an older Core without them leaves them null, and nothing else changes. */
export async function loadSettings(): Promise<void> {
  try {
    state.settings = await api.settings();
  } catch (error) {
    if (error instanceof SignedOutError) state.phase = 'signed-out';
  }
}

export function handleError(error: unknown): void {
  if (error instanceof SignedOutError) {
    state.phase = 'signed-out';
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (state.phase === 'loading') {
    state.phase = 'error';
    state.error = message;
  } else {
    state.notice = message;
  }
}

/** Runs an action, shows its outcome and reloads the data it changed. */
export async function perform(action: () => Promise<unknown>, success: string): Promise<boolean> {
  try {
    await action();
    state.notice = success;
    await refresh();
    return true;
  } catch (error) {
    handleError(error);
    return false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export async function startDashboard(): Promise<void> {
  try {
    await startSession();
  } catch (error) {
    handleError(error);
    return;
  }
  state.usageLoadedAt = 0;
  await refresh();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.phase === 'ready') void refresh();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.phase === 'ready') void refresh();
  });
}

export async function signOut(): Promise<void> {
  if (timer !== null) clearInterval(timer);
  try {
    await api.signOut();
  } finally {
    state.phase = 'signed-out';
  }
}
