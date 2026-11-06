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
};
