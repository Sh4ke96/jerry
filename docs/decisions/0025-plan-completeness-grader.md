# ADR 0025 — Plan completeness grader: a deterministic, informational rubric

- **Status:** accepted (M4 step 4, task JRY-0004)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 3 (the 18 plan sections), §13.1–13.4 (`planning-quality`, deterministic
  graders before AI graders), ADR 0003 (JERRY blocks only hard rules), ADR 0024 (plans built on analysis);
  roadmap M4 "Plan completeness grader"

## Context

The plan schema rejects a plan without its required sections, but a plan can pass the schema and still be
hard to review. Examples: changes outside the scope it asks for, steps that depend on later steps, a UI
change without UI tests, unknowns that never reach the user, or analyst reports that the plan ignores. The
user had to find these by reading.

## Decision

- **A fixed rubric, no AI.** `gradePlan` in `@jerry/policy-engine` is pure and deterministic. It reads only
  the plan document and, for an analysed task, the stored analysis reports and subagent runs. Spec §13.4 puts
  rubric/LLM grading of plans later, behind human calibration; this is the deterministic layer before it.
- **Checks.** Each check is `major` or `minor`:
  - **Scope:**
    - the scope is not the whole repository (minor);
    - every change target and step file that names a path lies in the scope (major each).
  - **Steps:** dependencies point only to earlier, existing steps (major).
  - **Risks:**
    - at least one risk (major);
    - a security or database change names a medium or high risk (minor);
    - rollback is described (minor).
  - **Repositories:** more than one repository requires its contracts and order (major).
  - **Tests fit the classification** (major):
    - UI/frontend needs component, E2E or manual tests;
    - API/backend needs API, integration or unit tests;
    - database needs integration, API or E2E tests.
  - **Regression, QA scenarios and commit subjects** are each a minor check.
  - **Unknowns:** an `UNKNOWN` in the plan needs open questions for the user (minor).
  - **After an analysis (ADR 0024):**
    - every report of the task is cited (major);
    - gaps are carried when analysts failed, citations were unverified or reports named gaps (major);
    - the plan lists at least as many risks as the analysts' distinct high or critical risks (minor).
- **Result.**
  - The score is the weighted share of passed checks (major counts three times), from 0 to 100.
  - Levels:
    - `complete`: every check passes;
    - `mostly-complete`: every major check passes;
    - `incomplete`: a major check fails;
    - `scope-only`: no document to grade.
- **Informational only.** The grade never blocks an approval or a transition (ADR 0003). The user decides;
  JERRY shows what is missing.
- **Where it shows.**
  - Task summaries of open tasks carry `planGrade`.
  - The dashboard shows "Plan completeness" next to the plan before the report, with the failed checks, and
    opens it when a major check fails.
  - `jerry task show` prints the level, the score and the failed checks.
  - `jerry_submit_plan` returns `completeness` and asks Claude to mention the gaps to the user.
  - `jerry_get_state` shows it for the current task.
- **Fix found on the way.** Subagent runs are now counted for a task only from its creation onward. A session
  that worked on several tasks no longer lends the earlier task's failed analysts to the later one as gaps.

## Evidence

- Unit tests for each check, the levels and the weighting.
- Dashboard test: the grade with its failed check, marked informational, with the approve button still there.
- Integration test: a complete analysed plan grades `complete`; a plan with changes outside its scope grades
  `incomplete` and can still be approved.

## Consequences

- AI rubric graders (spec §13.4) can be added later next to these checks, calibrated against human labels,
  without changing the result's shape.
- Path checks recognise paths by their form (no spaces, contains `/` or `.`). A descriptive target such as
  "the login form" is not checked.
