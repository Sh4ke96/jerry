import type { CoreStatus, RepositoryExclusion, RepositorySummary, StoredEvent, TaskSummary, WorkspaceGraph } from '@jerry/contracts';
import { reactive } from 'vue';
import { api, SignedOutError, startSession } from './api.js';

/** Polling interval while the page is visible; nothing is fetched while the tab is hidden. */
export const REFRESH_MS = 5000;

export interface DashboardState {
  phase: 'loading' | 'ready' | 'signed-out' | 'error';
  error: string | null;
  notice: string | null;
  status: CoreStatus | null;
  tasks: TaskSummary[];
  events: StoredEvent[];
  exclusions: RepositoryExclusion[];
  repositories: RepositorySummary[];
  graph: WorkspaceGraph;
  refreshedAt: Date | null;
}

export const state = reactive<DashboardState>({
  phase: 'loading',
  error: null,
  notice: null,
  status: null,
  tasks: [],
  events: [],
  exclusions: [],
  repositories: [],
  graph: { nodes: [], edges: [] },
  refreshedAt: null,
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
    const [status, tasks, events, exclusions, repositories, graph] = await Promise.all([api.status(), api.tasks(), api.events({ limit: 300 }), api.exclusions(), api.repositories(), api.workspaceGraph()]);
    Object.assign(state, { status, tasks: tasks.map(withDefaults), events, exclusions, repositories, graph, refreshedAt: new Date(), phase: 'ready', error: null });
  } catch (error) {
    handleError(error);
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
