# ADR 0032 — Independent review: the review phase, reviewer submissions and the coverage ledger

- **Status:** accepted (M6 steps 1–2, task JRY-0006)
- **Date:** 2026-11-06
- **Affects:** spec JR-010 (independent review), §7.1 (CODE_REVIEW … REVERIFICATION), §7.2 Phase 6–8, ADR 0015
  (three combined reviewers), ADR 0027 (findings); roadmap M6 "Correctness and tests reviewer", "Security and
  API contract reviewer", "Architecture, quality and UX/accessibility reviewer", "Full changed-file coverage
  ledger", "Finding severity/confidence", "Finding deduplication", "Review report"

## Decision

- **The review is a phase of every task.** Accepting the implementation (`implementation.accepted`) now
  leads to CODE_REVIEW instead of the final checks. Core opens review round 1 with the files to cover: every
  in-scope file changed since the plan was approved (read-only Git).
- **Three reviewers**, the read-only subagents of ADR 0022:
  - `jerry-correctness-reviewer`: correctness and tests;
  - `jerry-security-reviewer`: security and API contracts;
  - `jerry-design-reviewer`: architecture, quality, UX and accessibility.

  Each submits with `jerry_submit_review`:
  - the files it read in full;
  - a summary;
  - findings (title, severity P1–P4, confidence, file:line, evidence, why, fix);
  - gaps.

  A resubmission of a role in the same round replaces the earlier one.
- **Findings** go into the findings model (ADR 0027) with source `review`. The same problem reported by two
  reviewers (same file and normalized title) is one finding with both reviewers as sources
  (`review_finding_sources`); the more severe report wins.
- **Round completion.** When all three roles have reported, Core closes the round (`review.reported`). With
  no open P1–P3 review finding, the review passes (`review.passed`, actor Core), and the final checks run in
  the same transaction. Otherwise the task waits in REVIEW_REPORT. If a reviewer fails twice, Claude may close
  the round with `jerry_finish_review`; the missing role stays visible.
- **Coverage ledger.** For each round, the files to cover against the files the reviewers read. Uncovered
  files are shown in the dashboard, `jerry review show` and `jerry_get_review`. At DONE they are a recorded
  limitation (`review.coverage`).
- **DONE validator.** `review.done` blocks DONE unless the review passed or the user waived it.
  `review.coverage`, `review.independent` and, after a waiver, `review.open-findings` are recorded
  limitations.
- **Storage.** Migration 0015 adds `review_rounds`, `review_submissions` and `review_finding_sources`.

## Consequences

- A task can no longer go from acceptance to DONE without a review or the user's explicit waiver.
- Reviews read the code as Claude left it; reviewers never run the project's commands (ADR 0030).
