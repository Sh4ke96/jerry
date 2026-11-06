# M4 — Analysis and Planning: completion report

**Date:** 2026-11-06 · **Environment:** Windows 11 Home 26300, Claude Code (VS Code extension), Node 22.22.2.
**Task:** JRY-0004, plan v1 (submitted by Claude with `jerry_submit_plan`, approved by the user).
**Agent budget:** at most three subagents at a time and per phase ([ADR 0015](../decisions/0015-at-most-three-subagents.md)).

## Backlog checklist

| Backlog item | Status | Where |
|---|---|---|
| Agent registry | ✅ | three analysts, three reviewers, the implementer; read-only roles in the plugin ([ADR 0022](../decisions/0022-agent-registry.md)) |
| Analysis orchestrator (≤ 3 in parallel) | ✅ | task intake in Discovery, `/jerry:analyze`, Core moves Discovery → Analysis → plan ([ADR 0024](../decisions/0024-analysis-first-workflow.md)) |
| Architecture and contracts analyst | ✅ | `jerry-architecture-analyst` ([ADR 0022](../decisions/0022-agent-registry.md)) |
| Risk analyst (security, devil's advocate) | ✅ | `jerry-risk-analyst` ([ADR 0022](../decisions/0022-agent-registry.md)) |
| Quality analyst (tests, regression, UI/UX, a11y) | ✅ | `jerry-quality-analyst` ([ADR 0022](../decisions/0022-agent-registry.md)) |
| Evidence-backed agent report schema | ✅ | `path:line` evidence, Core's citation check ([ADR 0023](../decisions/0023-analysis-reports-and-agent-runs.md)) |
| Agent timeout/failure handling | ✅ | `no-report` and `timed-out` are gaps, never results ([ADR 0023](../decisions/0023-analysis-reports-and-agent-runs.md)) |
| Plan synthesis from the reports | ✅ | the plan cites report IDs and carries gaps; unknown IDs are refused ([ADR 0024](../decisions/0024-analysis-first-workflow.md)) |
| Plan completeness grader | ✅ | deterministic rubric, informational, in dashboard, CLI and MCP ([ADR 0025](../decisions/0025-plan-completeness-grader.md)) |
| Plan version diff UI | ✅ | dashboard "Changes since v…" and `jerry plan diff` ([ADR 0026](../decisions/0026-plan-version-diff.md)) |

## What it changes in daily use

- **Analysis before the plan.** `/jerry:analyze <change>` takes the task in and runs up to three read-only
  analysts in parallel. Each submits a report with `path:line` evidence, and JERRY checks the citations. The
  plan is then built on those reports. Nothing is approved until the user approves the plan.
- **Gaps stay visible.** An analyst that stops without a report, or never finishes, is a recorded gap. The
  plan must carry it, and the completeness check says so if it does not.
- **A fourth subagent** gets a warning, not a block.
- **Reviewing plans.** The dashboard shows:
  - the analysts' reports (numbered);
  - the plan's "Based on analysis" section;
  - JERRY's completeness check (informational);
  - what changed since the previous version, scope first.

  `jerry task show` and `jerry plan diff` show the same in a terminal.

## Product decisions taken during M4

- At most three subagents, as three combined analysts (ADR 0015).
- Warnings, not blocks:
  - the fourth subagent;
  - an incomplete plan.

  Making either a block would be a new hard rule, which is the product owner's decision.
- Workflow transitions in the analysis phase are recorded by Core from facts it sees (a report saved, a plan
  submitted). Claude has no tool to move a task's state, and approval stays with the user.
- The completeness check is deterministic. AI rubric grading (spec §13.4) needs human-labelled calibration
  first.

## Fixes found on the way

- Long-lived callers reused keep-alive sockets that Core had closed, which caused ECONNRESET. Each request now
  uses its own connection, with a regression test.
- Subagent runs are attributed to a task only from the task's creation. A session that worked on several tasks
  no longer lends one task's failed analysts to the next.

## Measurements

- Tests: 429 passing (unit, integration with the bundled bridge, MCP server and Core, dashboard, CLI).
- Live Claude Code check (`scripts/e2e-live.mjs`, haiku): 56/56 checks, scenarios A–O. Highlights:
  - N: a real analyst submits a verified report through MCP;
  - O: a real `/jerry:analyze` with intake, two read-only analysts and stored reports, and a plan citing them
    that waits for the user.

## Known gaps carried forward

- The hard rules `hard.core-api` (any command text containing `/api/v1/`) and `hard.git-mutation` (`sed` text
  mentioning Git commands) caught my own harmless commands again during M4. I used the Edit tool instead.
  Narrowing them needs the product owner's approval.
- Open product decisions:
  - block or warn on a fourth subagent;
  - block or warn on editing the user's uncommitted files;
  - whether an incomplete plan should ever block an approval.
