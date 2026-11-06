# ADR 0001 — Run the hook bridge as `node` in exec form, not through PowerShell

- **Status:** accepted in M0, pending product-owner confirmation
- **Date:** 2026-11-06
- **Affects:** spec §4.5 (`hooks/bridge.ps1`), §11.4, backlog M0 "Explicitly set the PowerShell shell and `onFailure` for the guard hook"

## Context

The specification plans a `hooks/bridge.ps1` script and `shell: powershell` for blocking hooks, to make
Windows behaviour predictable. Claude Code 2.1.318 supports three forms of a `command` hook:

1. shell form with `shell: "bash"` (the default when Git Bash is installed),
2. shell form with `shell: "powershell"`,
3. exec form: `command` + `args`, run without any shell.

The `PreToolUse` guard runs on **every** file write and **every** shell command, so its start-up cost directly
slows the agent down.

## Measurements (M0, `scripts/bench-hook.mjs`, i5-13600K, Node 22.22.2, 20 runs)

| Variant | Median | p95 |
|---|---|---|
| exec form: `node bridge.mjs` | 107 ms | 114 ms |
| `shell: powershell` (PowerShell 5.1) → `node bridge.mjs` | 292 ms | 350 ms |
| bare Node start-up (`node -e ""`), baseline | 51 ms | 58 ms |

## Decision

Run the guard and SessionStart hooks in **exec form**:

```json
{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/bridge.mjs", "pre-tool-use"],
  "timeout": 10, "onFailure": "block" }
```

- No shell means no quoting issues, no PowerShell profile, no ExecutionPolicy and no Git Bash vs PowerShell
  differences. That is the goal the specification states ("predictable Windows behaviour"), reached more simply.
- `onFailure: "block"` closes the gap the bridge cannot handle itself: `node` missing, a crash before the bridge
  code runs, or a hook timeout.
- The bridge logic is TypeScript and reuses the shared Zod contracts and policy engine (one tested implementation)
  instead of a second implementation in PowerShell.

## Consequences

- Node.js must be on the `PATH` of the Claude Code session. If it is not, every guarded write is blocked
  (fail-closed) and `jerry doctor` reports it. The specification requires Node LTS anyway.
- The bridge adds ~55 ms on top of Node start-up, mostly parsing the 461 KiB bundle (largely Zod).
  Possible M1 optimisations: `zod/mini`, `module.enableCompileCache()`.
- The specification (§4.5, §11.4, §18.5) needs updating: `bridge.ps1` → `bridge.mjs` in exec form.
