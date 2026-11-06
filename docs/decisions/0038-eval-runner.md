# ADR 0038 — The eval runner: isolation, repeats and flaky classification

- **Status:** accepted (M7 step 3, task JRY-0007)
- **Date:** 2026-11-06
- **Affects:** spec §13.3 (repeats, timeout, budget), §13.5 (flaky is not regression), ADR 0015 (at most three
  at a time), ADR 0002 (no footprint); roadmap M7 "Repeated run scheduler", "Flaky classification"

## Decision

- **Isolation.** Every attempt gets its own temp directory containing:
  - the fixture repository;
  - its own JERRY home;
  - its own Core, from the JERRY build under test (`dist/core`), with a short quality debounce.

  Claude Code runs headless with `--plugin-dir` set to that build's plugin and `JERRY_HOME` set to the
  attempt's home, so any JERRY plugin the user has installed also reports to the attempt's Core. The user's
  repositories and JERRY data are never touched; an integration test checks the user's JERRY home
  byte-for-byte.
- **Scheduling.** Cases times their repeats run in a pool of at most three concurrent sessions.
- **Outcomes:**
  - an attempt is PASS when every counted grader passed, FAIL when one failed, and ERROR when the harness
    failed (Core did not start, the session gave no JSON, a timeout);
  - a case is PASS or FAIL when all attempts agree, FLAKY when passes and failures mix, and ERROR when all
    attempts errored.
- **Testing the runner without a model.** `scripts/fake-claude.mjs` takes the same flags as `claude`, reads a
  scripted list of tool calls from the prompt, and sends each through the real hook bridge. Integration tests
  run the full runner and CLI against it.
- **Who runs evals.** `jerry eval run` is not a user-only command: it costs tokens but changes nothing of the
  user's (the plan's proposal).

## Consequences

- Each attempt starts its own Core (about a second). Model time dominates a real run anyway.
