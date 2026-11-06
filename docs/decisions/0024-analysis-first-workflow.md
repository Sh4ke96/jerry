# ADR 0024 — Analysis first: task intake, the analysis states, and plans built on the analysts' reports

- **Status:** accepted (M4 step 3, task JRY-0004)
- **Date:** 2026-11-06
- **Affects:** spec §7.1 (DISCOVERY → PARALLEL_ANALYSIS → PLAN_DRAFT → WAIT_PLAN_APPROVAL), §7.2 Phases 1–3
  (discovery, at most three analysts, plan synthesis), §9.2 (the orchestrator does not fabricate missing
  results), ADR 0015 (at most three subagents), ADR 0023 (analysis reports and subagent runs); roadmap M4
  "Analysis orchestrator", "Plan synthesis from the analysts' reports"

## Context

Until now a task began only with a plan (`plan.submitted` → WAIT_PLAN_APPROVAL). The analysts from ADR 0022
and 0023 could report on a task, but a task had to exist first, so analysis came after the plan it should
have informed. The workflow states DISCOVERY and PARALLEL_ANALYSIS existed but nothing led to them.

## Decision

- **Task intake.**
  - `jerry_start_task` (MCP) → `POST /api/v1/tasks/intake` creates a task with a title, a goal and a focus
    (repo-relative globs of the area to analyse).
  - Event `task.started` (user or Claude) puts the task in DISCOVERY.
  - The focus is stored as an intake plan v1 without a document. Nothing is approved, so every edit stays a
    recorded deviation (ADR 0003), exactly as before a plan.
  - The goal is stored with the task (`tasks.goal`, migration 0011) and shown to Claude and the user.
- **The analysis states move on their own.**
  - The first analysis report saved for a task in DISCOVERY moves it to PARALLEL_ANALYSIS (`analysis.started`,
    actor `core`).
  - The plan submitted for a task in PARALLEL_ANALYSIS first records `analysis.completed` (core → PLAN_DRAFT)
    and then `plan.revised` (→ WAIT_PLAN_APPROVAL), in one transaction.
  - A small change may skip the analysts: `plan.revised` is also allowed from DISCOVERY.
  - No new user decision is introduced. Approval still belongs to the user alone.
- **The plan cites its analysis.**
  - The plan document has an optional `analysis` section: `reports` (the IDs of the task's analysis reports
    the plan uses) and `gaps` (missing analysts, unverified citations, what could not be checked).
  - It is optional and has no default, so plans submitted before it keep their content hash.
  - Core refuses a plan citing report IDs the task does not have, and a new task (no intake) citing any.
- **Reading the analysis.** `jerry_get_analysis` (read-only) returns:
  - every report, compact: observations with evidence, risks, recommendations, confidence and gaps;
  - citations Core could not verify;
  - analysts that stopped without a report or timed out (gaps, never results);
  - analysts still running, roles without a report, and the next step.
- **Skills.**
  - `/jerry:analyze` takes the task in, starts at most three analysts in parallel (only those the change
    needs), reads their reports, re-runs a failed analyst at most once, and builds the plan with
    `/jerry:plan`, citing the reports and carrying every gap.
  - `/jerry:plan` documents the `analysis` section and the submission with the intake's task ID.
- **Guidance and visibility.**
  - MCP `nextAction` has `analyse-then-plan` for tasks in DISCOVERY or PARALLEL_ANALYSIS.
  - The dashboard shows the goal, labels an intake's scope "Analysis focus" with "no plan yet", numbers the
    analysis reports (#id), and shows the plan's "Based on analysis" section with its gaps.

## Alternatives considered

- **A separate intake record instead of an intake plan v1.** Every task needs a current plan row today
  (snapshot, gate, dashboard). A scope-only plan v1 keeps all of them working, and the real plan becomes v2.
- **Claude moving the analysis states itself.** These are facts Core sees (a report saved, a plan
  submitted), so Core records them. Claude has no tool for workflow transitions.

## Evidence

- Workflow tests: the analysis-first path, skipping the analysts, and no `analysis.started` outside
  DISCOVERY.
- Integration tests with the bundled bridge, MCP server and Core (`tests/integration/analysis-first.test.ts`):
  - an intake in DISCOVERY with the goal, the focus and no approval; an edit is a deviation;
  - `nextAction` is `analyse-then-plan`;
  - the first report moves the task to PARALLEL_ANALYSIS and the second changes nothing;
  - `jerry_get_analysis` lists the reports and the analyst that stopped without one;
  - a plan citing unknown reports is refused, and so is a new task citing any;
  - the plan citing the reports produces the transitions `task.started:claude`, `analysis.started:core`,
    `analysis.completed:core`, `plan.revised:claude`, then waits for the user's approval;
  - a small change goes from intake straight to a plan.
- Live (`scripts/e2e-live.mjs`, scenario O): a real `/jerry:analyze` session with intake, at most three
  read-only analysts, stored reports, and a plan citing them that waits for the user.

## Consequences

- The plan completeness grader (step 4) can check whether a plan that followed an analysis addresses the
  analysts' risks and gaps.
- An abandoned intake stays open in DISCOVERY until the user cancels it, like any other open task.
