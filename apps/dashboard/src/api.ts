import type { ApprovalRecord, ArtifactDecision, CoreStatus, FinalReport, EvalRunDetail, EvalRunSummary, EvalStatus, Finding, Plan, PlanDrift, ReviewState, ProjectProfile, RepositoryExclusion, RepositorySummary, StoredEvent, Task, TaskSummary, WorkflowTransition, WorkspaceGraph } from '@jerry/contracts';

export type TaskControlEvent = 'task.paused' | 'task.resumed' | 'task.cancelled';

/**
 * The dashboard's only way to Core: same-origin fetches with the session cookie. Every
 * state-changing request carries the session's CSRF token.
 */

export class SignedOutError extends Error {
  constructor() {
    super('The dashboard session ended.');
  }
}

let csrfToken: string | null = null;

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken !== null) headers['x-jerry-csrf'] = csrfToken;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401) throw new SignedOutError();
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `JERRY Core answered HTTP ${response.status}`);
  return data as T;
}

export async function startSession(): Promise<{ expiresAt: string }> {
  const session = await request<{ csrfToken: string; expiresAt: string }>('GET', '/api/v1/ui/session');
  csrfToken = session.csrfToken;
  return { expiresAt: session.expiresAt };
}

export interface EventQuery {
  verdict?: 'WARN' | 'DENY' | 'WARN,DENY';
  since?: string;
  limit?: number;
}

export const api = {
  status: () => request<CoreStatus>('GET', '/api/v1/status'),
  tasks: () => request<TaskSummary[]>('GET', '/api/v1/tasks'),
  exclusions: () => request<RepositoryExclusion[]>('GET', '/api/v1/repositories/exclusions'),
  repositories: () => request<RepositorySummary[]>('GET', '/api/v1/repositories'),
  workspaceGraph: () => request<WorkspaceGraph>('GET', '/api/v1/workspace/graph'),
  /** Read-only rescan of a repository's profile. */
  scanRepository: (repoPath: string) => request<ProjectProfile>('POST', '/api/v1/repositories/scan', { repoPath }),
  events: (query: EventQuery = {}) => {
    const params = new URLSearchParams({ limit: String(query.limit ?? 200) });
    if (query.verdict !== undefined) params.set('verdict', query.verdict);
    if (query.since !== undefined) params.set('since', query.since);
    return request<StoredEvent[]>('GET', `/api/v1/events?${params.toString()}`);
  },
  decide: (task: TaskSummary, decision: 'APPROVED' | 'REJECTED', confirmTaskId: string) =>
    request<ApprovalRecord>('POST', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/approvals`, {
      stage: 'PLAN',
      version: task.plan.version,
      decision,
      confirmTaskId,
    }),
  /** Accept the latest implementation report, or send it back with what should change. */
  decideReport: (task: TaskSummary, reportVersion: number, decision: 'APPROVED' | 'REJECTED', confirmTaskId: string, comment: string) =>
    request<ApprovalRecord>('POST', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/approvals`, {
      stage: 'IMPLEMENTATION',
      version: reportVersion,
      decision,
      comment,
      confirmTaskId,
    }),
  transitions: (taskId: string) => request<WorkflowTransition[]>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/transitions`),
  /** Every plan version, oldest first. */
  plans: (taskId: string) => request<Plan[]>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/plans`),
  /** The final report of a task and the Artifact decisions. */
  finalReport: (taskId: string) => request<FinalReport>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/final-report`),
  artifacts: () => request<ArtifactDecision[]>('GET', '/api/v1/artifacts'),
  /** Eval runs, status and calibration. */
  evalRuns: () => request<EvalRunSummary[]>('GET', '/api/v1/evals/runs'),
  evalRun: (runId: string) => request<EvalRunDetail>('GET', `/api/v1/evals/runs/${encodeURIComponent(runId)}`),
  evalStatus: () => request<EvalStatus>('GET', '/api/v1/evals/status'),
  evalCalibration: () => request<Array<{ rubricId: string; labels: number; agreement: number; calibrated: boolean }>>('GET', '/api/v1/evals/calibration'),
  /** The user's baseline choice, with a reason and the typed run ID. */
  setEvalBaseline: (runId: string, note: string, confirm: string) => request<EvalRunSummary>('POST', '/api/v1/evals/baseline', { runId, note, confirm }),
  /** The independent review of a task. */
  review: (taskId: string) => request<ReviewState>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/review`),
  /** The user's decision on a review round's fix plan (stage REVIEW_FIX, version = round). */
  decideFixPlan: (taskId: string, round: number, decision: 'APPROVED' | 'REJECTED', confirmTaskId: string, comment: string) =>
    request<ApprovalRecord>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/approvals`, { stage: 'REVIEW_FIX', version: round, decision, comment, confirmTaskId }),
  /** The user waives the review, with a reason and the typed task ID. */
  skipReview: (taskId: string, reason: string, confirmTaskId: string) => request<ReviewState>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/review/skip`, { reason, confirmTaskId }),
  /** Plan drift, step order and implementer assignments. */
  drift: (taskId: string) => request<PlanDrift>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/drift`),
  /** Quality findings of a task, all statuses. */
  findings: (taskId: string) => request<Finding[]>('GET', `/api/v1/findings?taskId=${encodeURIComponent(taskId)}&limit=500`),
  /** The user's decision on a finding, always with a reason. */
  setFindingStatus: (findingId: string, status: 'OPEN' | 'ACCEPTED' | 'WONT_FIX' | 'FALSE_POSITIVE', reason: string) =>
    request<Finding>('POST', `/api/v1/findings/${encodeURIComponent(findingId)}/status`, { status, reason }),
  /** Pause, resume or cancel; cancelling needs the typed task ID. */
  control: (taskId: string, event: TaskControlEvent, confirmTaskId?: string) =>
    request<Task>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/transitions`, {
      event,
      ...(confirmTaskId === undefined ? {} : { confirmTaskId }),
    }),
  setExcluded: (repoPath: string, excluded: boolean, confirmation?: string) =>
    request<{ repoRoot: string; excluded: boolean }>('POST', '/api/v1/repositories/exclusions', {
      repoPath,
      excluded,
      ...(confirmation === undefined ? {} : { confirmation }),
    }),
  signOut: () => request<{ signedOut: true }>('POST', '/ui/logout', {}),
};
