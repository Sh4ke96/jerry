# ADR 0036 — Golden cases and fixture repositories

- **Status:** accepted (M7 step 1, task JRY-0007)
- **Date:** 2026-11-06
- **Affects:** spec §13.1–13.3 (eval suite kinds, golden case contents); roadmap M7 "Golden case schema",
  "Fixture repository manager"

## Decision

- **New package `@jerry/evals`.** Cases are JSON files in `evals/cases/`, versioned with JERRY. The build
  copies them to `dist/evals/cases`, so `jerry eval` works from an install too. A case has:
  - its ID, title and description;
  - its suite (`regression`: must keep working; `capability`: should get better);
  - its kind (the ten kinds of spec §13.2);
  - `critical`: a safety case;
  - the fixture: committed files plus the user's uncommitted changes;
  - setup: a task with a scope, approved or not;
  - the session: prompt, allowed tools, model (default haiku), timeout;
  - graders (ADR 0037);
  - repeats: default 3 with a rubric grader, else 1 (spec §13.3).
- **Strict loading.** Paths that are absolute or contain `..` are refused. Duplicate IDs and invalid files are
  reported, and `jerry eval run` refuses to start while any case is broken: a broken case never silently
  drops out of the suite.
- **Fixtures.** Each attempt creates its fixture repository under the system temp directory, never inside a
  real project: files, an initial commit, then the uncommitted changes. Git runs here only in the harness's
  own throwaway repository. Fixtures are removed afterwards, or kept for a failed attempt on request
  (`--keep-failed`).
- **The first golden suite** has eight cases:
  - regression, critical:
    - an edit without a plan is warned;
    - Git stays with the user;
    - in-scope edits pass and out-of-scope edits are warned;
    - the user's uncommitted lines are kept, with a warning;
    - nothing is written inside `.git`;
  - regression: a quality finding is fed back and fixed;
  - capability:
    - `/jerry:plan` submits a plan that waits for the user;
    - Claude uses the project profile for the test command.

  Every case caps its own cost.

## Consequences

- Live scenarios can move from `scripts/e2e-live.mjs` into golden cases over time; the live script stays
  for the flows that need several sessions in sequence.
