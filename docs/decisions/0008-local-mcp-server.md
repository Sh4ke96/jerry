# ADR 0008 — Local MCP server: read-only, live plan state for Claude

- **Status:** accepted (M1 item 6)
- **Date:** 2026-11-06
- **Affects:** spec §4.2 E (MCP tools), §18.1 (MCP local, no network); backlog M1 "Local MCP server"

## Context

The SessionStart context tells Claude which plans are approved, but only at session start. An approval given
during the session never reached the model (M0 finding 7). Claude also had no way to ask, before editing,
whether a path is inside the approved scope, or to list the deviations it should report.

## Decision

The plugin ships an MCP server (`.mcp.json`, stdio, `node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`). It reaches Core
through the same token-authenticated loopback API as the hooks.

**Tools.** All are annotated `readOnlyHint` and none changes state:

| Tool | Answers |
|---|---|
| `jerry_get_state` | live state for a repository: monitored or excluded, approved and pending plans with scope, current task, next expected action (propose a plan, wait for approval, revise, work within scope), hard rules |
| `jerry_check_paths` | the gate verdict for hypothetical edits (PASS / WARN / DENY), not recorded |
| `jerry_list_deviations` | recorded WARN and DENY events for the repository over a time window |

The spec lists the state questions as separate tools (`jerry_get_current_task`, `jerry_get_workflow_state`,
`jerry_get_approval_status`, `jerry_get_next_required_action`). They are merged into `jerry_get_state` because every
tool definition stays in the context of every session, and one call gives the full picture.

**Context budget** (measured, about 3.7 characters per token):
- Fixed cost per session: about 730 tokens. That is about 310 for the SessionStart context, of which about 200 is
  the hard-rule text, plus about 390 for the tool definitions and about 30 for the server instructions.
- A deviation warning costs about 50 tokens.
- A `jerry_get_state` result costs about 175 tokens.

The first version cost about 1350 tokens. Savings come only from tool descriptions and plan-state wording: the
hard-rule text Claude receives stays verbatim (product-owner requirement). Claude is asked to mention JERRY
warnings in its summary rather than calling `jerry_list_deviations` every time, which avoids extra tool calls.

**Deliberately absent:** any tool that approves, rejects, excludes, revises or completes. Those are user
actions in the CLI or dashboard (spec §4.2: "Do not expose `approve_plan`, `approve_fixes`, `mark_done`").

**Deferred to M2:** the reporting tools from spec §4.2 (`jerry_submit_analysis_report`,
`jerry_submit_agent_result`, `jerry_report_finding`, `jerry_save_checkpoint`, `jerry_get_required_skills`,
`jerry_get_project_profile`). They need the workflow, findings and profile models that M2 and M3 introduce.

**Protocol:** a minimal hand-written MCP implementation (newline-delimited JSON-RPC 2.0: `initialize`, `ping`,
`tools/list`, `tools/call`; protocol versions 2025-06-18, 2025-03-26 and 2024-11-05) instead of the SDK. The
surface is small, there are no dependencies, and the integration tests drive it like a client.

**When Core is down:** tools return an explicit error ("plan state unknown; hard rules still apply") and start
Core if the runtime is installed. They never guess.

**Supporting Core endpoints** (token or dashboard session):
- `GET /api/v1/repositories/state?path=…` returns the repository's tasks with decisions, and whether it is excluded.
- `POST /api/v1/gate/preview` evaluates without recording (token only).
- `GET /api/v1/events` filters by `verdict` (comma-separated), `repoPath` and `since`.

SessionStart now points Claude at these tools, because the start message can go stale.

## Evidence

- Integration (`tests/integration/mcp-server.test.ts`): only read-only tools are listed; the plan state changes
  live from none to waiting to approved; previews are not recorded; deviations are listed; Core outage is
  reported explicitly; protocol errors do not crash the server.
- Live (`scripts/e2e-live.mjs`, scenario G, 25/25): a real Claude Code session called
  `mcp__plugin_jerry_jerry__jerry_get_state` and reported the approved scope from the tool. Every MCP call also
  passes through the PreToolUse gate (`monitor.mcp-tool`).

## Consequences

- Tool names carry the plugin namespace (`mcp__plugin_jerry_jerry__…`). Allow rules and dashboards must use the full name.
- The hard rules themselves (enforcement and the wording Claude receives) are out of scope for token savings.
- Each JERRY tool call adds one PreToolUse hook run (about 100 ms), like every other MCP tool.
