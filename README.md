# JERRY

A local agent harness and development guardian for Claude Code and VS Code.
**One installation. Every project. Zero project footprint.**

This repository contains the source of JERRY itself. The zero-footprint requirement applies to the user's
repositories, not to this one.

**Status:** M1 Core Foundation complete ([report](docs/milestones/M1-core-foundation.md)). M0 spike:
[docs/spikes/M0-feasibility.md](docs/spikes/M0-feasibility.md).

## What works

- A Claude Code plugin (`claude-plugin/`) with `SessionStart` and `PreToolUse` hooks
  (Write/Edit/MultiEdit/NotebookEdit/Bash/PowerShell/Monitor).
- JERRY Core: a local HTTP process on `127.0.0.1` with a per-start token. It stores tasks, versioned plans
  (content hash) and approvals in `JERRY_HOME`.
- Monitoring, not blocking ([ADR 0003](docs/decisions/0003-monitor-not-block.md)): edits without an approved
  plan, or outside the approved plan's scope, proceed but are recorded as deviations, and Claude and the user
  are warned.
- Hard rules, always blocked, also while Core is down: Git state changes through shell commands or Git-server
  MCP tools (the user does all Git operations), writes inside `.git`, tampering with JERRY data or the Claude
  Code settings that enable it.
- `jerry repo exclude <path>` turns monitoring off for a repository; hard rules still apply there.
- Core starts automatically from Claude Code sessions and listens on `127.0.0.1:47823` (`JERRY_CORE_PORT`);
  `jerry core stop` pauses it until `jerry core start` ([ADR 0004](docs/decisions/0004-core-autostart-fixed-port.md)).
- JERRY never modifies any repository ([ADR 0002](docs/decisions/0002-jerry-never-modifies-repositories.md)).
- State in SQLite (`JERRY_HOME/database/jerry.sqlite`) with in-code migrations, a backup before every migration,
  automatic restore when a migration fails, and full plan history ([ADR 0005](docs/decisions/0005-sqlite-node-builtin-kysely.md)).
- Session events (prompts by size only, tool calls and results, subagents, stop, session end) with redaction,
  a spool while Core is down, and 90-day retention ([ADR 0006](docs/decisions/0006-session-events-spool-retention.md)).
- Local API on Fastify: bearer token for the CLI and hooks; `jerry ui` signs the browser in with a one-time link,
  with CSRF and Origin checks for the dashboard ([ADR 0007](docs/decisions/0007-local-api-fastify-browser-sessions.md)).
- `/jerry:plan`: Claude studies the repository, drafts the full plan (spec §7.2) and submits it with
  `jerry_submit_plan`; you approve the exact document in the dashboard or CLI
  ([ADR 0011](docs/decisions/0011-plans-submitted-by-claude.md)).
- JERRY Control Center at `http://127.0.0.1:47823` (open it with `jerry ui`): overview, plans with approve and
  reject, session timeline, repositories; installable as an app ([ADR 0009](docs/decisions/0009-dashboard.md)).
- MCP server in the plugin with read-only tools that give Claude the live plan state, path checks and recorded
  deviations; nothing in it can approve ([ADR 0008](docs/decisions/0008-local-mcp-server.md)).
- `jerry status` (quick summary) and `jerry doctor` (full diagnostics); the hook bridge loads no heavy
  dependencies, about 30 ms per guarded call ([ADR 0010](docs/decisions/0010-fast-bridge-cli-doctor.md)).
- `jerry` CLI (Commander, `jerry --help`): `install`, `uninstall`, `doctor`, `ui`, `core start|stop|status`, `task`, `plan revise`,
  `approve`/`reject`, `repo exclude|include|list`, `events`, `db backup|backups|restore` (approve, reject,
  exclude and restore require an interactive terminal).

## Layout

```text
apps/core               JERRY Core (HTTP API, state, gate decisions)
apps/hook-bridge        Claude Code hook adapter → Core (bundled into the plugin)
apps/mcp-server         read-only MCP server for Claude (bundled into the plugin)
apps/dashboard          JERRY Control Center (Vue 3, TSX, Vite), served by Core
apps/cli                jerry CLI
packages/contracts      Zod schemas shared across processes
packages/database       SQLite (node:sqlite + Kysely): schema, migrations, backup and restore
packages/platform       JERRY_HOME, Core client, claude.exe discovery, atomic writes, home safety
packages/policy-engine  pure gate logic: paths, shell classification, approvals
packages/trace-engine   event envelopes, data minimization and redaction
claude-plugin/          static plugin files (manifest, hooks.json)
tests/                  integration (bridge + Core) and install E2E
scripts/                build, hook benchmark, live Claude Code check
docs/                   spikes and architecture decision records (ADR)
```

## Development

Requires Node ≥ 22.13 (built-in `node:sqlite`) and corepack (pnpm is fetched by corepack; no global install needed).

```powershell
corepack pnpm install
corepack pnpm build          # dist/plugin, dist/core, dist/cli
corepack pnpm check          # typecheck + all tests
node dist/cli/jerry.mjs help
```

Install tests use an isolated `CLAUDE_CONFIG_DIR` and assert that the real `~/.claude` does not change.
`scripts/e2e-live.mjs` runs real Claude Code sessions on the signed-in account (haiku model) with the plugin
loaded through `--plugin-dir`, without changing any settings.

## Working rules

- The specification is the source of requirements; changes need a rationale and a version (ADR in `docs/decisions/`).
- Do not start the next phase before the critical tests of the current one pass.
- No real Claude Code OAuth tokens in tests or code; no external telemetry.
- No secret-shaped literals in the source, not even fake ones: the repository is scanned by GitGuardian.
  Tests assemble credential-like fixtures from fragments at runtime (see `packages/trace-engine/test/events.test.ts`).
- Commit, push and merge only with explicit approval.
- READMEs, code comments and ADRs are written in English.
