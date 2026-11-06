# M3 — Repository Discovery: completion report

**Date:** 2026-11-06 · **Environment:** Windows 11 Home 26300, Claude Code 2.1.318 (VS Code extension), Node 22.22.2.
**Task:** JRY-0003, plan v2 (submitted by Claude with `jerry_submit_plan`, approved by the user).

## Backlog checklist

| Backlog item | Status | Where |
|---|---|---|
| Git root resolver | ✅ | since M0 (`apps/core/src/repo-fs.ts`) |
| Git baseline snapshot | ✅ | read-only Git reader, baselines at plan approval, report and checkpoint ([ADR 0017](../decisions/0017-git-baseline.md)) |
| Uncommitted changes inventory | ✅ | the user's dirty files at approval; warning when Claude edits one ([ADR 0017](../decisions/0017-git-baseline.md)) |
| Language/framework detectors | ✅ | [ADR 0018](../decisions/0018-repository-scanner.md) |
| Manifest/lockfile detection | ✅ | [ADR 0018](../decisions/0018-repository-scanner.md) |
| Documentation indexer | ✅ | paths, titles, hashes ([ADR 0019](../decisions/0019-docs-instructions-injection.md)) |
| Project instructions inventory | ✅ | rules vs config, with notes on hooks, permissions, MCP servers ([ADR 0019](../decisions/0019-docs-instructions-injection.md)) |
| Existing tests/build/lint detection | ✅ | the project's commands with their source; corepack-aware `run` form ([ADR 0018](../decisions/0018-repository-scanner.md), [ADR 0020](../decisions/0020-project-profile.md)) |
| API schema detection | ✅ | OpenAPI (header-confirmed), GraphQL, proto ([ADR 0018](../decisions/0018-repository-scanner.md)) |
| Database migration detection | ✅ | Prisma, Laravel, Django, Alembic, Rails, Flyway, EF Core, SQL/JS ([ADR 0018](../decisions/0018-repository-scanner.md)) |
| Multi-repo workspace graph | ✅ | local-path, package and API-contract links with evidence ([ADR 0021](../decisions/0021-workspace-graph.md)) |
| Project profile storage outside project | ✅ | JERRY's database ([ADR 0020](../decisions/0020-project-profile.md)) |
| Profile freshness invalidation | ✅ | per-part fingerprints, format version, 24 h ([ADR 0020](../decisions/0020-project-profile.md)) |
| Prompt injection handling rules | ✅ | rules vs data in the skills; suspicious-text findings ([ADR 0019](../decisions/0019-docs-instructions-injection.md)) |

## What it changes in daily use

- **Uncommitted work.** When Claude edits a file holding the user's uncommitted changes, JERRY warns once,
  and Claude keeps the user's lines (verified live).
- **Reports and DONE** see what shell commands and generators changed, through Git.
- **Resumed sessions** learn whether HEAD moved since their checkpoint.
- **Commands.** Claude gets the project's own commands from `jerry_get_project_profile`, in the form that runs
  on this machine, instead of guessing them.
- **Dashboard.** It shows each repository's profile, the instruction files with what they do, suspicious text
  in the repository, and the links between repositories.

## Product decisions taken during M3

- Read-only Git only:
  - `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`, no fsmonitor, no shell;
  - credentials stripped from remote URLs;
  - `.git` byte-identical across reads (tested).
- The profile lives in JERRY's database (ADR 0005) rather than a `profiles/` folder. It is a cache, never the
  source of truth.
- Warnings, not blocks: editing the user's uncommitted file, and suspicious repository text. Turning either into
  a block would be a new hard rule, which is the product owner's decision.

## Measurements

- Scan of JERRY's own repository: 157 files, a few hundred milliseconds. Freshness checks are `stat` calls only.
- Hook bridge: 26.6 KiB, still Zod-free.
- Tests: 396 passing. Live Claude Code check (`scripts/e2e-live.mjs`): 48 checks, scenarios A–M, including
  L (the user's changes and a shell-made file) and M (the project profile).

## Known gaps carried forward

- Two hard rules are deliberately broad and caught my own read-only commands during M3:
  - `hard.core-api` fires on any command containing `/api/v1/`, including a `grep` pattern;
  - `hard.git-mutation` fires on a `sed` whose text mentions Git commands.

  Narrowing them needs the product owner's approval.
- Scans run in Core's process. Very large repositories are bounded by the walker's limits; a worker thread is
  possible if needed.
- Runner availability is checked for the first word of each command only.
