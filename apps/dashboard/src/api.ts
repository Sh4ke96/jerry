import type { ApprovalRecord, CoreStatus, RepositoryExclusion, StoredEvent, Task, TaskSummary, WorkflowTransition } from '@jerry/contracts';

export type TaskControlEvent = 'task.paused' | 'task.resumed' | 'task.cancelled';

/**
 * The dashboard's only way to Core: same-origin fetches with the session cookie. Every
 * state-changing request carries the session's CSRF token (ADR 0007).
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
  transitions: (taskId: string) => request<WorkflowTransition[]>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/transitions`),
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
