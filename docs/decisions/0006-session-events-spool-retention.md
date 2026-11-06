# ADR 0006 — Session events: minimized envelopes, spool while Core is down, 90-day retention

- **Status:** accepted (M1 item 4; retention period chosen by the product owner)
- **Date:** 2026-11-06
- **Affects:** spec §11 (hooks, envelope, reliability), §17 (`hook_events`), §18.2 (data minimization, retention)

## Context

Until now JERRY recorded only gate decisions, in a JSON-lines file, and lost everything that happened while
Core was down. The timeline, dashboard and later quality and review features need the session's events,
reliably, without storing private content.

## Decision

**Events recorded** (all through the same bridge, `bridge.mjs event`):

| Hook | Recorded | Hook mode |
|---|---|---|
| `SessionStart` | source; also registers the session | synchronous (adds context) |
| `UserPromptSubmit` | prompt **length** and leading slash command only | `async` |
| `PreToolUse` | target path / redacted command, verdict, rule, reason | synchronous (gate) |
| `PostToolUse`, `PostToolUseFailure` | target path / redacted command, response sizes and flags, redacted error | `async` |
| `SubagentStart`, `SubagentStop` | agent id and type, last message length | `async` |
| `Stop` | stop-hook flag | `async` |
| `SessionEnd` | reason | synchronous, 3 s |

Telemetry hooks are `async`, so they add no latency to Claude's work, and they never block or fail.

**Envelope** (spec §11.2): `eventId`, `schemaVersion`, `source`, `eventType`, `timestamp`, session, agent, cwd,
tool, `toolUseId`, task, repository, verdict, rule, `payload`, `redaction`. Stored in `hook_events` (migration
`0002_hook_events`); the gate log file is imported once and then renamed.

**Data minimization** (`packages/trace-engine`): file contents, edit strings, prompt text, tool output and MCP
argument values are never stored. Commands and error messages are redacted, then truncated to 300 characters.
Redaction covers authorization and cookie headers, credentials in URLs, `password=`/`token=`/`api_key=`-style
assignments, credential flags, GitHub, `sk-`, AWS and Slack tokens, JWTs and private key blocks. Each event
records which redaction rules applied.

**Spool** (spec §11.5): when Core is unreachable, the bridge writes the event to `JERRY_HOME/spool/<eventId>.json`
(atomic, one file per event, at most 5000 files) and starts Core in the background. Core drains the spool at
start and every 15 s. A `PreToolUse` recorded during an outage carries `pendingEvaluation`, so Core evaluates
it against the plans on ingestion and marks it `evaluatedLate`. Replays are idempotent on `eventId`. Nothing
is spooled while the user has paused JERRY with `jerry core stop`.

**Retention** (spec §18.2): events and sessions older than 90 days are deleted at Core start and every 6 hours
(`JERRY_RETENTION_DAYS` overrides the period). Tasks, plans, approvals and the audit log are governance
records and are kept. Large deletions trigger `VACUUM`. Backups are capped at 20 files and 512 MB,
`core.log` rotates at 5 MB, and `jerry doctor` reports disk usage and the spool.

## Evidence

- Unit tests: redaction patterns, and minimization for every hook type (no content leaks).
- Integration tests: bridge to Core recording; spooled events ingested and late-evaluated after Core starts;
  idempotent replay; no spooling while paused; gate-log import; retention.
- Live (`scripts/e2e-live.mjs`, 23/23): a real session produced SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, Stop and SessionEnd events. An edit made with Core stopped reached the database through the
  spool after autostart and was evaluated against the approved plan.

## Consequences

- PreToolUse events now store a redacted command (up to 300 characters) instead of only its first word, so the
  timeline can show what ran. Redaction is pattern-based and can miss unusual secret formats.
- Prompt text is not stored. Recording it would need an explicit opt-in (spec §18.2), which does not exist yet.
