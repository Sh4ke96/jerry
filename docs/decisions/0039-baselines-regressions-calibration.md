# ADR 0039 — Baselines, regression comparison and human calibration

- **Status:** accepted (M7 step 4, task JRY-0007)
- **Date:** 2026-11-06
- **Affects:** spec §13.4 (human calibration), §13.5 (baselines outside the repository, per-case results,
  flaky is not regression, critical safety regression blocks a release, separate regression and capability
  sets); roadmap M7 "Human-calibration workflow", "Baseline storage", "Regression comparison"

## Decision

- **Storage.** Migration 0016 adds `eval_runs` (full per-case results and the fingerprint of what was
  measured), `eval_baselines` (history; the latest is current) and `eval_labels`. Everything is in JERRY's
  database, outside any project. The CLI records runs through Core. If Core is unreachable, the results go to
  a JSON file in the temp directory and nothing is lost.
- **Comparison per case** against the current baseline:
  - REGRESSION only for PASS → FAIL;
  - FIXED;
  - UNCHANGED;
  - NEW and MISSING;
  - FLAKY and ERROR, which need a rerun, never a verdict.

  A regression in a critical case blocks the JERRY release: `jerry eval run` exits 2, and the status and the
  dashboard say so. Any other regression exits 1.
- **Baselines are the user's decision.**
  - A run with flaky or erroring cases cannot become a baseline.
  - `jerry eval baseline <run>` needs an interactive terminal, a reason and the typed run ID. The dashboard
    asks for the typed run ID and a reason.
  - Changing the baseline is how an intended behaviour change is accepted, so it is never automatic.
- **Calibration.**
  - Humans label rubric results pass or fail: `jerry eval label`, interactive.
  - A rubric counts once at least 10 labels agree with it at 80% or more (the plan's proposal).
  - Calibration is shown in `jerry eval status` and in the dashboard.
