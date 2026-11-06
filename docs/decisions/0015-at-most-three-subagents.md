# ADR 0015 — At most three subagents

- **Status:** accepted (product owner decision, 2026-11-06)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 2 (parallel analysis), Phase 4 (implementation), Phase 6 and 8 (review and
  re-review), §9.1 (role separation), §9.2 (parallelism rules: "default maximum 8 concurrent agents"), §14.3,
  §25 (usage and cost); backlog M4, M5 "Agent concurrency cap", M6, M7 repeated runs

## Context

The spec plans up to eight concurrent subagents and one agent per perspective: ten analysts, seven implementers
and seven reviewers. Every subagent costs usage limits, time and review effort. The product owner decided that
JERRY works with at most three subagents.

## Decision

- **The cap:** at most three subagents run at the same time, and at most three take part in each phase
  (analysis, implementation, review, re-review).
  - The main Claude Code session, the orchestrator, is not counted.
  - Users may lower the cap (1–3), never raise it.
- **Use agents only when they pay off.** A small task uses none or one; the main session does the work itself.
- **All required perspectives stay covered.** Roles are combined, not dropped:

  | Phase | Agent 1 | Agent 2 | Agent 3 |
  |---|---|---|---|
  | Analysis (read-only) | architecture and contracts: architecture and impact, API, database, cross-repository integration, repository discovery | risk: security and threats, devil's advocate (wrong assumptions, failure scenarios) | quality: tests and QA strategy, regression, UI/UX and accessibility |
  | Implementation | up to three implementers with disjoint file scopes; same-file writes serialized; contract changes ordered | | |
  | Review and re-review (read-only) | correctness and tests | security and API contracts | architecture, code quality, UX/accessibility |

- **Repositories.** There is no agent per repository. Repository discovery belongs to the analysts' scope, or
  to the main session. With several repositories, each analyst covers all of them for its perspectives.
- **Reviewer independence (spec §9.3)** stays. Reviewers should not be the implementers; with a pool of three,
  any overlap is recorded.
- **Evals (M7):** repeated eval runs that use subagents respect the same cap.
- **Enforcement** belongs to the M5 item "Agent concurrency cap". JERRY counts active subagents per session
  from SubagentStart and SubagentStop. Until the product owner decides whether a fourth should be blocked,
  which would be a new hard rule, JERRY warns about it (ADR 0003: monitor, do not block). Before that,
  `/jerry:plan` already tells Claude to plan with at most three subagents.

## Consequences

- The backlog shrinks:
  - M4 has one task per analyst instead of seven separate analyses;
  - M6 has one task per reviewer instead of six separate reviews.

  See [docs/roadmap.md](../roadmap.md).
- Wide tasks take longer in wall-clock time than with eight agents, in exchange for lower usage and fewer
  reports to read.
- The spec's role catalogue (§9.1) remains the list of perspectives. The three agents per phase are how they
  are covered.
