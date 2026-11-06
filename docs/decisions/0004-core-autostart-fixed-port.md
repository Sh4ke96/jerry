# ADR 0004 — Core starts on demand from the hooks and listens on a fixed loopback port

- **Status:** accepted (M1, item 2)
- **Date:** 2026-11-06
- **Affects:** spec §4.2 (Core), §16.5 (dashboard), §19 (failure modes), §20 (doctor); JR-015 (recoverability)

## Context

Monitoring needs JERRY Core running. In M0 the user had to run `jerry core start` after every reboot; until
then sessions ran `DEGRADED` (hard rules enforced, nothing recorded). The dashboard planned for M1 must also
keep a single origin to be installable as an app (PWA), but Core picked a random port on every start.

## Decision

- **Fixed port:** Core listens on `127.0.0.1:47823` by default. `JERRY_CORE_PORT` overrides it; `0` means any free
  port (used by tests). If another program holds the port, Core falls back to a random port and keeps guarding;
  `core.json` records `configuredPort` and `jerry doctor` warns.
- **One Core per `JERRY_HOME`:** an exclusive lock file (`run/core.lock`, holding the owner's PID) decides. A second
  start exits quietly; a lock whose owner is gone is taken over.
- **Runtime copy:** `jerry install` copies Core into `JERRY_HOME/runtime/core/` (staged, then swapped). Only this copy
  is started automatically; development sessions with `--plugin-dir` and no runtime never spawn anything.
- **Autostart from the hooks:**
  - `SessionStart`: when Core is unreachable, start it and wait up to 3 s, then register the session.
  - `PreToolUse`: when Core is unreachable, start it in the background and let the call proceed without waiting.
  - At most one automatic start per 30 s, so a crashing Core cannot cause a spawn storm.
  - `jerry core stop` disables automatic starts until `jerry core start`, so the hooks never override the user.
- Core always runs with `JERRY_HOME` as its working directory (ADR 0002) and appends output to `logs/core.log`.

## Alternatives considered

- **Windows service:** needs administrator rights and runs outside the user's session. Rejected for a single-user tool.
- **Task Scheduler logon task:** starts Core even when Claude Code is not used, and is a persistent system change
  outside `JERRY_HOME`. Possible later as an opt-in.
- **Tray application (Tauri):** planned later as a shell around the same dashboard (spec §16.5); not needed for availability.

## Evidence

- Integration tests: fixed port, fallback, single instance, stale-lock takeover, autostart from both hooks,
  throttling, and no restart after `jerry core stop`.
- Live (`scripts/e2e-live.mjs`, scenario F): a real Claude Code session started Core through `SessionStart`, the
  session was registered, and Core kept running after the Claude Code process and its hooks exited.

## Consequences

- Tool calls made before an autostarted Core is up proceed unrecorded (the event spool in M1 closes this gap).
- After `jerry install`, an already running Core keeps its old version until restarted; install prints a hint.
- If the fixed port is taken, guarding works but the dashboard origin changes; doctor reports it.
