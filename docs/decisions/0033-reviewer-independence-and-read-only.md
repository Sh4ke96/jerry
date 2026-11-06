# ADR 0033 — Reviewer independence and read-only enforcement

- **Status:** accepted (M6 step 3, task JRY-0006)
- **Date:** 2026-11-06
- **Affects:** spec JR-010 ("reviewers that did not implement the reviewed code, where possible"), ADR 0003
  (warn, block only hard rules), ADR 0022 (read-only roles); roadmap M6 "Reviewer independence tracking",
  "Read-only enforcement for reviewers"

## Decision

- **Independence per submission.**
  - A review is independent when it comes from a separate subagent run that made no edit of the task.
  - The run is identified, as for analysts, through the PreToolUse record of its MCP call (ADR 0023). An edit
    is a non-blocked Write, Edit, MultiEdit or NotebookEdit since the task was created.
  - A review submitted from the main session (which implemented) is recorded as not independent, with the
    reason.
  - Independence is shown per reviewer and recorded at DONE as `review.independent` (a limitation, not a
    block).
- **Read-only enforcement in three layers:**
  - the reviewer and analyst agent definitions list no write or shell tools (tested);
  - their instructions say they only read;
  - the gate warns: `monitor.read-only-agent-write` when an agent whose type is a JERRY analyst or reviewer
    uses a write tool or a modifying shell command. Read-only commands pass, and hard rules still come first.
- **Warn, not block.** Blocking a reviewer's write would be a new hard rule, which is the product owner's
  decision (an open question in the M6 plan). A reviewer's in-scope edit during the review also counts as a
  change after the report: the final checks refuse DONE for it (ADR 0035).

## Consequences

- The agent type comes from SubagentStart (asynchronous). A write before that event is recorded is not yet
  attributed. In practice a reviewer reads first, so the type is known by the time it could write.
