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
      // The full plan (spec §7.2) when Claude submitted one; NULL for scope-only plans.
      await db.schema.alterTable('plans').addColumn('document_json', 'text').execute();
    },
  },

  '0004_workflow': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Task state (spec §7.1); Core changes it only through the workflow transition table.
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

      // Which session worked on which task (ADR 0013). No foreign key to sessions: retention removes
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
      // through the approvals table, stage IMPLEMENTATION (ADR 0014).
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
      // Every run of Core's final checks (ADR 0016): DONE is set only when one passed.
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
};
