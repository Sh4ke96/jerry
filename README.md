# JERRY

A local agent harness and development guardian for Claude Code and VS Code.
**One installation. Every project. Zero project footprint.**

This repository contains the source of JERRY itself. The zero-footprint requirement applies to the user's
repositories, not to this one.

**Status:** M0 feasibility spike. Results and known gaps: [docs/spikes/M0-feasibility.md](docs/spikes/M0-feasibility.md).

## What works in M0

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
- `jerry` CLI: `install`, `uninstall`, `doctor`, `core start|stop|status`, `task`, `plan revise`,
  `approve`/`reject`, `repo exclude|include|list` (approve, reject and exclude require an interactive terminal).

## Layout

```text
apps/core               JERRY Core (HTTP API, state, gate decisions)
apps/hook-bridge        Claude Code hook adapter → Core (bundled into the plugin)
apps/cli                jerry CLI
packages/contracts      Zod schemas shared across processes
packages/platform       JERRY_HOME, Core client, claude.exe discovery, atomic writes, home safety
packages/policy-engine  pure gate logic: paths, shell classification, approvals
claude-plugin/          static plugin files (manifest, hooks.json)
tests/                  integration (bridge + Core) and install E2E
scripts/                build, hook benchmark, live Claude Code check
docs/                   spikes and architecture decision records (ADR)
```

## Development

Requires Node ≥ 22.12 and corepack (pnpm is fetched by corepack; no global install needed).

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
- Commit, push and merge only with explicit approval.
- READMEs, code comments and ADRs are written in English.
