# ADR 0030 — Targeted tests and the test results collector: JERRY suggests, Claude runs, JERRY records

- **Status:** accepted (M5 step 5, task JRY-0005)
- **Date:** 2026-11-06
- **Affects:** spec §12.3 (tests by file type and checkpoints), §9.2 (real results only), Epic G7 (test results
  collector), ADR 0002 (JERRY never modifies repositories); roadmap M5 "Targeted test runner"

## Context

Running the project's tests from JERRY would write caches, coverage files and build output into the user's
repository and run code JERRY did not review. That would break the rule that JERRY never changes a
repository. The plan named this as its highest risk.

## Decision

- **JERRY never runs project commands.** "Targeted test runner" means:
  - **selection:** `selectTargetedTests` maps changed files to existing test files by the conventions of
    each ecosystem (co-located `.test`/`.spec` files, `__tests__`, mirrored `tests/`, `test_*.py`,
    `_test.go`, Maven's `src/test`, `*Tests.cs`, RSpec and PHPUnit);
  - **command:** it narrows the project's own test command from the profile to those files, where the runner
    takes file arguments (npm, pnpm, yarn and bun scripts after `--`; pytest, vitest, jest, mocha, phpunit,
    rspec directly; `go test` by package);
  - **untested files:** it lists changed files without any test.

  `GET /api/v1/tasks/:id/targeted-tests` answers with the selection; `jerry_list_findings` hands it to
  Claude as `tests.run`.
- **Results collector.**
  - PostToolUse and PostToolUseFailure of Bash and PowerShell whose command is a test command (a known runner,
    or the project's own test command from the profile) become a `test_runs` row: PASS, FAIL (with the exit
    code from the failure) or INTERRUPTED.
  - The hook summary keeps one line of the output: the runner's totals ("Tests 12 passed (12)",
    "===== 2 failed, 10 passed in 0.52s ====="), matched by strict patterns of digits and fixed words.
  - Nothing else of the output is stored (spec §18.2).
  - A run whose totals report failures is FAIL even when the command exited 0.
- **Visibility.**
  - Task summaries carry `lastTestRun`. The dashboard shows it as "Last tests … run by Claude, seen by
    JERRY". `jerry task show` prints it.
  - The report evidence compares checks the report calls PASS with the latest observed run of the same
    command (ADR 0031).

## Consequences

- JERRY cannot tell whether tests pass unless Claude, or the user in a monitored session, runs them. That is
  deliberate. The report skill and the implementer instructions require real runs.
- Migration 0013 adds `test_runs`, unique per hook event, so a spooled duplicate is one run.
