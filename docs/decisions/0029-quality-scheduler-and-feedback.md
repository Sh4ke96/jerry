# ADR 0029 — Diff collector, debounced quality scheduler and feedback to Claude

- **Status:** accepted (M5 steps 3–4, task JRY-0005)
- **Date:** 2026-11-06
- **Affects:** spec §12.3 (PostToolUse enqueues checks, 1–3 s debounce, cheap checks first, time limits),
  §12.5 (feedback to Claude, no endless fix loop), ADR 0002 (JERRY never modifies repositories); roadmap M5
  "Diff collector", "Quality scheduler and debounce", "Agent feedback handoff"

## Decision

- **Diff collector.**
  - Core already receives PostToolUse events for Write, Edit, MultiEdit and NotebookEdit. Each queues the
    edited file per session.
  - When a batch runs, Core reads the file (never writes it). The changed lines come from
    `git diff -U0 --no-color --no-ext-diff --no-textconv HEAD -- <file>`, with `--no-optional-locks`. External
    diff drivers and textconv filters are switched off, so JERRY never runs programs the repository
    configures.
  - An untracked or new file counts as changed in full.
- **Scheduler.**
  - A quiet period of 1.5 s per session (`JERRY_QUALITY_DEBOUNCE_MS`; tests use 100 ms) merges later edits
    into one batch.
  - Only files covered by a task in implementation under an approved plan are checked.
  - Larger files (over 512 KiB) and binary files are skipped.
  - A batch has a 2 s budget; files left over are recorded in `quality_batches.error`.
  - A deleted file resolves its findings.
  - The scheduler runs inside Core, after the event is stored; it never delays a hook.
- **Repository untouched.** An integration test hashes every file of the fixture repository, `.git`
  included, before and after the checks; they are identical.
- **Feedback.**
  - With the next guarded tool call of a session that works on the task, the gate answer carries new OPEN
    P1–P3 findings. The bridge adds them to Claude's context (`additionalContext`; on a PASS the user sees
    nothing extra).
  - Each finding is told once (`fed_back_at`).
  - After two fixes that came back (FIXED → OPEN twice), the finding is no longer told: it waits for the user
    (spec §12.5; the product owner's proposal was two rounds).
  - P4 findings stay in the dashboard.
- **Pull channel.** `jerry_list_findings` (MCP, read-only) lists findings compactly with the targeted test
  command (ADR 0030). `jerry_get_state` mentions open P1/P2 findings in its next action.
- **Dashboard.**
  - The task card has a "Quality findings" panel with counts by severity, filters, evidence, why and fix.
  - It opens by itself when a P1/P2 finding is open.
  - User decisions go through a dialog with the typed finding ID and a required reason.

## Consequences

- Feedback reaches Claude only through tool calls; a session that makes none sees findings in the dashboard
  and on its next call.
- The gate route reads findings from the database when there are tasks in implementation; the guarded call
  stays well inside the hook latency budget.
