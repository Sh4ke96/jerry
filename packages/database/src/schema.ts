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
  /** What a task taken in before its plan should achieve (ADR 0024); null otherwise. */
  goal: string | null;
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

/** Quality findings (ADR 0027); identity is repo, task, file, rule and fingerprint. */
export interface FindingsTable {
  id: Generated<number>;
  task_id: string | null;
  repo_root: string;
  file: string;
  rule_id: string;
  rule_version: string;
  fingerprint: string;
  source: string;
  category: string;
  severity: string;
  confidence: number;
  line_start: number;
  line_end: number;
  title: string;
  evidence: string;
  why: string;
  fix: string;
  plan_related: Generated<number>;
  status: string;
  status_reason: Generated<string>;
  session_id: string | null;
  agent_id: string | null;
  /** When Claude was last told about it; feedback goes out once per finding. */
  fed_back_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

/** Every status change of a finding, by the user or Core. */
export interface FindingEventsTable {
  id: Generated<number>;
  finding_id: number;
  from_status: string | null;
  to_status: string;
  actor: string;
  reason: string;
  at: string;
}

/** One run of the quality checks over a batch of changed files. */
export interface QualityBatchesTable {
  id: Generated<number>;
  task_id: string | null;
  repo_root: string;
  session_id: string | null;
  files_json: string;
  started_at: string;
  duration_ms: number;
  new_count: number;
  fixed_count: number;
  error: string | null;
}

/** A test command Claude ran and its result (ADR 0030). */
export interface TestRunsTable {
  id: Generated<number>;
  task_id: string | null;
  repo_root: string;
  session_id: string | null;
  agent_id: string | null;
  event_id: string;
  command: string;
  /** PASS, FAIL or INTERRUPTED. */
  result: string;
  exit_code: number | null;
  summary: string | null;
  at: string;
}

/** An implementer's part of a plan (ADR 0031). */
export interface ImplementerAssignmentsTable {
  id: Generated<number>;
  task_id: string;
  label: string;
  steps_json: string;
  files_json: string;
  agent_id: string | null;
  session_id: string | null;
  created_at: string;
  released_at: string | null;
}

/** One independent review round of a task (ADR 0032–0035). */
export interface ReviewRoundsTable {
  id: Generated<number>;
  task_id: string;
  round: number;
  started_at: string;
  changed_files_json: string;
  completed_at: string | null;
  completed_by: string | null;
  passed_at: string | null;
  skipped_at: string | null;
  skip_reason: string | null;
  fix_plan_json: string | null;
  fix_plan_hash: string | null;
  fixes_approved_at: string | null;
  fixes_reported_at: string | null;
  fixes_summary: string | null;
}

/** A reviewer's submission for a round; one per role and round (a resubmission replaces it). */
export interface ReviewSubmissionsTable {
  id: Generated<number>;
  task_id: string;
  round: number;
  role: string;
  agent_id: string | null;
  session_id: string | null;
  files_reviewed_json: string;
  summary: string;
  gaps_json: string;
  finding_count: number;
  independent: number;
  independence_note: string;
  created_at: string;
}

/** Which reviewer reported a finding in which round (findings are shared across reviewers). */
export interface ReviewFindingSourcesTable {
  finding_id: number;
  task_id: string;
  round: number;
  role: string;
}

/** An eval run with its full per-case results (ADR 0039). */
export interface EvalRunsTable {
  id: Generated<number>;
  started_at: string;
  finished_at: string;
  jerry_version: string;
  fingerprint_json: string;
  label: string;
  results_json: string;
  created_at: string;
}

/** Baseline history; the latest row is the current baseline. Only the user sets one. */
export interface EvalBaselinesTable {
  id: Generated<number>;
  run_id: number;
  note: string;
  set_at: string;
}

/** A human's verdict on a rubric grader's result, for calibration. */
export interface EvalLabelsTable {
  id: Generated<number>;
  run_id: number;
  case_id: string;
  attempt: number;
  rubric_id: string;
  human_passed: number;
  grader_passed: number;
  score: number | null;
  labeled_at: string;
}

/** The user's choice about an Artifact for a task (ADR 0042). */
export interface ArtifactDecisionsTable {
  id: Generated<number>;
  task_id: string;
  decision: string;
  kind: string | null;
  title: string | null;
  url: string | null;
  reason: Generated<string>;
  session_id: string | null;
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
  findings: FindingsTable;
  finding_events: FindingEventsTable;
  quality_batches: QualityBatchesTable;
  test_runs: TestRunsTable;
  implementer_assignments: ImplementerAssignmentsTable;
  review_rounds: ReviewRoundsTable;
  review_submissions: ReviewSubmissionsTable;
  review_finding_sources: ReviewFindingSourcesTable;
  eval_runs: EvalRunsTable;
  eval_baselines: EvalBaselinesTable;
  eval_labels: EvalLabelsTable;
  artifact_decisions: ArtifactDecisionsTable;
  settings: SettingsTable;
  audit_log: AuditLogTable;
}
