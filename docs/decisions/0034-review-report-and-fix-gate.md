# ADR 0034 — Review report, remediation plan and the review-fix approval gate

- **Status:** accepted (M6 step 4, task JRY-0006)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 7 (review report, fix plan, user approval), §12.5; roadmap M6 "Review report",
  "Remediation plan synthesis", "Review-fix approval gate"

## Decision

- **Review report.** `GET /api/v1/tasks/:id/review` (dashboard panel, `jerry review show`,
  `jerry_get_review`) gives:
  - each round with its files to cover, the three reviewers (findings, files read, gaps, independence) and
    the uncovered files;
  - the open review findings, most severe first;
  - the fix plan;
  - the outcome.
- **Remediation plan.**
  - Claude writes it with `/jerry:review` and submits it with `jerry_submit_fix_plan`:
    - items, each with the open review findings it fixes, the change, and its files;
    - the tests;
    - findings not fixed, each with the reason.
  - Core refuses:
    - citations of anything but the task's open review findings;
    - files outside the approved plan scope (a wider change needs a plan revision with the user).
  - The plan is stored on the round with a content hash (`fixes.proposed` → WAIT_REVIEW_FIX_APPROVAL).
- **Approval gate.** The user decides like on a plan:
  - approval stage `REVIEW_FIX`;
  - version = round number, bound to the fix plan's hash;
  - dashboard with the typed task ID, or `jerry approve|reject <id> --stage review-fix --version <round>` in
    an interactive terminal.

  Approval → FIX_IMPLEMENTATION; rejection → back to REVIEW_REPORT for a revised plan. Edits before the
  approval are deviations.
- **Waiver.** The user can waive the (rest of the) review from any review state, with a reason:
  - `review.skipped`: dashboard with typed task ID and required reason, or `jerry review skip` in an
    interactive terminal;
  - the final checks then run, and open review findings are recorded as a limitation.
- **The user can also send the work back** from REVIEW_REPORT (`changes.requested`). The next acceptance
  starts a new round.

## Consequences

- Only the user moves a task out of the waiting states. Claude proposes, Core verifies, reviewers judge.
