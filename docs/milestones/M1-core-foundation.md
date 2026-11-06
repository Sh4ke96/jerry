# M1 — Core Foundation: completion report

**Date:** 2026-11-06 · **Environment:** Windows 11 Home 26300, Claude Code 2.1.318 (VS Code extension), Node 22.22.2.

## Backlog checklist

| Backlog item | Status | Where |
|---|---|---|
| TypeScript workspace, strict compiler settings | ✅ | pnpm workspace, TypeScript 7 strict, `noUncheckedIndexedAccess` |
| CLI bootstrap | ✅ | Commander CLI ([ADR 0010](../decisions/0010-fast-bridge-cli-doctor.md)) |
| `JERRY_HOME` resolver | ✅ | `packages/platform`; refuses a home inside a repository ([ADR 0002](../decisions/0002-jerry-never-modifies-repositories.md)) |
| Core service lifecycle | ✅ | fixed port, single instance, autostart from hooks, pause with `core stop` ([ADR 0004](../decisions/0004-core-autostart-fixed-port.md)) |
| SQLite + migrations | ✅ | `node:sqlite` + Kysely, in-code migrations ([ADR 0005](../decisions/0005-sqlite-node-builtin-kysely.md)) |
| Backup/restore | ✅ | backup before migrations, restore on failure, `jerry db backup / backups / restore` |
| Event schema (Zod) | ✅ | spec §11.2 envelope, `hook_events` ([ADR 0006](../decisions/0006-session-events-spool-retention.md)) |
| Event spool | ✅ | `JERRY_HOME/spool`, late evaluation of outage edits |
| Event idempotency | ✅ | `eventId` primary key, replay-safe |
| Local API | ✅ | Fastify ([ADR 0007](../decisions/0007-local-api-fastify-browser-sessions.md)) |
| IPC authentication | ✅ | loopback HTTP with token; browser sessions with one-time login and CSRF |
| Local MCP server | ✅ | read-only `jerry_get_state`, `jerry_check_paths`, `jerry_list_deviations` ([ADR 0008](../decisions/0008-local-mcp-server.md)) |
| Minimal dashboard shell | ✅ (beyond minimal) | overview, plans with approve and reject, timeline, repositories; installable as an app ([ADR 0009](../decisions/0009-dashboard.md)) |
| `jerry status` | ✅ | quick summary |
| `jerry doctor` | ✅ | spec §20 checks, build-aware ([ADR 0010](../decisions/0010-fast-bridge-cli-doctor.md)) |

## Product decisions taken during M1

- JERRY never modifies a repository (ADR 0002).
- JERRY monitors and warns. It blocks only hard rules: Git state changes (also through Git-server MCP tools),
  writes inside `.git`, tampering with JERRY, and user-only commands (ADR 0003). The hard-rule text Claude
  receives is fixed; token savings never come from it.
- Retention is 90 days for events and sessions; data stays on C: (`%LOCALAPPDATA%\JERRY`).
- A Tauri tray app (spec §16.5) is agreed as a later step. The dashboard already installs as an app in Edge or Chrome.

## Measurements

- Hook bridge: 24 KiB, about 27–32 ms above bare Node start-up per guarded call (ADR 0010).
- Context Claude receives per session: about 730 tokens fixed, of which about 200 are the hard rules. Claude Code
  loads JERRY's MCP tool definitions on demand (ADR 0008).
- Tests: 296 passing (unit, integration, install E2E, dashboard in happy-dom). Live Claude Code check
  (`scripts/e2e-live.mjs`): 25/25.

## Known gaps carried forward

- Git run inside project scripts (`npm run release`) is not detected (ADR 0003).
- MCP tools that write local files are not checked against the plan.
- No browser-level E2E for the dashboard yet (happy-dom covers the app logic).
- Windows without Git Bash, and a clean Windows user profile, still need a run on another machine (M0 report).
- Workflow features (plan authoring by Claude, the review phase, skills) start in M2.
