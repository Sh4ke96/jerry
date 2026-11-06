import type { Generated } from 'kysely';

/**
 * Tables of the JERRY database (spec §17). Timestamps are ISO-8601 strings; JSON values are text.
 * Only tables that features use exist; the rest of §17 arrives with the features that need them.
 */

export interface RepositoriesTable {
  repo_id: string;
  /** Canonical working tree root as found on disk (original case). */
  root_path: string;
  /** Set while the user excludes the repository from monitoring (hard rules still apply). */
  excluded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TasksTable {
  task_id: string;
  title: string;
  repo_id: string;
  current_plan_version: number;
  /** Workflow state (spec §7.1); changed only through validated transitions. */
  state: string;
  created_at: string;
  updated_at: string;
}

/** Every change of a task's state, in order; the history the dashboard and resume rely on. */
export interface WorkflowTransitionsTable {
  id: Generated<number>;
  task_id: string;
  /** Null for the transition that created the task. */
  from_state: string | null;
  to_state: string;
  event: string;
  actor: string;
  reason: string;
  at: string;
  created_at: string;
}

/** Every plan version is kept; approvals bind to (task_id, version, content_hash). */
export interface PlansTable {
  task_id: string;
  version: number;
  content_hash: string;
  scope_json: string;
  /** Full plan document (JSON) when Claude submitted one; null for scope-only plans. */
  document_json: string | null;
  created_at: string;
}

export interface ApprovalsTable {
  approval_id: string;
  task_id: string;
  stage: string;
  version: number;
  content_hash: string;
  decision: string;
  approved_by: string;
  approved_at: string;
  comment: string;
  created_at: string;
}

export interface SessionsTable {
  session_id: string;
  cwd: string;
  source: string | null;
  first_seen_at: string;
  last_seen_at: string;
  /** Set by SessionEnd; cleared when the same session starts again. */
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Which Claude Code session worked on which task. */
export interface SessionTasksTable {
  session_id: string;
  task_id: string;
  first_at: string;
  last_at: string;
  /** plan.submitted, plan.revised, edit or checkpoint. */
  last_activity: string;
  created_at: string;
  updated_at: string;
}

/** Implementation reports; every version is kept, acceptance binds to version and hash. */
export interface ImplementationReportsTable {
  task_id: string;
  version: number;
  plan_version: number;
  content_hash: string;
  document_json: string;
  /** What JERRY recorded itself between plan approval and report (deviations, observed edits). */
  evidence_json: string;
  submitted_by: string;
  session_id: string | null;
  created_at: string;
}

/** Read-only Git baselines of a task's repository (plan.approved, report, checkpoint). */
export interface GitSnapshotsTable {
  id: Generated<number>;
  task_id: string;
  repo_root: string;
  kind: string;
  head: string | null;
  branch: string | null;
  upstream: string | null;
  remote_url: string | null;
  staged_json: string;
  unstaged_json: string;
  untracked_json: string;
  truncated: number;
  /** Repo-relative path → content hash: the user's dirty files (plan.approved) or files changed since it. */
  fingerprints_json: string;
  /** Why Git could not be read, when it could not. */
  error: string | null;
  created_at: string;
}

/** A subagent run, from SubagentStart (and SubagentStop when it ended). */
export interface AgentRunsTable {
  agent_id: string;
  agent_type: string | null;
  session_id: string | null;
  started_at: string;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
}

/** An analyst's evidence-backed report and Core's citation check. */
export interface AnalysisReportsTable {
  id: Generated<number>;
  task_id: string;
  role: string;
  agent_id: string | null;
  session_id: string | null;
  report_json: string;
  citations_json: string;
  created_at: string;
}

/** The latest project profile of a repository and its freshness fingerprints. */
export interface ProjectProfilesTable {
  repo_id: string;
  profile_json: string;
  fingerprints_json: string;
  scanned_at: string;
  created_at: string;
  updated_at: string;
}

/** Runs of Core's final checks; DONE follows only a passing one. */
export interface TaskCompletionChecksTable {
  id: Generated<number>;
  task_id: string;
  report_version: number | null;
  /** 1 when every blocking condition passed. */
  passed: number;
  conditions_json: string;
  definition_of_done_json: string;
  created_at: string;
}

/** Claude's progress notes on a task, for the next session. */
export interface TaskCheckpointsTable {
  id: Generated<number>;
  task_id: string;
  session_id: string | null;
  summary: string;
  next_steps_json: string;
  created_at: string;
}

export interface SettingsTable {
  key: string;
  value_json: string;
  created_at: string;
  updated_at: string;
}

/** Sensitive JERRY operations: approvals, plan revisions, exclusions, imports, restores. */
export interface AuditLogTable {
  id: Generated<number>;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  details_json: string;
  created_at: string;
}

/** Events from Claude Code hooks and JERRY Core (spec §11.2). Retention removes old rows. */
export interface HookEventsTable {
  event_id: string;
  schema_version: number;
  source: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  session_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  cwd: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  task_id: string | null;
  repo_root: string | null;
  verdict: string | null;
  rule_id: string | null;
  payload_json: string;
  redaction_json: string;
  /** 1 when the event reached Core through the spool (Core was down when it happened). */
  spooled: number;
  created_at: string;
}

export interface JerrySchema {
  hook_events: HookEventsTable;
  repositories: RepositoriesTable;
  tasks: TasksTable;
  workflow_transitions: WorkflowTransitionsTable;
  plans: PlansTable;
  approvals: ApprovalsTable;
  sessions: SessionsTable;
  session_tasks: SessionTasksTable;
  task_checkpoints: TaskCheckpointsTable;
  implementation_reports: ImplementationReportsTable;
  task_completion_checks: TaskCompletionChecksTable;
  git_snapshots: GitSnapshotsTable;
  project_profiles: ProjectProfilesTable;
  agent_runs: AgentRunsTable;
  analysis_reports: AnalysisReportsTable;
  settings: SettingsTable;
  audit_log: AuditLogTable;
}
