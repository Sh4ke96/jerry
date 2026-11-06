# ADR 0023 — Evidence-backed analysis reports, subagent runs, and the warning before a fourth subagent

- **Status:** accepted (M4 step 2, task JRY-0004)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 2 (agent results: files read, observations, evidence, risk, recommendations,
  confidence, gaps), §9.2 (the orchestrator must not fabricate missing results; runs, failures and findings
  recorded), §19 ("agent did not return a result → timeout/failed, never completed"), ADR 0015 (at most three
  subagents); roadmap M4 "Evidence-backed agent report schema", "Agent timeout/failure handling"

## Context

ADR 0022 gave JERRY read-only analyst subagents, but their results were only text in the orchestrating
session. Nothing recorded which subagents ran, whether one stopped without a result, or whether its citations
were real. ADR 0015 caps concurrent subagents at three, but nothing watched the cap.

## Decision

- **Report schema** (`analysisReportSchema`):
  - the role (one of the three analysts) and the scope it was asked about;
  - the files read;
  - observations, each with at least one `path:line` or `path:line-line` citation (a report without
    evidence is rejected with the fields to fix);
  - risks with severity and scenario;
  - recommendations;
  - confidence with its reason;
  - gaps.
- **Submission.** The analyst itself submits through `jerry_submit_analysis_report`, which is now among the
  analysts' tools. Core ties the report to the task, to the session, and, through the PreToolUse event the hook
  recorded for that tool use, to the subagent run (`agent_id`).
- **Citation check** (`apps/core/src/citations.ts`):
  - every cited file must exist inside the repository, and every cited line must exist in it;
  - missing files and lines beyond the end are stored with the report;
  - the MCP answer asks the analyst to correct them and submit again;
  - files are read only to count lines.
- **Subagent runs** (`agent_runs`, migration 0010):
  - recorded from SubagentStart and SubagentStop, including events arriving late through the spool;
  - a run is listed for a task when its session is linked to the task;
  - statuses: `running`; `completed`; `no-report` (an analyst stopped without submitting: a gap, never a
    success); `timed-out` (no SubagentStop within 30 minutes).
- **Before a fourth subagent:**
  - the PreToolUse hook now also matches `Task` and `Agent`;
  - Core counts a session's Task/Agent calls minus its SubagentStop events in the last 30 minutes; with
    three already active, the gate answers `WARN monitor.subagent-cap` and Claude is told to wait for one to
    finish;
  - it is a warning, not a block (ADR 0003). Blocking would be a new hard rule, which is the product owner's
    decision;
  - parallel launches are counted too, because each Task call reaches the gate before the next.
- **Visibility.**
  - Task summaries of open tasks carry `analyses` and `agentRuns`.
  - The dashboard task card shows each report: role, confidence, files read, how many citations were
    verified, unverified ones highlighted, observations, risks and gaps. Runs that left a gap are marked
    "a gap, not a result".
  - `jerry task show` prints the same.
- **The bridge stays Zod-free.** `MAX_SUBAGENTS` comes from the plain `@jerry/contracts/agents` export.

## Evidence

- Gate tests: a fourth concurrent subagent is warned about, never blocked; other tools are unaffected.
- Integration tests with the bundled bridge, MCP server and Core:
  - a subagent run plus its report are tied together through the hook's tool-use record, and the run
    completes;
  - citations of a missing file or a line beyond the end are flagged, and the analyst is asked to correct
    them (absolute paths inside the repository count as valid);
  - a report without evidence is rejected;
  - an analyst stopping without a report becomes `no-report`;
  - the fourth Task call in a session gets the warning, and after two stops there is room again.
- Dashboard test: the report with an unverified citation, and a no-report run shown as a gap.
- Live (`scripts/e2e-live.mjs`, scenario N): a real `jerry-risk-analyst` subagent submitted its report through
  MCP. JERRY tied it to that subagent's run and verified its citations; the analyst used no write or shell tool.

## Consequences

- The orchestration skill (step 3) can rely on stored reports and on gaps, instead of parsing text.
- Each Task call now passes the hook (tens of milliseconds), which is negligible next to a subagent run.
