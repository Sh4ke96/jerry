# JERRY roadmap

What remains to build, milestone by milestone. The product spec and the implementation backlog are the
sources; changes to them are recorded as ADRs in [docs/decisions](decisions/). Updated 2026-11-06.

**Agent budget ([ADR 0015](decisions/0015-at-most-three-subagents.md)):** at most three subagents at a time and
per phase. Analysis uses three combined analysts, review uses three combined reviewers, implementation uses up
to three implementers with disjoint scopes.

## Done

- M0 Feasibility Spike: [docs/spikes/M0-feasibility.md](spikes/M0-feasibility.md)
- M1 Core Foundation: [docs/milestones/M1-core-foundation.md](milestones/M1-core-foundation.md)
- M2 Workflow Control: [docs/milestones/M2-workflow-control.md](milestones/M2-workflow-control.md)

## M3 — Repository Discovery

- [x] Git root resolver.
- [ ] Git baseline snapshot.
- [ ] Uncommitted changes inventory.
- [ ] Language/framework detectors.
- [ ] Manifest/lockfile detection.
- [ ] Documentation indexer.
- [ ] Project instructions inventory.
- [ ] Existing tests/build/lint detection.
- [ ] API schema detection.
- [ ] Database migration detection.
- [ ] Multi-repo workspace graph.
- [ ] Project profile storage outside project.
- [ ] Profile freshness invalidation.
- [ ] Prompt injection handling rules.

## M4 — Analysis and Planning (three analysts)

- [ ] Agent registry: the three analysts, the three reviewers and the implementer role (ADR 0015).
- [ ] Analysis orchestrator: at most three analysts in parallel; repository discovery within their scope.
- [ ] Architecture and contracts analyst: architecture and impact, API, database, cross-repository integration.
- [ ] Risk analyst: security and threats, devil's advocate.
- [ ] Quality analyst: tests and QA strategy, regression, UI/UX and accessibility.
- [ ] Evidence-backed agent report schema (files read, observations, evidence, risk, confidence, gaps).
- [ ] Agent timeout/failure handling: a missing result is a recorded gap, never a pass.
- [ ] Plan synthesis from the analysts' reports.
- [ ] Plan completeness grader.
- [ ] Plan version diff UI.

## M5 — Implementation and Continuous Quality

- [ ] Implementation task DAG.
- [ ] Agent concurrency cap of three: counted from SubagentStart/SubagentStop; a fourth is warned about
  (blocking it would be a new hard rule, which needs the product owner's decision).
- [ ] File-scope assignment: disjoint scopes for up to three implementers.
- [ ] Conflicting writes serialization.
- [ ] Plan drift detector.
- [ ] Diff collector.
- [ ] Quality scheduler and debounce.
- [ ] Static rule engine.
- [ ] Harry-like naming/prose pack.
- [ ] Error-handling pack.
- [ ] Test-quality pack.
- [ ] Security check interface.
- [ ] Targeted test runner.
- [ ] Findings aggregator.
- [ ] Finding lifecycle.
- [ ] Agent feedback handoff.
- [x] Implementation report generator ([ADR 0014](decisions/0014-implementation-report-and-acceptance.md)).
- [x] Implementation acceptance gate ([ADR 0014](decisions/0014-implementation-report-and-acceptance.md)).

## M6 — Independent Code Review (three reviewers)

- [ ] Correctness and tests reviewer.
- [ ] Security and API contract reviewer.
- [ ] Architecture, quality and UX/accessibility reviewer.
- [ ] Reviewer independence tracking (overlap with implementers recorded).
- [ ] Read-only enforcement for reviewers.
- [ ] Full changed-file coverage ledger.
- [ ] Finding severity/confidence.
- [ ] Finding deduplication.
- [ ] Review report.
- [ ] Remediation plan synthesis.
- [ ] Review-fix approval gate.
- [ ] Fix implementation and re-review by the same three reviewers.

## M7 — Evals and Regression Harness

- [ ] Golden case schema.
- [ ] Fixture repository manager.
- [ ] Deterministic graders.
- [ ] Execution graders.
- [ ] LLM rubric graders.
- [ ] Human-calibration workflow.
- [ ] Repeated run scheduler (at most three subagents at a time).
- [ ] Flaky classification.
- [ ] Baseline storage.
- [ ] Regression comparison.
- [ ] Eval run dashboard.
- [ ] JERRY plugin eval integration.
- [ ] Skill/rule version eval triggers.

## M8 — Reports, Artifacts and Release

- [x] QA handover format ([ADR 0014](decisions/0014-implementation-report-and-acceptance.md)).
- [x] Commit subject suggestions (`/jerry:commit-message`, ADR 0014).
- [ ] Final report schema.
- [ ] HTML artifact output.
- [ ] Optional PDF export.
- [ ] Local artifact browser.
- [ ] Versioned release package.
- [ ] Update and rollback tests.
- [x] Uninstall retention options (`jerry uninstall` keeps data unless `--purge-data`).
- [ ] Security audit.
- [ ] User documentation.

## Later

- Tray app (Tauri) for status and notifications.
