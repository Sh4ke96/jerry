import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { afterAll, describe, expect, it } from 'vitest';
import { listBackups, MIGRATIONS, openJerryDatabase, restoreDatabase } from '../src/index.js';

const LATEST = Object.keys(MIGRATIONS).sort().at(-1);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-db-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;
function location(): { file: string; backupsDir: string } {
  counter += 1;
  return { file: path.join(base, `case-${counter}`, 'jerry.sqlite'), backupsDir: path.join(base, `case-${counter}`, 'backups') };
}

const addNotesTable: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.createTable('notes').addColumn('id', 'integer', (column) => column.primaryKey()).addColumn('text', 'text').execute();
  },
};
const failing: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.createTable('half_done').addColumn('id', 'integer').execute();
    throw new Error('simulated migration failure');
  },
};

describe('openJerryDatabase', () => {
  it('creates and migrates a new database without taking a backup', async () => {
    const where = location();
    const database = await openJerryDatabase(where);
    expect(database.migration).toBe(LATEST);
    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.execute(database.db);
    expect(tables.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(['approvals', 'audit_log', 'hook_events', 'implementation_reports', 'plans', 'repositories', 'schema_migrations', 'session_tasks', 'sessions', 'settings', 'task_checkpoints', 'tasks', 'workflow_transitions']),
    );
    await database.close();
    expect(listBackups(where.backupsDir)).toHaveLength(0);
  });

  it('reopens without migrating or backing up when the schema is current', async () => {
    const where = location();
    await (await openJerryDatabase(where)).close();
    const reopened = await openJerryDatabase(where);
    expect(reopened.migration).toBe(LATEST);
    await reopened.close();
    expect(listBackups(where.backupsDir)).toHaveLength(0);
  });

  it('backs up an existing database before applying pending migrations', async () => {
    const where = location();
    await (await openJerryDatabase(where)).close();
    const upgraded = await openJerryDatabase({ ...where, migrations: { ...MIGRATIONS, '9999_notes': addNotesTable } });
    expect(upgraded.migration).toBe('9999_notes');
    await upgraded.close();
    expect(listBackups(where.backupsDir).map((backup) => path.basename(backup.file))).toEqual([expect.stringMatching(/-pre-migration\.sqlite$/)]);
  });

  it('restores the backup when a migration fails, so Core never runs on a half-migrated database', async () => {
    const where = location();
    const first = await openJerryDatabase(where);
    await first.db.insertInto('settings').values({ key: 'marker', value_json: '"before"', created_at: 'x', updated_at: 'x' }).execute();
    await first.close();

    await expect(openJerryDatabase({ ...where, migrations: { ...MIGRATIONS, '9999_broken': failing } })).rejects.toThrow(/simulated migration failure.*Restored/s);

    const again = await openJerryDatabase(where);
    expect(again.migration).toBe(LATEST);
    const marker = await again.db.selectFrom('settings').select('value_json').where('key', '=', 'marker').executeTakeFirst();
    expect(marker?.value_json).toBe('"before"');
    const leftovers = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name = 'half_done'`.execute(again.db);
    expect(leftovers.rows).toHaveLength(0);
    await again.close();
  });

  it('derives the workflow state of existing tasks from their latest plan decision (0004)', async () => {
    const where = location();
    const before = Object.fromEntries(Object.entries(MIGRATIONS).filter(([name]) => name < '0004'));
    const old = await openJerryDatabase({ ...where, migrations: before });
    const at = '2026-01-01T00:00:00.000Z';
    await sql`INSERT INTO repositories (repo_id, root_path, created_at, updated_at) VALUES ('repo_1', 'D:/repo', ${at}, ${at})`.execute(old.db);
    const tasks: Array<[string, number]> = [['JRY-0001', 1], ['JRY-0002', 1], ['JRY-0003', 2], ['JRY-0004', 1]];
    for (const [taskId, version] of tasks) {
      await sql`INSERT INTO tasks (task_id, title, repo_id, current_plan_version, created_at, updated_at) VALUES (${taskId}, 't', 'repo_1', ${version}, ${at}, ${at})`.execute(old.db);
      for (let v = 1; v <= version; v += 1) {
        await sql`INSERT INTO plans (task_id, version, content_hash, scope_json, created_at) VALUES (${taskId}, ${v}, ${`sha256:${taskId}-${v}`}, '[]', ${at})`.execute(old.db);
      }
    }
    const decide = (id: string, taskId: string, version: number, decision: string, when: string) =>
      sql`INSERT INTO approvals (approval_id, task_id, stage, version, content_hash, decision, approved_by, approved_at, comment, created_at) VALUES (${id}, ${taskId}, 'PLAN', ${version}, ${`sha256:${taskId}-${version}`}, ${decision}, 'local-user', ${when}, '', ${when})`.execute(old.db);
    await decide('a1', 'JRY-0001', 1, 'APPROVED', '2026-01-02T00:00:00.000Z'); // approved
    await decide('a2', 'JRY-0002', 1, 'APPROVED', '2026-01-02T00:00:00.000Z');
    await decide('a3', 'JRY-0002', 1, 'REJECTED', '2026-01-03T00:00:00.000Z'); // approval withdrawn
    await decide('a4', 'JRY-0003', 1, 'APPROVED', '2026-01-02T00:00:00.000Z'); // approved v1, revised to v2
    await old.close();

    const upgraded = await openJerryDatabase(where);
    const states = await upgraded.db.selectFrom('tasks').select(['task_id', 'state']).orderBy('task_id').execute();
    expect(states).toEqual([
      { task_id: 'JRY-0001', state: 'IMPLEMENTATION' },
      { task_id: 'JRY-0002', state: 'PLAN_DRAFT' },
      { task_id: 'JRY-0003', state: 'WAIT_PLAN_APPROVAL' },
      { task_id: 'JRY-0004', state: 'WAIT_PLAN_APPROVAL' },
    ]);
    await upgraded.close();
  });

  it('distinguishes reading and writing statements through the node:sqlite adapter', async () => {
    const database = await openJerryDatabase(location());
    const inserted = await database.db
      .insertInto('settings')
      .values({ key: 'k', value_json: '1', created_at: 'a', updated_at: 'a' })
      .returning(['key', 'value_json'])
      .executeTakeFirst();
    expect(inserted).toEqual({ key: 'k', value_json: '1' });
    const updated = await database.db.updateTable('settings').set({ value_json: '2' }).where('key', '=', 'k').executeTakeFirst();
    expect(Number(updated.numUpdatedRows)).toBe(1);
    expect(await database.db.selectFrom('settings').selectAll().execute()).toHaveLength(1);
    await database.close();
  });
});

describe('restoreDatabase', () => {
  it('replaces the database with a verified backup and keeps a safety copy of the current one', async () => {
    const where = location();
    const database = await openJerryDatabase(where);
    await database.db.insertInto('settings').values({ key: 'state', value_json: '"A"', created_at: 'x', updated_at: 'x' }).execute();
    const { backupDatabase } = await import('../src/index.js');
    const backup = await backupDatabase(database.raw, where.backupsDir, 'manual');
    await database.db.updateTable('settings').set({ value_json: '"B"' }).where('key', '=', 'state').execute();
    await database.close();

    const { safetyBackup } = await restoreDatabase({ ...where, backupFile: backup });
    expect(safetyBackup).toMatch(/-pre-restore\.sqlite$/);

    const restored = await openJerryDatabase(where);
    expect((await restored.db.selectFrom('settings').select('value_json').where('key', '=', 'state').executeTakeFirst())?.value_json).toBe('"A"');
    await restored.close();
  });

  it('refuses a file that is not a JERRY database', async () => {
    const where = location();
    const notJerry = path.join(base, 'other.sqlite');
    const { loadSqlite } = await import('../src/index.js');
    const sqlite = await loadSqlite();
    const other = new sqlite.DatabaseSync(notJerry);
    other.exec('CREATE TABLE x (id INTEGER)');
    other.close();
    await expect(restoreDatabase({ ...where, backupFile: notJerry })).rejects.toThrow(/not a JERRY database/);
  });
});
