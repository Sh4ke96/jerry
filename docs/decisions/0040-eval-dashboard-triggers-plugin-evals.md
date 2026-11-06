# ADR 0040 — Eval dashboard, version triggers and Claude Code plugin evals

- **Status:** accepted (M7 step 5, task JRY-0007)
- **Date:** 2026-11-06
- **Affects:** spec §13.5 (every plugin, skill or rule change may trigger its suite), §13.6 (use
  `claude plugin eval` where available); roadmap M7 "Eval run dashboard", "JERRY plugin eval integration",
  "Skill/rule version eval triggers"

## Decision

- **Dashboard "Evals" view:**
  - runs with PASS, FAIL, FLAKY and ERROR counts;
  - the selected run compared with the baseline, per case and per attempt, with the failing graders' details;
  - the baseline, and a release-blocked banner on a critical regression;
  - what changed since the baseline;
  - rubric calibration;
  - "Make baseline" (typed run ID and a reason).

  Runs start from the CLI only (`jerry eval run`), never from the browser.
- **Triggers.** Each run records a fingerprint of what it measured: hashes of the plugin's skills, agents and
  hooks, and of the quality rules' IDs and versions. Core computes the same fingerprint for the plugin it
  ships with. `jerry eval status` and the dashboard list the components that changed since the baseline:
  the evals should run again.
- **Claude Code plugin evals** (`claude plugin eval`, available in this Claude Code version):
  - JERRY's plugin ships a small suite in `claude-plugin/evals`, in that tool's format (`prompt.md` plus
    `graders/*.md`): Git stays with the user, and a plan is never self-approved;
  - `jerry eval plugin` runs it with `--no-publish` (that tool publishes reports to claude.ai by default; JERRY
    never publishes without the user), in a temporary JERRY home (so the plugin's hooks never reach the user's
    JERRY data), and with results in a temp directory;
  - `--trust` passes `--trust-plugin` only when the user asks;
  - if a Claude Code version lacks the command, it reports NOT_AVAILABLE.

## Consequences

- JERRY's own engine stays the reference for workflow, gates, dashboard and history; the official plugin
  evals add an independent check of the plugin's prompts and skills.
