import type * as NodeSqlite from 'node:sqlite';
import type { SqliteDatabase, SqliteStatement } from 'kysely';

export type SqliteModule = typeof NodeSqlite;
export type DatabaseSync = NodeSqlite.DatabaseSync;

let loaded: SqliteModule | null = null;

/**
 * Loads the built-in node:sqlite module. It is marked experimental in Node 22 and
 * prints an ExperimentalWarning on load; that one warning is filtered so it does not pollute
 * core.log, every other warning is still printed. Loading lazily keeps the filter in front of it.
 */
export async function loadSqlite(): Promise<SqliteModule> {
  if (loaded !== null) return loaded;
  const previous = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
    for (const listener of previous) listener(warning);
  });
  loaded = await import('node:sqlite');
  return loaded;
}

/**
 * Presents node:sqlite's DatabaseSync through the interface Kysely's SqliteDialect expects
 * (the better-sqlite3 shape). This adapter is the only place that depends on node:sqlite's API.
 */
export function asKyselyDatabase(database: DatabaseSync): SqliteDatabase {
  return {
    close: () => database.close(),
    prepare: (sql: string): SqliteStatement => {
      const statement = database.prepare(sql);
      return {
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...(parameters as NodeSqlite.SQLInputValue[])),
        run: (parameters) => statement.run(...(parameters as NodeSqlite.SQLInputValue[])),
        iterate: (parameters) => statement.iterate(...(parameters as NodeSqlite.SQLInputValue[])) as IterableIterator<unknown>,
      };
    },
  };
}
