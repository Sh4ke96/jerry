import type { ApprovalRecord, ArtifactDecision, CoreStatus, FinalChecksRerun, FinalReport,EvalRunDetail, EvalRunSummary, EvalStatus, Finding, Plan, PlanDrift, ReviewState, ProjectProfile, ProjectAddResult, ProjectRemoveResult, ProjectSummary, DataUsage, PruneOptions, PrunePreview, PruneResult, ForgetPreview, ForgetResult, RepositorySummary, SkillChangeResult, SkillDetail, SkillPreview, SkillsList, StoredEvent, Task, TaskSummary, WorkflowState, WorkflowTransition, WorkspaceGraph } from '@jerry/contracts';

import type { ProjectReviewMode, SettingsUpdate, WorkflowSettings } from './settings.js';

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

/** Core answered, but not with success; `status` tells a route an older Core lacks (404) apart. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The error's details, as Core sent them (e.g. the skill folders to pick from). */
    readonly details: unknown = undefined,
  ) {
    super(message);
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
  const answer = (await response.json().catch(() => ({}))) as { error?: string; details?: unknown };
  if (!response.ok) throw new HttpError(answer.error ?? `JERRY Core answered HTTP ${response.status}`, response.status, answer.details);
  return answer as T;
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
  decideReport: (task: TaskSummary, reportVersion: number, decision: 'APPROVED' | 'REJECTED', confirmTaskId: string, comment: string, review?: boolean) =>
    request<ApprovalRecord>('POST', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/approvals`, {
      stage: 'IMPLEMENTATION',
      version: reportVersion,
      decision,
      comment,
      confirmTaskId,
      // Accepting only, and only when Core knows review modes: whether the task goes to independent review.
      ...(decision === 'APPROVED' && review !== undefined ? { review } : {}),
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
  /** The user re-runs the final checks of a task waiting in FINAL_REPORT; Core sets DONE if they pass. */
  rerunFinalChecks: (taskId: string, confirmTaskId: string) => request<FinalChecksRerun>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/final-checks`, { confirmTaskId }),
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
  /** The repositories the user added; JERRY monitors only these. */
  projects: () => request<ProjectSummary[]>('GET', '/api/v1/projects'),
  /** Adds the repository at `path`; the dashboard sends its root typed by the user. */
  addProject: (path: string, confirmation: string) => request<ProjectAddResult>('POST', '/api/v1/projects', { path, confirmation }),
  /** Removes a project; its open tasks stay, and the answer warns about them. */
  removeProject: (path: string, confirmation: string) => request<ProjectRemoveResult>('POST', '/api/v1/projects/remove', { path, confirmation }),
  /** The project's own review setting; null inherits the global one. */
  setProjectReviewMode: (path: string, reviewMode: ProjectReviewMode) => request<ProjectSummary>('POST', '/api/v1/projects/settings', { path, reviewMode }),
  /** The user's workflow settings: the review mode and the language of QA scenarios. */
  settings: () => request<WorkflowSettings>('GET', '/api/v1/settings'),
  saveSettings: (update: SettingsUpdate) => request<WorkflowSettings>('POST', '/api/v1/settings', update),
  /** Claude Code usage as Core collected it; raw, read with readUsage (an older Core answers 404). */
  usage: () => request<unknown>('GET', '/api/v1/usage'),
  /** Turns collecting usage from Claude Code on or off; answers the new collection status (raw). */
  setUsageCollection: (enabled: boolean) => request<unknown>('POST', '/api/v1/usage/collection', { enabled }),
  /** What JERRY stores on this computer. */
  dataUsage: () => request<DataUsage>('GET', '/api/v1/data/usage'),
  /** Exactly what a prune with these options would delete; nothing is deleted. */
  previewPrune: (options: PruneOptions) => request<PrunePreview>('POST', '/api/v1/data/prune/preview', options),
  /** Deletes old data after a backup; needs the word "delete" typed. */
  prune: (options: PruneOptions, confirmation: string) => request<PruneResult>('POST', '/api/v1/data/prune', { ...options, confirmation }),
  /** Everything JERRY stores about one repository; nothing is deleted. */
  previewForget: (path: string) => request<ForgetPreview>('POST', '/api/v1/data/forget/preview', { path }),
  /** Deletes everything about one repository after a backup; needs its root typed. */
  forget: (path: string, confirmation: string) => request<ForgetResult>('POST', '/api/v1/data/forget', { path, confirmation }),
  signOut: () => request<{ signedOut: true }>('POST', '/ui/logout', {}),
  /** Skills: JERRY's own (read-only), the ones added through JERRY, and the user's others. */
  skills: () => request<SkillsList>('GET', '/api/v1/skills'),
  skill: (name: string) => request<SkillDetail>('GET', `/api/v1/skills/${encodeURIComponent(name)}`),
  /** Reads, validates, scans and stages a skill; installs nothing. */
  previewSkill: (input: SkillPreviewInput) => request<SkillPreview>('POST', '/api/v1/skills/preview', input),
  /** Installs a previewed skill; needs its name typed. */
  installSkill: (previewId: string, confirmation: string) => request<SkillChangeResult>('POST', '/api/v1/skills/install', { previewId, confirmation }),
  /** Switches a skill on or off in Claude Code's settings (skillOverrides). */
  setSkillEnabled: (name: string, enabled: boolean) => request<SkillChangeResult>('POST', `/api/v1/skills/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`, {}),
  /** The task states in which JERRY tells Claude to use the skill (empty: never). */
  setSkillStates: (name: string, states: readonly WorkflowState[], confirmation: string) => request<SkillChangeResult>('POST', `/api/v1/skills/${encodeURIComponent(name)}/states`, { states, confirmation }),
  /** The new version of a skill, from its source or from an uploaded file. */
  previewSkillUpdate: (name: string, input: SkillPreviewInput = {}) => request<SkillPreview>('POST', `/api/v1/skills/${encodeURIComponent(name)}/update/preview`, input),
  applySkillUpdate: (name: string, previewId: string, confirmation: string) => request<SkillChangeResult>('POST', `/api/v1/skills/${encodeURIComponent(name)}/update/apply`, { previewId, confirmation }),
  /** Moves the skill's folder to JERRY's backups; needs its name typed. */
  removeSkill: (name: string, confirmation: string) => request<SkillChangeResult>('POST', `/api/v1/skills/${encodeURIComponent(name)}/remove`, { confirmation }),
};

/** A GitHub URL or local path, or a zip chosen in the browser (base64). */
export type SkillPreviewInput = { source?: string; upload?: { fileName: string; dataBase64: string } };
