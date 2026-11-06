import fs from 'node:fs';
import path from 'node:path';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import { MIGRATIONS } from './migrations.js';
import type { JerrySchema } from './schema.js';
import { asKyselyDatabase, loadSqlite, type DatabaseSync } from './sqlite.js';

export const MIGRATION_TABLE = 'schema_migrations';
export const MIGRATION_LOCK_TABLE = 'schema_migrations_lock';
/** Backups kept in JERRY_HOME/backups: at most this many and this many bytes; the newest one always stays. */
export const BACKUPS_TO_KEEP = 20;
export const BACKUPS_MAX_BYTES = 512 * 1024 * 1024;

export interface JerryDatabase {
  db: Kysely<JerrySchema>;
  raw: DatabaseSync;
  file: string;
  backupsDir: string;
  /** Name of the latest applied migration. */
  migration: string | null;
  close(): Promise<void>;
}

export interface OpenOptions {
  file: string;
  backupsDir: string;
  /** Injected by tests; production always uses MIGRATIONS. */
  migrations?: Readonly<Record<string, Migration>>;
}

/**
 * Opens (or creates) the database and migrates it to the latest schema. An existing database is
 * backed up before pending migrations run; if a migration fails, the backup is restored and the
 * error is rethrown, so Core never starts on a half-migrated database.
 */
export async function openJerryDatabase(options: OpenOptions): Promise<JerryDatabase> {
  const sqlite = await loadSqlite();
  fs.mkdirSync(path.dirname(options.file), { recursive: true });
  const existed = fs.existsSync(options.file) && fs.statSync(options.file).size > 0;

  const raw = new sqlite.DatabaseSync(options.file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const db = new Kysely<JerrySchema>({ dialect: new SqliteDialect({ database: asKyselyDatabase(raw) }) });

  const migrations = options.migrations ?? MIGRATIONS;
  const migrator = new Migrator({
    db,
    provider: { getMigrations: async () => ({ ...migrations }) },
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
  });

  const pending = (await migrator.getMigrations()).filter((migration) => migration.executedAt === undefined);
  const backupFile = existed && pending.length > 0 ? await backupDatabase(raw, options.backupsDir, 'pre-migration') : null;

  const { error } = await migrator.migrateToLatest();
  if (error !== undefined) {
    await db.destroy();
    if (backupFile !== null) replaceDatabaseFile(options.file, backupFile);
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Database migration failed (${cause}).${backupFile === null ? '' : ` Restored ${backupFile}.`}`, { cause: error });
  }

  const applied = (await migrator.getMigrations()).filter((migration) => migration.executedAt !== undefined);
  return {
    db,
    raw,
    file: options.file,
    backupsDir: options.backupsDir,
    migration: applied.at(-1)?.name ?? null,
    close: () => db.destroy(),
  };
}

/** Online backup of an open database (consistent while Core keeps running). Returns the backup path. */
export async function backupDatabase(raw: DatabaseSync, backupsDir: string, label: string): Promise<string> {
  const sqlite = await loadSqlite();
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, `jerry-${stamp}-${label.replace(/[^a-z0-9-]/gi, '')}.sqlite`);
  await sqlite.backup(raw, target);
  pruneBackups(backupsDir);
  return target;
}

export function listBackups(backupsDir: string): Array<{ file: string; size: number; modifiedAt: string }> {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((name) => /^jerry-.*\.sqlite$/.test(name))
    .map((name) => {
      const file = path.join(backupsDir, name);
      const stat = fs.statSync(file);
      return { file, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function pruneBackups(backupsDir: string, maxCount = BACKUPS_TO_KEEP, maxBytes = BACKUPS_MAX_BYTES): void {
  const newestFirst = listBackups(backupsDir).reverse();
  let total = 0;
  newestFirst.forEach((backup, index) => {
    total += backup.size;
    if (index > 0 && (index >= maxCount || total > maxBytes)) fs.rmSync(backup.file, { force: true });
  });
}

/**
 * Replaces the database with a backup. Core must not be running. The backup is verified first and
 * the current database is itself backed up, so a restore can always be undone.
 */
export async function restoreDatabase(options: { file: string; backupsDir: string; backupFile: string }): Promise<{ safetyBackup: string | null }> {
  const sqlite = await loadSqlite();
  const candidate = new sqlite.DatabaseSync(options.backupFile, { readOnly: true });
  try {
    const integrity = candidate.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    if (integrity?.integrity_check !== 'ok') throw new Error(`${options.backupFile} failed the SQLite integrity check`);
    const hasMigrations = candidate.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${MIGRATION_TABLE}'`).get();
    if (hasMigrations === undefined) throw new Error(`${options.backupFile} is not a JERRY database`);
  } finally {
    candidate.close();
  }

  let safetyBackup: string | null = null;
  if (fs.existsSync(options.file)) {
    const current = new sqlite.DatabaseSync(options.file);
    try {
      current.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      safetyBackup = await backupDatabase(current, options.backupsDir, 'pre-restore');
    } finally {
      current.close();
    }
  }
  replaceDatabaseFile(options.file, options.backupFile);
  return { safetyBackup };
}

/** Swaps the database file; stale WAL/SHM files must go, or SQLite would replay them onto the backup. */
function replaceDatabaseFile(file: string, source: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  fs.copyFileSync(source, file);
}
