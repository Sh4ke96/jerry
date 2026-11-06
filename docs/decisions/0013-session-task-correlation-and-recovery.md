# ADR 0013 — Session ↔ task correlation, checkpoints and session recovery

- **Status:** accepted (M2 item 3, task JRY-0002)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 0 (a task is assigned to a Claude Code session) and Phase 4 (checkpoints),
  §4.2 E (`jerry_save_checkpoint`), §11.1 (SessionStart, SessionEnd, PostCompact), §17 (indexed by
  `session_id`), §19 (Claude Code closed, VS Code restart), §25 (repo changes while a task waits); backlog
  M2 "Session/task correlation", "Session recovery"

## Context

JERRY recorded sessions and tasks, but not which session worked on which task. After a restart, a resumed
session or a compaction, Claude knew only which plans were approved. It did not know what it had been doing,
what was finished, or what came next.

## Decision

- **Correlation from facts, not guesses.** A session is linked to a task (`session_tasks`) when:
  - it submits or revises the task's plan through MCP;
  - it edits inside the task's approved scope (the gate attributes the edit to the task); this includes late
    decisions for events from the spool;
  - it saves a checkpoint.

  Each link keeps the first and last time and the last activity. Events from the spool can arrive out of
  order, so the times only ever widen.
- **Which session made an MCP call.** Verified on Claude Code 2.1.318 with a probe server: Claude Code sends
  `_meta["claudecode/toolUseId"]` with every `tools/call` and sets `CLAUDE_CODE_SESSION_ID` for MCP servers.
  - The JERRY MCP server forwards both as `origin`.
  - Core matches the tool-use ID against the PreToolUse event the hook recorded for the same call. The session
    therefore comes from the hook, not from the caller.
  - The environment session ID is only the fallback: it goes stale after `/clear`, while the server keeps
    running.
- **Checkpoints** (`task_checkpoints`, MCP tool `jerry_save_checkpoint`) are Claude's progress notes on an
  open task: a summary (up to 2000 characters) and up to 10 next steps. They change no state and approve
  nothing.
  - Like `jerry_submit_plan`, the tool writes only through Core's API.
  - Checkpoints on finished or cancelled tasks are refused.
  - The nudge to save them ("Save progress with jerry_save_checkpoint at milestones and before you finish")
    appears only while a task covers edits.
- **Session end and restart.**
  - SessionEnd sets `sessions.ended_at` and the reason, also when the event arrives late through the spool.
  - When the same session starts again (resume), it is open again.
- **No automatic pause when Claude Code closes.** The spec mentions PAUSED/INTERRUPTED for a closed session.
  JERRY records the interruption on the session instead and leaves the task state alone, for two reasons:
  - pause and resume are the user's decisions (ADR 0012);
  - an automatic pause would make the user resume every task after every VS Code restart.

  The dashboard and `jerry task show` show whether the last session ended.
- **Recovery at SessionStart.** Core answers the registration with the repository's open tasks: up to 10,
  those this session already worked on first (same ID after resume or compaction), then by last activity.
  - Each task carries its state, scope, whether it covers edits, the last activity and the latest checkpoint.
  - The bridge adds up to three of them to the start context, for example:
    `Open JERRY tasks: JRY-0002 "…": in implementation, last worked on … UTC; last checkpoint: … Next: …`.
  - A paused task carries "do not continue it until the user resumes it".
  - With a checkpoint comes a reminder to verify it against the current code (`git status`, `git diff`): the
    user may have changed it in between (spec §25 "Repo changes while task paused").
  - Titles and notes are flattened to one line and truncated.
  - The hard-rule text is unchanged.
- **Compaction.** The SessionStart hook has no matcher, so it also runs for `compact` and `clear` sources and
  restores the same context. This covers the spec's PostCompact role without another hook.
- **Surfaces:**
  - `GET /api/v1/tasks` adds session activity and the latest checkpoint;
  - `GET /api/v1/tasks/:id` gives the details: sessions and checkpoints;
  - `POST /api/v1/tasks/:id/checkpoints` is token-only, for MCP;
  - `jerry_get_state` picks as current task the one this session worked on most recently, with its
    checkpoint;
  - the dashboard task card shows sessions and the last checkpoint, marked as written by Claude;
  - `jerry task show` lists sessions and the last checkpoint.
- **Retention:** links and checkpoints are task history, like plans and approvals. They are kept when 90-day
  retention removes old sessions and events. There is no foreign key to `sessions`.

## Evidence

- Contract tests: the bridge guard for the registration response, with open tasks, accepts exactly what the
  Zod schema accepts.
- Store test: links widen on out-of-order events, and unknown tasks are ignored.
- Integration test with the bundled bridge, MCP server and Core:
  - a plan submitted through MCP is linked to the session from the hook, not from a stale environment;
  - in-scope edits and checkpoints are linked;
  - SessionEnd closes the session;
  - a new session gets the task, its checkpoint and the verification reminder;
  - a resumed session is told it worked on the task, and `jerry_get_state` returns it with the checkpoint;
  - a paused task is flagged;
  - cancelled tasks leave the context, and checkpoints on them are refused.
- Dashboard test: session activity and the checkpoint on the task card.
- Live (`scripts/e2e-live.mjs`, scenario J): a real session edits and saves a checkpoint, and JERRY ties both
  to that session through the tool-use ID. A new session then names the task and the next step from its start
  context alone, without tools.

## Consequences

- The start context grows by roughly 40–120 tokens per open task shown, at most three.
- Checkpoints are only as good as Claude's notes. The context presents them as notes to verify, not
  instructions.
- Detecting that the repository changed since the checkpoint (HEAD or diff baseline) belongs to the Git
  baseline snapshot in M3. Until then Claude is asked to check `git status` and `git diff` itself.
