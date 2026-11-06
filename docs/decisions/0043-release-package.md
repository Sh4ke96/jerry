# ADR 0043 — Versioned release package, update and rollback

- **Status:** accepted (M8 steps 3–4, task JRY-0008)
- **Date:** 2026-11-06
- **Affects:** roadmap M8 "Versioned release package", "Update and rollback tests"; ADR 0005 (backups before
  migrations)

## Decision

- **Version 0.1.0** is the first release (the plan's proposal). `JERRY_VERSION` and the plugin manifest must
  match; the release script refuses otherwise.
- **`pnpm release`** (`scripts/release.mjs`) builds, then writes `dist/release/jerry-<version>/`:
  - `cli`, `core` (with the dashboard), `plugin` and `evals`, without source maps or eval results;
  - `manifest.json`: name, version, build time, Node requirement, and every file with size and SHA-256;
  - `SHA256SUMS` in the common format;
  - `RELEASE-NOTES.md`: included milestones, install, update and rollback steps.

  It also writes `jerry-<version>.tar.gz` with its `.sha256`. `dist/` is ignored by Git, so nothing enters
  the repository.
- **Install, update and rollback** are the same command: `node <package>/cli/jerry.mjs install`. Data stays in
  JERRY_HOME, and the database is backed up before every migration. Rolling back means installing the previous
  package. Older Cores read a newer database through the tables they know, and `jerry db restore` brings back
  a pre-migration backup if needed.
- **Tested end to end** (`tests/e2e/update-rollback.test.ts`), through the official Claude Code CLI against an
  isolated profile:
  1. install package A, create a task;
  2. install package B (stamped as a newer version): the task is kept, Core runs B, the guard stays on;
  3. install A again: the task is kept, Core runs A, the guard stays on;
  4. uninstall: the data is kept.
- No code signing yet; the packages are built locally (security audit F10).
