# ADR 0041 — The final report, assembled from what JERRY recorded

- **Status:** accepted (M8 step 1, task JRY-0008)
- **Date:** 2026-11-06
- **Affects:** spec Phase 9 (final report contents), §15.1–15.2; roadmap M8 "Final report schema"

## Decision

- **Schema** (`finalReportSchema`), the sections of spec Phase 9:
  - changes per repository and a diff summary, including what Git saw and what the report left out;
  - tests: the report's checks, the runs JERRY observed, and claims that contradict them;
  - the QA handover;
  - security: risks, open P1/P2 findings and security findings;
  - the review: outcome, rounds, reviewers and their independence, findings, and files nobody covered;
  - rules: skills, deviations, blocks and plan deviations;
  - proposed commit subjects;
  - the Artifact decision (ADR 0042);
  - coverage: what was reviewed, and checks not run;
  - limitations, the user's decisions and the plan's open questions;
  - the Definition of Done with the final checks as its evidence.
- **Assembled by Core** (`apps/core/src/final-report.ts`) from stored facts only: the plan, the latest
  accepted report and its evidence, the review state, findings, test runs, the final checks and the
  transitions. Model text appears only where the user accepted it (the report). It is a `draft` until the task
  is DONE.
- **Access:**
  - `GET /api/v1/tasks/:id/final-report`;
  - `jerry_get_final_report` (MCP, read-only);
  - `jerry report <taskId>` (`--json` for the raw report);
  - the "Final report" view on the dashboard task card.
- **Nothing is written to disk or to the repository.** The report is built on request, so it always matches
  the recorded facts.
