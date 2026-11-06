# ADR 0014 — Implementation report, JERRY's own record, and the user's acceptance

- **Status:** accepted (M2 item 4, task JRY-0002)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 5 (implementation report and user gate), §15.1 (QA handover), §15.2 (commit
  suggestions), §10.2 skills `implementation-report`, `qa-handover`, `commit-message-proposal`, §19 (test
  runner unavailable → NOT RUN, never PASS); backlog DoD "logs and dashboard show actual outcomes, not inferred
  success"

## Context

After workflow states (ADR 0012), a task in implementation had no way to say "done, please check". The user
had no structured account of what changed, which checks really ran, or how the work differed from the plan.
They also had nothing to judge the account against.

## Decision

- **Report document** (`implementationReportSchema`, spec Phase 5):
  - summary;
  - changed files with kind and description, per repository;
  - agents and skills;
  - checks: test, build, lint, typecheck or other, each with its command and result `PASS`, `FAIL` or
    `NOT_RUN`. `NOT_RUN` requires the reason; the schema refuses it without one;
  - differences from the plan, each with a reason;
  - risks and findings, low to critical;
  - proposed commit subjects (required);
  - manual QA scenarios with the fields of spec §15.1: ID, priority, location, roles, preconditions, test
    data, steps, expected result, negative variant, related API or events, new or regression (at least one);
  - optional artifact, never written into the repository.
- **Versions and binding:**
  - Every submission is a new report version (`implementation_reports`, migration 0006). All versions are kept.
  - The hash covers the task, the report version, the plan version and the canonicalised document.
  - The user's decision is an approval with stage `IMPLEMENTATION`, bound to the report version and hash, like
    a plan approval. A decision on an older version is refused with 409.
- **Workflow:**
  - `report.submitted` (Claude or the user) moves IMPLEMENTATION → WAIT_IMPLEMENTATION_ACCEPTANCE;
  - accepting moves the task to FINAL_REPORT, where the DONE validator takes over (M2 item 5);
  - requesting changes moves it back to IMPLEMENTATION under the same approved plan, with the user's comment.

  While the report waits, edits are deviations (ADR 0012), and a second report is refused.
- **JERRY's own record next to the claims.** At submission Core stores evidence it collected itself in the
  task's repository since the plan was last approved:
  - deviations (WARN), with the first 50 listed;
  - blocked actions, including hard-rule blocks, which carry no repository and are attributed by working
    directory;
  - files edited with the file tools;
  - observed edits the report does not list (`unreportedEdits`);
  - the number of checks marked FAIL or NOT_RUN.

  Shell commands can change files without JERRY seeing which, so observed edits are a lower bound. The
  dashboard, `jerry task show` and the CLI decision prompt show the evidence next to the report, highlighted
  when something needs attention. The MCP answer tells Claude to point it out to the user.
- **Claude's side:**
  - `jerry_submit_report` (MCP) validates against the same Zod schema. Its input schema is generated from that
    schema, and an incomplete report comes back with the fields to fix. There is still no tool that accepts,
    approves, pauses or completes anything.
  - `jerry_get_state` says `apply-requested-changes` with the user's comment after a send-back, otherwise
    `wait-for-acceptance` or `final-checks`.
  - Skill `/jerry:report`:
    1. collect the facts with read-only Git;
    2. run the project's real checks, reporting each result as it was;
    3. explain every recorded deviation;
    4. write QA scenarios;
    5. propose commit subjects in the repository's convention;
    6. submit, hand over, and stop.
  - Skill `/jerry:commit-message`: proposes messages, or a split into commits, in the repository's convention
    (Conventional Commits when there is none), as text to paste. It never stages or commits. The Git hard rules
    block that anyway, and the user commits.
- **User's side:**
  - `jerry approve <id> --stage implementation --version <n>` accepts the report;
  - `jerry reject <id> --stage implementation --version <n> --comment "…"` requests changes;
  - both need an interactive terminal and the typed task ID, and they print the report and evidence first;
  - the dashboard shows the report with the evidence, plus Accept implementation and Request changes, with a
    comment Claude sees; both need the typed task ID.

## Evidence

- Unit tests:
  - the report hash binds the version, the plan version and the content;
  - key order is irrelevant;
  - a report hash never equals a plan hash.
- Integration tests with the bundled bridge, MCP server and Core:
  - a report before plan approval is refused;
  - an incomplete report, with a NOT_RUN check lacking its reason or no QA scenarios, comes back with the fields;
  - the evidence counts an out-of-scope edit, a hard-rule block and an unreported edit;
  - the task moves to the user, where edits are deviations and a second report is refused;
  - a send-back with a comment reaches `jerry_get_state`, and in-scope edits pass again;
  - only the latest report version can be accepted, which moves the task to FINAL_REPORT, with the full
    transition history.
- Dashboard tests: the report with highlighted evidence, Request changes with a comment and typed ID, and
  Accept.
- Live (`scripts/e2e-live.mjs`, scenario K):
  - a real session ran `/jerry:report`, which submitted a report tied to its session with JERRY's evidence;
  - it claimed no passing checks in a repository without tooling, and told the user how to accept;
  - `/jerry:commit-message` proposed a message and left Git untouched;
  - accepting exactly report v1 moved the task to FINAL_REPORT.

## Consequences

- FINAL_REPORT → DONE (Core-only, after its checks) is M2 item 5. Until then, accepted tasks wait in FINAL_REPORT.
- Code review stages (M6) will slot in between acceptance and the final report. The transition table already
  has the states.
- Report quality is not graded beyond the schema. Grading is M4 (quality engine).
