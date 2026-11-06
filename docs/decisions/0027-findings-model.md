# ADR 0027 — Quality findings: model, lifecycle and the user's decisions

- **Status:** accepted (M5 step 1, task JRY-0005)
- **Date:** 2026-11-06
- **Affects:** spec §12.4 (finding schema), §12.5 (finding feedback loop), §2.1 (severity, confidence,
  calibration); roadmap M5 "Findings aggregator", "Finding lifecycle"

## Context

M5 adds continuous quality checks while Claude implements. Their results need a durable record that the
user, the dashboard, the CLI and Claude share. Findings must not disappear silently, and must not be
dismissed by the agent whose code they are about.

## Decision

- **Schema** (`findingSchema`, spec §12.4):
  - `FND-n` ID, task, repository, file and lines;
  - rule ID and version, source (static, ai, test, security, review), category;
  - severity P1–P4 and confidence 0–1;
  - title, evidence (the offending line only, never a whole file, secrets masked), why it matters,
    suggested fix;
  - `planRelated`: the plan names the file in a step or change;
  - status with reason.
- **Identity and deduplication.** A finding is unique per repository, task, file, rule and a fingerprint of
  the rule plus the normalized evidence. Moving a line does not create a new finding. The same rule and
  evidence twice in a file is one finding.
- **Lifecycle** (`finding_events` keeps every step with actor and reason):
  - Core: new → OPEN; OPEN/ACCEPTED → FIXED when a later check of the file no longer reports it; FIXED →
    OPEN when it returns.
  - The user only: ACCEPTED (valid, to be fixed), WONT_FIX, FALSE_POSITIVE, and reopening, always with a
    reason. Dashboard: typed finding ID plus a required reason. CLI: `jerry findings set` in an interactive
    terminal only, like approvals. No MCP tool changes a status.
  - A later check that sees a dismissed finding again leaves it dismissed.
- **Calibration.** FALSE_POSITIVE counts per rule. After three, the scheduler stops applying that rule
  (ADR 0029). The dashboard says so in the dismissal dialog.
- **Storage.** Migration 0012 adds `findings`, `finding_events` and `quality_batches` (every check run with
  files, duration, new and fixed counts, and errors such as an exhausted time budget).
- **Access.**
  - `GET /api/v1/findings` (by task, repository, status, file) and `GET /api/v1/findings/:id` with history;
  - `POST /api/v1/findings/:id/status` (user decisions);
  - task summaries carry `findings` counts;
  - `jerry findings list|show|set`.

## Consequences

- The review phase (M6) can feed reviewer findings into the same model (`source: review`).
- Findings belong to a task; edits without an approved plan are deviations, not quality findings.
