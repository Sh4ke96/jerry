# ADR 0016 — DONE is set by Core's final checks

- **Status:** accepted (M2 item 5, task JRY-0002)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 9 ("Status DONE nadaje Core, nie model"), §19 (test runner unavailable, incomplete
  review); backlog M2 "Final DONE validator"

## Context

After ADR 0014, accepting an implementation moved a task to FINAL_REPORT and left it there. The spec requires
that DONE is decided by Core, never by a model, and only when the conditions are met. DONE never commits or
deploys anything.

## Decision

- **When:** Core runs its final checks in the same SQLite transaction in which the user accepts an
  implementation report. If every blocking condition passes, Core moves the task from FINAL_REPORT to DONE as
  actor `core`. If one fails, the task stays in FINAL_REPORT, labelled "Final checks failed", with the reasons.
  - `task.completed` remains Core-only in the transition table.
  - No API call, MCP tool or CLI command sets DONE directly.
- **The validator** (`evaluateCompletion`, `packages/workflow`) is a pure function. Core gathers the facts from
  its own records.

  | Condition | Blocks DONE | Passes when |
  |---|---|---|
  | `plan.approved` | yes | the user approved exactly the current plan version and hash |
  | `report.accepted` | yes | the user accepted exactly the latest report version and hash; this confirms the plan's Definition of Done |
  | `report.matches-plan` | yes | the report was written for the current plan version |
  | `report.no-failed-checks` | yes | no check in the report is FAIL |
  | `report.no-critical-risks` | yes | no open risk is critical |
  | `code.unchanged-since-report` | yes | no file in the plan's scope was edited with the file tools between report submission and acceptance |
  | `checks.ran` | no, recorded | at least one check ran and passed (NOT_RUN is never treated as PASS) |
  | `report.complete` | no, recorded | every edit JERRY observed is in the report |
  | `implementation.deviations` | no, recorded | no deviation was recorded during implementation |

- **Definition of Done.** Core cannot verify the plan's Definition of Done items itself. The dashboard's accept
  dialog and `jerry approve --stage implementation` list them before the typed confirmation, so the user's
  acceptance is the explicit confirmation. They are stored with the check.
- **Record:** every run is stored (`task_completion_checks`, migration 0007) with the report version, each
  condition and its detail, and the Definition of Done items. The latest run shows in:
  - the dashboard ("Completed by JERRY", or "JERRY did not complete the task" with what blocks);
  - `jerry task show`;
  - the CLI right after acceptance;
  - `jerry_get_state`: action `final-checks-failed` with the reasons.
- **Way out of a refusal.** `changes.requested` is also allowed from FINAL_REPORT. The user sends the work back
  under the same plan; Claude fixes, reports again, and the next acceptance runs the checks again. Cancelling
  stays possible.
- **Waiting for the user.** A task in FINAL_REPORT is waiting for the user, so the dashboard and `jerry status`
  count it as waiting for a decision.
- **Review conditions.** "Incomplete review → no DONE" (spec §19) becomes a blocking condition when code review
  arrives (M6). The validator is where new conditions are added.

## Evidence

- Unit tests (`packages/workflow/test/completion.test.ts`):
  - a clean case passes;
  - each blocking condition alone refuses DONE;
  - limitations are recorded without refusing;
  - details stay short.
- Integration tests with the bundled bridge, MCP server and Core:
  - an edit after the report refuses DONE with the file named, and the reason reaches `jerry_get_state`;
  - sending the work back from the final checks works;
  - a third, clean report accepted by the user ends in DONE by `core`, with the full transition history;
  - after DONE no report or decision is accepted;
  - a FAIL check and a critical risk each refuse DONE.
- Dashboard tests: the refusal with its reasons and Request changes, and the Definition of Done in the accept
  dialog.
- Live (`scripts/e2e-live.mjs`, scenario K): a real `/jerry:report` report was accepted, and Core set DONE.
  The last transition is `task.completed` by `core`.

## Consequences

- With M2 done, a task runs plan → approval → implementation → report → acceptance → DONE, and every step is
  recorded.
- The final report document of spec Phase 9 (diff summary, security audit, coverage ledger, artifact) is M8.
  Until then, the completion check together with the accepted report is the final record.
