import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * Migrations live in code because Core ships as a single bundled file. Names sort in order of
 * application; never edit a released migration, add a new one.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_initial': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('repositories')
        .addColumn('repo_id', 'text', (column) => column.primaryKey())
        .addColumn('root_path', 'text', (column) => column.notNull().unique())
        .addColumn('excluded_at', 'text')
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();

      await db.schema
        .createTable('tasks')
        .addColumn('task_id', 'text', (column) => column.primaryKey())
        .addColumn('title', 'text', (column) => column.notNull())
        .addColumn('repo_id', 'text', (column) => column.notNull().references('repositories.repo_id'))
        .addColumn('current_plan_version', 'integer', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('tasks_repo_id').on('tasks').column('repo_id').execute();

      await db.schema
        .createTable('plans')
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('version', 'integer', (column) => column.notNull())
        .addColumn('content_hash', 'text', (column) => column.notNull())
        .addColumn('scope_json', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addPrimaryKeyConstraint('plans_pk', ['task_id', 'version'])
        .execute();

      await db.schema
        .createTable('approvals')
        .addColumn('approval_id', 'text', (column) => column.primaryKey())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('stage', 'text', (column) => column.notNull())
        .addColumn('version', 'integer', (column) => column.notNull())
        .addColumn('content_hash', 'text', (column) => column.notNull())
        .addColumn('decision', 'text', (column) => column.notNull())
        .addColumn('approved_by', 'text', (column) => column.notNull())
        .addColumn('approved_at', 'text', (column) => column.notNull())
        .addColumn('comment', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('approvals_task_id').on('approvals').column('task_id').execute();

      await db.schema
        .createTable('sessions')
        .addColumn('session_id', 'text', (column) => column.primaryKey())
        .addColumn('cwd', 'text', (column) => column.notNull())
        .addColumn('source', 'text')
        .addColumn('first_seen_at', 'text', (column) => column.notNull())
        .addColumn('last_seen_at', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('sessions_last_seen_at').on('sessions').column('last_seen_at').execute();

      await db.schema
        .createTable('settings')
        .addColumn('key', 'text', (column) => column.primaryKey())
        .addColumn('value_json', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();

      await db.schema
        .createTable('audit_log')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('at', 'text', (column) => column.notNull())
        .addColumn('actor', 'text', (column) => column.notNull())
        .addColumn('action', 'text', (column) => column.notNull())
        .addColumn('subject', 'text')
        .addColumn('details_json', 'text', (column) => column.notNull().defaultTo(sql`'{}'`))
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('audit_log_at').on('audit_log').column('at').execute();
    },
  },

  '0002_hook_events': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('hook_events')
        .addColumn('event_id', 'text', (column) => column.primaryKey())
        .addColumn('schema_version', 'integer', (column) => column.notNull())
        .addColumn('source', 'text', (column) => column.notNull())
        .addColumn('event_type', 'text', (column) => column.notNull())
        .addColumn('occurred_at', 'text', (column) => column.notNull())
        .addColumn('received_at', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text')
        .addColumn('agent_id', 'text')
        .addColumn('agent_type', 'text')
        .addColumn('cwd', 'text')
        .addColumn('tool_name', 'text')
        .addColumn('tool_use_id', 'text')
        .addColumn('task_id', 'text')
        .addColumn('repo_root', 'text')
        .addColumn('verdict', 'text')
        .addColumn('rule_id', 'text')
        .addColumn('payload_json', 'text', (column) => column.notNull())
        .addColumn('redaction_json', 'text', (column) => column.notNull())
        .addColumn('spooled', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('hook_events_occurred_at').on('hook_events').column('occurred_at').execute();
      await db.schema.createIndex('hook_events_session').on('hook_events').columns(['session_id', 'occurred_at']).execute();
      await db.schema.createIndex('hook_events_tool_use_id').on('hook_events').column('tool_use_id').execute();
      await db.schema.createIndex('hook_events_verdict').on('hook_events').columns(['verdict', 'occurred_at']).execute();
    },
  },

  '0003_plan_documents': {
    async up(db: Kysely<unknown>): Promise<void> {
      // The full plan when Claude submitted one; NULL for scope-only plans.
      await db.schema.alterTable('plans').addColumn('document_json', 'text').execute();
    },
  },

  '0004_workflow': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Task state; Core changes it only through the workflow transition table.
      await db.schema
        .alterTable('tasks')
        .addColumn('state', 'text', (column) => column.notNull().defaultTo('WAIT_PLAN_APPROVAL'))
        .execute();

      await db.schema
        .createTable('workflow_transitions')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('from_state', 'text')
        .addColumn('to_state', 'text', (column) => column.notNull())
        .addColumn('event', 'text', (column) => column.notNull())
        .addColumn('actor', 'text', (column) => column.notNull())
        .addColumn('reason', 'text', (column) => column.notNull().defaultTo(''))
        .addColumn('at', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('workflow_transitions_task').on('workflow_transitions').columns(['task_id', 'id']).execute();

      // Existing tasks: the latest decision on the current plan version and hash decides the state,
      // the same rule the gate used before states existed.
      await sql`
        UPDATE tasks SET state = CASE (
          SELECT approvals.decision
          FROM approvals
          JOIN plans ON plans.task_id = approvals.task_id AND plans.version = approvals.version AND plans.content_hash = approvals.content_hash
          WHERE approvals.task_id = tasks.task_id AND approvals.version = tasks.current_plan_version AND approvals.stage = 'PLAN'
          ORDER BY approvals.approved_at DESC, approvals.rowid DESC
          LIMIT 1
        )
          WHEN 'APPROVED' THEN 'IMPLEMENTATION'
          WHEN 'REJECTED' THEN 'PLAN_DRAFT'
          ELSE 'WAIT_PLAN_APPROVAL'
        END
      `.execute(db);
    },
  },

  '0005_session_tasks': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Set by SessionEnd, cleared when the same session starts again (resume).
      await db.schema.alterTable('sessions').addColumn('ended_at', 'text').execute();
      await db.schema.alterTable('sessions').addColumn('end_reason', 'text').execute();

      // Which session worked on which task. No foreign key to sessions: retention removes
      // old sessions, while the task keeps the record of who worked on it.
      await db.schema
        .createTable('session_tasks')
        .addColumn('session_id', 'text', (column) => column.notNull())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('first_at', 'text', (column) => column.notNull())
        .addColumn('last_at', 'text', (column) => column.notNull())
        .addColumn('last_activity', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .addPrimaryKeyConstraint('session_tasks_pk', ['session_id', 'task_id'])
        .execute();
      await db.schema.createIndex('session_tasks_task').on('session_tasks').columns(['task_id', 'last_at']).execute();

      await db.schema
        .createTable('task_checkpoints')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('session_id', 'text')
        .addColumn('summary', 'text', (column) => column.notNull())
        .addColumn('next_steps_json', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('task_checkpoints_task').on('task_checkpoints').columns(['task_id', 'id']).execute();
    },
  },

  '0006_implementation_reports': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Every report version is kept; the user's acceptance binds to (task_id, version, content_hash)
      // through the approvals table, stage IMPLEMENTATION.
      await db.schema
        .createTable('implementation_reports')
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('version', 'integer', (column) => column.notNull())
        .addColumn('plan_version', 'integer', (column) => column.notNull())
        .addColumn('content_hash', 'text', (column) => column.notNull())
        .addColumn('document_json', 'text', (column) => column.notNull())
        .addColumn('evidence_json', 'text', (column) => column.notNull())
        .addColumn('submitted_by', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text')
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addPrimaryKeyConstraint('implementation_reports_pk', ['task_id', 'version'])
        .execute();
    },
  },

  '0007_completion_checks': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Every run of Core's final checks: DONE is set only when one passed.
      await db.schema
        .createTable('task_completion_checks')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('report_version', 'integer')
        .addColumn('passed', 'integer', (column) => column.notNull())
        .addColumn('conditions_json', 'text', (column) => column.notNull())
        .addColumn('definition_of_done_json', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('task_completion_checks_task').on('task_completion_checks').columns(['task_id', 'id']).execute();
    },
  },

  '0008_git_snapshots': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Read-only Git baselines: at plan approval, report and checkpoint. Paths and
      // content hashes only, never file contents; remote URLs without credentials.
      await db.schema
        .createTable('git_snapshots')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('kind', 'text', (column) => column.notNull())
        .addColumn('head', 'text')
        .addColumn('branch', 'text')
        .addColumn('upstream', 'text')
        .addColumn('remote_url', 'text')
        .addColumn('staged_json', 'text', (column) => column.notNull())
        .addColumn('unstaged_json', 'text', (column) => column.notNull())
        .addColumn('untracked_json', 'text', (column) => column.notNull())
        .addColumn('truncated', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('fingerprints_json', 'text', (column) => column.notNull())
        .addColumn('error', 'text')
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('git_snapshots_task').on('git_snapshots').columns(['task_id', 'kind', 'id']).execute();
    },
  },

  '0009_project_profiles': {
    async up(db: Kysely<unknown>): Promise<void> {
      // One profile per repository: the latest scan plus the fingerprints that tell when
      // it is stale. Paths, titles and hashes only.
      await db.schema
        .createTable('project_profiles')
        .addColumn('repo_id', 'text', (column) => column.primaryKey().references('repositories.repo_id'))
        .addColumn('profile_json', 'text', (column) => column.notNull())
        .addColumn('fingerprints_json', 'text', (column) => column.notNull())
        .addColumn('scanned_at', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();
    },
  },

  '0010_analysis': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Subagent runs seen through SubagentStart/SubagentStop, and analysts' reports.
      await db.schema
        .createTable('agent_runs')
        .addColumn('agent_id', 'text', (column) => column.primaryKey())
        .addColumn('agent_type', 'text')
        .addColumn('session_id', 'text')
        .addColumn('started_at', 'text', (column) => column.notNull())
        .addColumn('stopped_at', 'text')
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('agent_runs_session').on('agent_runs').columns(['session_id', 'started_at']).execute();

      await db.schema
        .createTable('analysis_reports')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('role', 'text', (column) => column.notNull())
        .addColumn('agent_id', 'text')
        .addColumn('session_id', 'text')
        .addColumn('report_json', 'text', (column) => column.notNull())
        .addColumn('citations_json', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('analysis_reports_task').on('analysis_reports').columns(['task_id', 'id']).execute();
    },
  },

  '0011_task_goal': {
    async up(db: Kysely<unknown>): Promise<void> {
      // The goal of a task taken in before its plan; null for tasks that began with a plan.
      await db.schema.alterTable('tasks').addColumn('goal', 'text').execute();
    },
  },

  '0012_findings': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Quality findings with their status history, and the check batches that produced them.
      // Evidence holds the offending line only, never whole files.
      await db.schema
        .createTable('findings')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.references('tasks.task_id'))
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('file', 'text', (column) => column.notNull())
        .addColumn('rule_id', 'text', (column) => column.notNull())
        .addColumn('rule_version', 'text', (column) => column.notNull())
        .addColumn('fingerprint', 'text', (column) => column.notNull())
        .addColumn('source', 'text', (column) => column.notNull())
        .addColumn('category', 'text', (column) => column.notNull())
        .addColumn('severity', 'text', (column) => column.notNull())
        .addColumn('confidence', 'real', (column) => column.notNull())
        .addColumn('line_start', 'integer', (column) => column.notNull())
        .addColumn('line_end', 'integer', (column) => column.notNull())
        .addColumn('title', 'text', (column) => column.notNull())
        .addColumn('evidence', 'text', (column) => column.notNull())
        .addColumn('why', 'text', (column) => column.notNull())
        .addColumn('fix', 'text', (column) => column.notNull())
        .addColumn('plan_related', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('status', 'text', (column) => column.notNull())
        .addColumn('status_reason', 'text', (column) => column.notNull().defaultTo(''))
        .addColumn('session_id', 'text')
        .addColumn('agent_id', 'text')
        .addColumn('fed_back_at', 'text')
        .addColumn('first_seen_at', 'text', (column) => column.notNull())
        .addColumn('last_seen_at', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('findings_identity').unique().on('findings').columns(['repo_root', 'task_id', 'file', 'rule_id', 'fingerprint']).execute();
      await db.schema.createIndex('findings_task_status').on('findings').columns(['task_id', 'status']).execute();

      await db.schema
        .createTable('finding_events')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('finding_id', 'integer', (column) => column.notNull().references('findings.id'))
        .addColumn('from_status', 'text')
        .addColumn('to_status', 'text', (column) => column.notNull())
        .addColumn('actor', 'text', (column) => column.notNull())
        .addColumn('reason', 'text', (column) => column.notNull())
        .addColumn('at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('finding_events_finding').on('finding_events').columns(['finding_id', 'id']).execute();

      await db.schema
        .createTable('quality_batches')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text')
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text')
        .addColumn('files_json', 'text', (column) => column.notNull())
        .addColumn('started_at', 'text', (column) => column.notNull())
        .addColumn('duration_ms', 'integer', (column) => column.notNull())
        .addColumn('new_count', 'integer', (column) => column.notNull())
        .addColumn('fixed_count', 'integer', (column) => column.notNull())
        .addColumn('error', 'text')
        .execute();
    },
  },

  '0013_test_runs': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Test commands Claude ran and how they ended: the command as recorded (redacted),
      // the result and the runner's one-line totals; never the output itself.
      await db.schema
        .createTable('test_runs')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.references('tasks.task_id'))
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text')
        .addColumn('agent_id', 'text')
        .addColumn('event_id', 'text', (column) => column.notNull().unique())
        .addColumn('command', 'text', (column) => column.notNull())
        .addColumn('result', 'text', (column) => column.notNull())
        .addColumn('exit_code', 'integer')
        .addColumn('summary', 'text')
        .addColumn('at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('test_runs_task').on('test_runs').columns(['task_id', 'at']).execute();
    },
  },

  '0014_implementer_assignments': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Up to three implementers per task with disjoint files; a new assignment set
      // releases the previous one.
      await db.schema
        .createTable('implementer_assignments')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('label', 'text', (column) => column.notNull())
        .addColumn('steps_json', 'text', (column) => column.notNull())
        .addColumn('files_json', 'text', (column) => column.notNull())
        .addColumn('agent_id', 'text')
        .addColumn('session_id', 'text')
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('released_at', 'text')
        .execute();
      await db.schema.createIndex('implementer_assignments_task').on('implementer_assignments').columns(['task_id', 'released_at']).execute();
    },
  },

  '0015_reviews': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Independent review rounds: what each round had to cover, the reviewers'
      // submissions, which findings each reviewer reported, the fix plan and the outcome.
      await db.schema
        .createTable('review_rounds')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('round', 'integer', (column) => column.notNull())
        .addColumn('started_at', 'text', (column) => column.notNull())
        .addColumn('changed_files_json', 'text', (column) => column.notNull())
        .addColumn('completed_at', 'text')
        .addColumn('completed_by', 'text')
        .addColumn('passed_at', 'text')
        .addColumn('skipped_at', 'text')
        .addColumn('skip_reason', 'text')
        .addColumn('fix_plan_json', 'text')
        .addColumn('fix_plan_hash', 'text')
        .addColumn('fixes_approved_at', 'text')
        .addColumn('fixes_reported_at', 'text')
        .addColumn('fixes_summary', 'text')
        .execute();
      await db.schema.createIndex('review_rounds_task').unique().on('review_rounds').columns(['task_id', 'round']).execute();

      await db.schema
        .createTable('review_submissions')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('round', 'integer', (column) => column.notNull())
        .addColumn('role', 'text', (column) => column.notNull())
        .addColumn('agent_id', 'text')
        .addColumn('session_id', 'text')
        .addColumn('files_reviewed_json', 'text', (column) => column.notNull())
        .addColumn('summary', 'text', (column) => column.notNull())
        .addColumn('gaps_json', 'text', (column) => column.notNull())
        .addColumn('finding_count', 'integer', (column) => column.notNull())
        .addColumn('independent', 'integer', (column) => column.notNull())
        .addColumn('independence_note', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('review_submissions_round').unique().on('review_submissions').columns(['task_id', 'round', 'role']).execute();

      await db.schema
        .createTable('review_finding_sources')
        .addColumn('finding_id', 'integer', (column) => column.notNull().references('findings.id'))
        .addColumn('task_id', 'text', (column) => column.notNull())
        .addColumn('round', 'integer', (column) => column.notNull())
        .addColumn('role', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('review_finding_sources_key').unique().on('review_finding_sources').columns(['finding_id', 'round', 'role']).execute();
    },
  },

  '0016_evals': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Eval runs, the baseline history and human labels for rubric calibration. Kept in
      // JERRY's database, outside any project.
      await db.schema
        .createTable('eval_runs')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('started_at', 'text', (column) => column.notNull())
        .addColumn('finished_at', 'text', (column) => column.notNull())
        .addColumn('jerry_version', 'text', (column) => column.notNull())
        .addColumn('fingerprint_json', 'text', (column) => column.notNull())
        .addColumn('label', 'text', (column) => column.notNull())
        .addColumn('results_json', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema
        .createTable('eval_baselines')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('run_id', 'integer', (column) => column.notNull().references('eval_runs.id'))
        .addColumn('note', 'text', (column) => column.notNull())
        .addColumn('set_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema
        .createTable('eval_labels')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('run_id', 'integer', (column) => column.notNull().references('eval_runs.id'))
        .addColumn('case_id', 'text', (column) => column.notNull())
        .addColumn('attempt', 'integer', (column) => column.notNull())
        .addColumn('rubric_id', 'text', (column) => column.notNull())
        .addColumn('human_passed', 'integer', (column) => column.notNull())
        .addColumn('grader_passed', 'integer', (column) => column.notNull())
        .addColumn('score', 'real')
        .addColumn('labeled_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('eval_labels_key').unique().on('eval_labels').columns(['run_id', 'case_id', 'attempt', 'rubric_id']).execute();
    },
  },

  '0017_artifact_decisions': {
    async up(db: Kysely<unknown>): Promise<void> {
      // The user's choice about an Artifact for a task: created by Claude (link only;
      // the Artifact itself is Claude's) or declined. The latest decision of a task counts.
      await db.schema
        .createTable('artifact_decisions')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('decision', 'text', (column) => column.notNull())
        .addColumn('kind', 'text')
        .addColumn('title', 'text')
        .addColumn('url', 'text')
        .addColumn('reason', 'text', (column) => column.notNull().defaultTo(''))
        .addColumn('session_id', 'text')
        .addColumn('created_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('artifact_decisions_task').on('artifact_decisions').columns(['task_id', 'id']).execute();
    },
  },

  '0018_projects': {
    async up(db: Kysely<unknown>): Promise<void> {
      // The repositories the user added: JERRY monitors only these; elsewhere only hard rules apply.
      // repo_root is the Git working tree root as found on disk (original case).
      await db.schema
        .createTable('projects')
        .addColumn('repo_root', 'text', (column) => column.primaryKey())
        .addColumn('added_at', 'text', (column) => column.notNull())
        .addColumn('added_by', 'text', (column) => column.notNull())
        .addColumn('note', 'text')
        .execute();

      // Repositories with unfinished work stay monitored after the upgrade. A repository the user
      // had excluded stays unmonitored: that was their decision.
      await sql`
        INSERT INTO projects (repo_root, added_at, added_by, note)
        SELECT DISTINCT repositories.root_path, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', 'had open tasks when projects were introduced'
        FROM repositories
        JOIN tasks ON tasks.repo_id = repositories.repo_id
        WHERE tasks.state NOT IN ('DONE', 'CANCELLED') AND repositories.excluded_at IS NULL
      `.execute(db);
    },
  },

  '0019_optional_review': {
    async up(db: Kysely<unknown>): Promise<void> {
      // A project's own review mode ('optional' or 'required'); null follows the global setting.
      await db.schema.alterTable('projects').addColumn('review_mode', 'text').execute();
      // Accepting an implementation records whether the user sent it to review (1 or 0). Null on other
      // decisions and on acceptances made before review became optional, which always went to review.
      await db.schema.alterTable('approvals').addColumn('review', 'integer').execute();
    },
  },

  '0020_usage': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Claude usage, kept only for sessions in projects (plan limits are account-wide and name no
      // session or path). Text columns of the unique keys use '' for "unknown": SQLite treats NULLs
      // as distinct, which would break the additive upserts.

      // Claude Code's OpenTelemetry metrics, summed per minute: tokens per type, and the cost
      // (token_type 'cost', tokens 0).
      await db.schema
        .createTable('usage_tokens')
        .addColumn('bucket_minute', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text', (column) => column.notNull())
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('model', 'text', (column) => column.notNull())
        .addColumn('token_type', 'text', (column) => column.notNull())
        .addColumn('query_source', 'text', (column) => column.notNull())
        .addColumn('tokens', 'real', (column) => column.notNull().defaultTo(0))
        .addColumn('cost_usd', 'real', (column) => column.notNull().defaultTo(0))
        .addColumn('entrypoint', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('usage_tokens_key').unique().on('usage_tokens').columns(['bucket_minute', 'session_id', 'model', 'token_type', 'query_source']).execute();
      await db.schema.createIndex('usage_tokens_session').on('usage_tokens').column('session_id').execute();

      // Plan limits as the status line read them (account-wide: no session, no path).
      await db.schema
        .createTable('usage_limits')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('at', 'text', (column) => column.notNull())
        .addColumn('five_hour_pct', 'real')
        .addColumn('five_hour_resets_at', 'text')
        .addColumn('seven_day_pct', 'real')
        .addColumn('seven_day_resets_at', 'text')
        .addColumn('entrypoint', 'text')
        .execute();
      await db.schema.createIndex('usage_limits_at').on('usage_limits').column('at').execute();

      // The status line's snapshot of a project session: the latest per session and minute.
      await db.schema
        .createTable('usage_snapshots')
        .addColumn('bucket_minute', 'text', (column) => column.notNull())
        .addColumn('at', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text', (column) => column.notNull())
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('model', 'text')
        .addColumn('cost_usd', 'real')
        .addColumn('input_tokens', 'real')
        .addColumn('output_tokens', 'real')
        .addColumn('context_used_pct', 'real')
        .addColumn('entrypoint', 'text')
        .addColumn('version', 'text')
        .execute();
      await db.schema.createIndex('usage_snapshots_key').unique().on('usage_snapshots').columns(['session_id', 'bucket_minute']).execute();
      await db.schema.createIndex('usage_snapshots_at').on('usage_snapshots').column('at').execute();

      // Characters JERRY put into Claude's context (session start, warnings and feedback, MCP answers), per minute.
      await db.schema
        .createTable('usage_jerry_share')
        .addColumn('bucket_minute', 'text', (column) => column.notNull())
        .addColumn('session_id', 'text', (column) => column.notNull())
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('kind', 'text', (column) => column.notNull())
        .addColumn('chars', 'integer', (column) => column.notNull().defaultTo(0))
        .addColumn('count', 'integer', (column) => column.notNull().defaultTo(0))
        .execute();
      await db.schema.createIndex('usage_jerry_share_key').unique().on('usage_jerry_share').columns(['bucket_minute', 'session_id', 'kind']).execute();
    },
  },

  '0021_session_entrypoint': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Where the session runs (cli, claude-vscode, …), as the bridge read it from Claude Code's
      // environment at SessionStart. Null for sessions registered before, or without it.
      await db.schema.alterTable('sessions').addColumn('entrypoint', 'text').execute();
    },
  },

  '0022_skills': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Claude Code skills the user added through JERRY (CLAUDE_CONFIG_DIR/skills/<name>). A row
      // means JERRY installed that folder, so it may update, switch or remove it; a folder without
      // a row is the user's own and is never touched. Contents are not stored: only file hashes.
      await db.schema
        .createTable('skills')
        .addColumn('name', 'text', (column) => column.primaryKey())
        .addColumn('description', 'text', (column) => column.notNull())
        .addColumn('source_kind', 'text', (column) => column.notNull())
        .addColumn('source', 'text', (column) => column.notNull())
        .addColumn('ref', 'text')
        .addColumn('commit_sha', 'text')
        .addColumn('content_hash', 'text', (column) => column.notNull())
        .addColumn('files_json', 'text', (column) => column.notNull())
        .addColumn('scan_json', 'text', (column) => column.notNull())
        .addColumn('enabled', 'integer', (column) => column.notNull().defaultTo(1))
        .addColumn('installed_at', 'text', (column) => column.notNull())
        .addColumn('updated_at', 'text', (column) => column.notNull())
        .execute();

      // What happened to a skill (installed, updated, enabled, disabled, removed), kept after removal.
      await db.schema
        .createTable('skill_events')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('name', 'text', (column) => column.notNull())
        .addColumn('action', 'text', (column) => column.notNull())
        .addColumn('channel', 'text', (column) => column.notNull())
        .addColumn('details_json', 'text', (column) => column.notNull())
        .addColumn('at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('skill_events_name').on('skill_events').column('name').execute();
    },
  },

  '0023_skill_states': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Added skills are started only by JERRY: the workflow states the user assigned a skill to
      // (a JSON array), and whether its SKILL.md already carries JERRY's "user-invocable: false".
      // Rows from before start with no states and unconverted; assigning states converts them.
      await db.schema.alterTable('skills').addColumn('states_json', 'text', (column) => column.notNull().defaultTo('[]')).execute();
      await db.schema.alterTable('skills').addColumn('jerry_triggered', 'integer', (column) => column.notNull().defaultTo(0)).execute();
    },
  },

  '0024_workspaces': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Several repositories under one name the user chose. A grouping only: each repository stays
      // its own project with its own tasks; a repository belongs to at most one workspace.
      await db.schema
        .createTable('workspaces')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('name', 'text', (column) => column.notNull())
        .addColumn('name_key', 'text', (column) => column.notNull().unique())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addColumn('created_by', 'text', (column) => column.notNull())
        .execute();
      await db.schema
        .createTable('workspace_repos')
        .addColumn('workspace_id', 'integer', (column) => column.notNull().references('workspaces.id').onDelete('cascade'))
        .addColumn('repo_root', 'text', (column) => column.notNull())
        .addColumn('repo_key', 'text', (column) => column.notNull().unique())
        .addColumn('added_at', 'text', (column) => column.notNull())
        .execute();
      await db.schema.createIndex('workspace_repos_workspace').on('workspace_repos').column('workspace_id').execute();
    },
  },

  '0025_plan_repositories': {
    async up(db: Kysely<unknown>): Promise<void> {
      // A plan across several repositories of a workspace: the other repositories of a plan
      // version, each with its own scope. The task's own repository keeps plans.scope_json; plans
      // of one repository have no rows here.
      await db.schema
        .createTable('plan_repositories')
        .addColumn('task_id', 'text', (column) => column.notNull().references('tasks.task_id'))
        .addColumn('version', 'integer', (column) => column.notNull())
        .addColumn('repo_id', 'text', (column) => column.notNull().references('repositories.repo_id'))
        .addColumn('root_path', 'text', (column) => column.notNull())
        .addColumn('scope_json', 'text', (column) => column.notNull())
        .addColumn('exclude_json', 'text', (column) => column.notNull())
        .addColumn('created_at', 'text', (column) => column.notNull())
        .addPrimaryKeyConstraint('plan_repositories_pk', ['task_id', 'version', 'repo_id'])
        .execute();
      await db.schema.createIndex('plan_repositories_repo').on('plan_repositories').column('repo_id').execute();
      // Snapshots are now read per repository of a task.
      await db.schema.createIndex('git_snapshots_task_repo').on('git_snapshots').columns(['task_id', 'repo_root', 'kind', 'id']).execute();
    },
  },

  '0026_task_analysts': {
    async up(db: Kysely<unknown>): Promise<void> {
      // The analysts JERRY suggested at intake, sized to the kind of change ({ roles, reasons } as
      // JSON); null for tasks taken in before sizing (they expect all three) and tasks without intake.
      await db.schema.alterTable('tasks').addColumn('analysts_json', 'text').execute();
    },
  },
};
