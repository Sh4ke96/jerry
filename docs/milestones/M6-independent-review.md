# M6 — Independent Code Review: completion report

**Date:** 2026-11-06 · **Environment:** Windows 11 Home 26300, Claude Code (VS Code extension), Node 22.22.2.
**Task:** JRY-0006, plan v1 (submitted by Claude with `jerry_submit_plan`, approved by the user).
**Agent budget:** three combined reviewers (ADR 0015).

## Backlog checklist

| Backlog item | Status | Where |
|---|---|---|
| Correctness and tests reviewer | ✅ | `jerry-correctness-reviewer` ([ADR 0032](../decisions/0032-independent-review.md)) |
| Security and API contract reviewer | ✅ | `jerry-security-reviewer` ([ADR 0032](../decisions/0032-independent-review.md)) |
| Architecture, quality and UX/accessibility reviewer | ✅ | `jerry-design-reviewer` ([ADR 0032](../decisions/0032-independent-review.md)) |
| Reviewer independence tracking | ✅ | per submission, recorded at DONE ([ADR 0033](../decisions/0033-reviewer-independence-and-read-only.md)) |
| Read-only enforcement for reviewers | ✅ | tool lists, instructions, `monitor.read-only-agent-write` ([ADR 0033](../decisions/0033-reviewer-independence-and-read-only.md)) |
| Full changed-file coverage ledger | ✅ | per round, uncovered files shown ([ADR 0032](../decisions/0032-independent-review.md)) |
| Finding severity/confidence | ✅ | P1–P4, confidence 0–1 ([ADR 0032](../decisions/0032-independent-review.md)) |
| Finding deduplication | ✅ | same file and title across reviewers ([ADR 0032](../decisions/0032-independent-review.md)) |
| Review report | ✅ | dashboard panel, `jerry review show`, `jerry_get_review` ([ADR 0034](../decisions/0034-review-report-and-fix-gate.md)) |
| Remediation plan synthesis | ✅ | `/jerry:review`, `jerry_submit_fix_plan` ([ADR 0034](../decisions/0034-review-report-and-fix-gate.md)) |
| Review-fix approval gate | ✅ | stage `REVIEW_FIX`, user only ([ADR 0034](../decisions/0034-review-report-and-fix-gate.md)) |
| Fix implementation and re-review | ✅ | same three reviewers, at most three rounds ([ADR 0035](../decisions/0035-fixes-and-re-review.md)) |

## What it changes in daily use

- **Accepting an implementation** starts the review. `/jerry:review` runs the three reviewers on every changed
  file.
- **The review panel** on the task card shows:
  - each reviewer's result, independence and the files nobody covered;
  - the merged findings;
  - the fix plan with "Approve fix plan", "Reject fix plan" and "Waive review" (typed task ID; a waiver
    needs a reason).
- **Fixes:** only after your approval. The same reviewers check them again. After three rounds you decide.
- **DONE** needs a passed review or your waiver. Coverage gaps, missing independence and findings left open
  are recorded as limitations.

## Product decisions taken during M6

- Review is mandatory and can be waived by the user with a reason (the plan's proposal).
- A reviewer's write is warned about, not blocked (the plan's proposal; blocking would be a new hard rule).
- Approved fixes after the report do not count as unreported changes. Every other change after the report
  still blocks DONE.

## Measurements

- Tests: 508 passing.
- Live Claude Code check (`scripts/e2e-live.mjs`, haiku): 69/69 checks, scenarios A–R. Scenario R:
  - accepting the implementation started the review;
  - `/jerry:review` ran three separate reviewer subagents, all independent and read-only;
  - Core closed the round with 5 open findings for the user, and no fix started without approval;
  - after the user's waiver, Core set DONE.

## Fixes found on the way

- The live reviewers named files with absolute paths, which would have broken the coverage ledger.
  Reviewer paths are now made repo-relative, with a test.
- Two existing tests showed that a reviewer's in-scope write during a review must keep DONE blocked as a
  change after the report. The final checks exclude only edits inside approved fix windows (ADR 0035).

## Known gaps carried forward

- Hard rules `hard.core-api` and `hard.git-mutation` again blocked my harmless commands whose text contained
  `/api/v1/`; I used the Edit tool instead. Narrowing them needs the product owner's approval.
- `jerry review skip` and `jerry findings set` are protected by the interactive-terminal requirement, not by
  the hard-rule list of user-only commands. Adding them there would change the hard rules, which needs the
  product owner's approval.
