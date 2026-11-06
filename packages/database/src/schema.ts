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
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
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
  plans: PlansTable;
  approvals: ApprovalsTable;
  sessions: SessionsTable;
  settings: SettingsTable;
  audit_log: AuditLogTable;
}
