# ADR 0005 — JERRY state in SQLite through node:sqlite and Kysely

- **Status:** accepted (product-owner decision, M1 item 3)
- **Date:** 2026-11-06
- **Affects:** spec §4.3 (stack: "SQLite", "Drizzle ORM or Kysely"), §17 (data model), backlog M1 "SQLite + migrations", "Backup/restore"

## Context

M0 kept Core state in one JSON file. Spec §17 requires SQLite with versioned migrations, backups before
migrations, and a return to the last backup when a migration fails.

Core ships as a single bundled file, is copied into `JERRY_HOME/runtime`, and is started by the hooks with
whatever `node` is on `PATH` (ADR 0004). A native SQLite driver (`better-sqlite3`) would need a compiled
binary next to the bundle, built for one Node ABI: after a Node upgrade Core would no longer start, and
autostart would fail silently until the next `jerry install`.

## Decision

- **Driver:** Node's built-in `node:sqlite` (SQLite 3.51 in Node 22.22). No native binaries; Core stays one file.
  It is marked experimental in Node 22, so it is used only through a small adapter
  (`packages/database/src/sqlite.ts`) that presents it to Kysely; an API change touches that one file. The
  single `ExperimentalWarning` it prints on load is filtered so it does not pollute `core.log`.
- **Query layer:** Kysely 0.29 with its SQLite dialect over the adapter. Typed tables in `schema.ts`.
- **Migrations in code** (`migrations.ts`), applied by Kysely's `Migrator` into `schema_migrations`.
  Released migrations are never edited.
- **Safety:**
  - Before pending migrations run on an existing database, an online backup goes to `JERRY_HOME/backups/`.
  - If a migration fails, the database file is replaced by that backup and Core refuses to start.
  - `jerry db backup` (online, through Core), `jerry db backups`, and `jerry db restore <file>`. Restore requires
    Core to be stopped, an interactive terminal and a typed confirmation. It verifies the backup (integrity
    check, JERRY schema) and backs up the current database first. Agents may not run it (hard rule).
  - The 20 newest backups are kept.
- **Pragmas:** WAL journal, foreign keys on, 5 s busy timeout, `synchronous = NORMAL`.
- **Schema 0001:** `repositories`, `tasks`, `plans` (every version kept), `approvals`, `sessions`, `settings`,
  `audit_log` (task creation, plan revisions, approvals, exclusions, imports). Every table has `created_at`, and
  `updated_at` where rows change. Other §17 tables arrive with the features that use them.
- **Reads stay fast:** Core keeps an in-memory snapshot for gate checks and reloads it after each
  mutation transaction. Core is the only writer, so the snapshot cannot go stale.
- **Migration from M0:** on first start, `state/core-state.json` is imported into an empty database in one
  transaction, and the file is kept as `core-state.json.imported-<timestamp>`.

## Consequences

- Node ≥ 22.13 is required (`node:sqlite` without a flag); `package.json` `engines` says so.
- If `node:sqlite` changes its API in a later Node release, the adapter needs an update; the tests cover it directly.
- The gate log (`logs/gate-decisions.jsonl`) is still a file; it moves into the database with the event model (M1 item 4).
