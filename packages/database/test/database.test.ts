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
      expect.arrayContaining(['approvals', 'audit_log', 'hook_events', 'plans', 'repositories', 'schema_migrations', 'sessions', 'settings', 'tasks']),
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
