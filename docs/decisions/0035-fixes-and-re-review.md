# ADR 0035 — Fix implementation and re-review by the same three reviewers

- **Status:** accepted (M6 step 5, task JRY-0006)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 8 (fixes, re-verification), §12.5 (no endless loops), ADR 0016 (DONE
  validator); roadmap M6 "Fix implementation and re-review by the same three reviewers"

## Decision

- **Fixes.** In FIX_IMPLEMENTATION the approved plan's scope covers edits (FIX_IMPLEMENTATION is a work state).
  Claude makes the approved fixes and reports them with `jerry_report_fixes` (`fixes.reported`), which:
  - moves the task to REVERIFICATION;
  - opens the next round, whose files to cover are the files edited during the fixes plus the files of the
    open review findings.
- **Re-review.**
  - The same three reviewer roles review again.
  - A finding no reviewer reports again, in a file the round covered, becomes FIXED ("not reported again in
    review round N").
  - With no open P1–P3 review finding left, the review passes and the final checks run.
- **Limit.**
  - At most three rounds: the first review plus two re-reviews. After the third round Core refuses another fix
    plan, and the user decides: waive the review, dismiss findings, or send the work back.
  - This matches the two automatic rounds of ADR 0029 and the product owner's proposal.
- **DONE and the code after the report.**
  - Edits between the user's approval of a fix plan and the fixes report are the approved fixes; the next
    round reviewed them. The final checks leave them out of `code.unchanged-since-report`.
  - Every other edit after the report still blocks DONE: one made during the review, before the fix approval,
    or after the fixes report.
  - Git compares with the snapshot taken when the last round after the fixes closed. A snapshot is also taken
    at every round close and at a waiver.

## Consequences

- A long-running loop is visible: every round, plan and fix is in the review state and the task history.
