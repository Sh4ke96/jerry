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
- M3 Repository Discovery: [docs/milestones/M3-repository-discovery.md](milestones/M3-repository-discovery.md)
- M4 Analysis and Planning: [docs/milestones/M4-analysis-and-planning.md](milestones/M4-analysis-and-planning.md)
- M5 Implementation and Continuous Quality: [docs/milestones/M5-implementation-and-quality.md](milestones/M5-implementation-and-quality.md)
- M6 Independent Code Review: [docs/milestones/M6-independent-review.md](milestones/M6-independent-review.md)
- M7 Evals and Regression Harness: [docs/milestones/M7-evals.md](milestones/M7-evals.md)
- M8 Reports, Artifacts and Release: [docs/milestones/M8-reports-and-release.md](milestones/M8-reports-and-release.md)

## M4 — Analysis and Planning (three analysts)

- [x] Agent registry: the three analysts, the three reviewers and the implementer role ([ADR 0022](decisions/0022-agent-registry.md)).
- [x] Analysis orchestrator: task intake (Discovery), at most three analysts in parallel within the focus, `/jerry:analyze` ([ADR 0024](decisions/0024-analysis-first-workflow.md)).
- [x] Architecture and contracts analyst: architecture and impact, API, database, cross-repository integration ([ADR 0022](decisions/0022-agent-registry.md)).
- [x] Risk analyst: security and threats, devil's advocate ([ADR 0022](decisions/0022-agent-registry.md)).
- [x] Quality analyst: tests and QA strategy, regression, UI/UX and accessibility ([ADR 0022](decisions/0022-agent-registry.md)).
- [x] Evidence-backed agent report schema (files read, observations, evidence, risk, confidence, gaps) ([ADR 0023](decisions/0023-analysis-reports-and-agent-runs.md)).
- [x] Agent timeout/failure handling: a missing result is a recorded gap, never a pass ([ADR 0023](decisions/0023-analysis-reports-and-agent-runs.md)).
- [x] Plan synthesis from the analysts' reports: the plan cites them and carries their gaps ([ADR 0024](decisions/0024-analysis-first-workflow.md)).
- [x] Plan completeness grader: deterministic and informational, in the dashboard, CLI and MCP ([ADR 0025](decisions/0025-plan-completeness-grader.md)).
- [x] Plan version diff UI: in the dashboard and `jerry plan diff` ([ADR 0026](decisions/0026-plan-version-diff.md)).

## M5 — Implementation and Continuous Quality

- [x] Implementation task DAG: plan steps in parallel layers ([ADR 0031](decisions/0031-implementers-conflicts-and-drift.md)).
- [x] Agent concurrency cap of three: counted from SubagentStart/SubagentStop; a fourth is warned about
  (blocking it would be a new hard rule, which needs the product owner's decision) ([ADR 0023](decisions/0023-analysis-reports-and-agent-runs.md)).
- [x] File-scope assignment: disjoint files for up to three implementers, bound by their first edit ([ADR 0031](decisions/0031-implementers-conflicts-and-drift.md)).
- [x] Conflicting writes serialization: a second writer on a file is warned to wait ([ADR 0031](decisions/0031-implementers-conflicts-and-drift.md)).
- [x] Plan drift detector ([ADR 0031](decisions/0031-implementers-conflicts-and-drift.md)).
- [x] Diff collector: changed lines from read-only Git ([ADR 0029](decisions/0029-quality-scheduler-and-feedback.md)).
- [x] Quality scheduler and debounce ([ADR 0029](decisions/0029-quality-scheduler-and-feedback.md)).
- [x] Static rule engine ([ADR 0028](decisions/0028-rule-engine-and-packs.md)).
- [x] Harry-like naming/prose pack ([ADR 0028](decisions/0028-rule-engine-and-packs.md)).
- [x] Error-handling pack ([ADR 0028](decisions/0028-rule-engine-and-packs.md)).
- [x] Test-quality pack ([ADR 0028](decisions/0028-rule-engine-and-packs.md)).
- [x] Security check interface and a first security pack ([ADR 0028](decisions/0028-rule-engine-and-packs.md)).
- [x] Targeted tests: JERRY selects, Claude runs, JERRY records the results ([ADR 0030](decisions/0030-targeted-tests-and-test-results.md)).
- [x] Findings aggregator: deduplicated by rule and evidence fingerprint ([ADR 0027](decisions/0027-findings-model.md)).
- [x] Finding lifecycle: FIXED by Core, dismissed only by the user with a reason ([ADR 0027](decisions/0027-findings-model.md)).
- [x] Agent feedback handoff: once per finding, at most two automatic rounds ([ADR 0029](decisions/0029-quality-scheduler-and-feedback.md)).
- [x] Implementation report generator ([ADR 0014](decisions/0014-implementation-report-and-acceptance.md)).
- [x] Implementation acceptance gate ([ADR 0014](decisions/0014-implementation-report-and-acceptance.md)).

## M6 — Independent Code Review (three reviewers)

- [x] Correctness and tests reviewer ([ADR 0032](decisions/0032-independent-review.md)).
- [x] Security and API contract reviewer ([ADR 0032](decisions/0032-independent-review.md)).
- [x] Architecture, quality and UX/accessibility reviewer ([ADR 0032](decisions/0032-independent-review.md)).
- [x] Reviewer independence tracking (overlap with implementers recorded) ([ADR 0033](decisions/0033-reviewer-independence-and-read-only.md)).
- [x] Read-only enforcement for reviewers: tool lists, instructions and a gate warning ([ADR 0033](decisions/0033-reviewer-independence-and-read-only.md)).
- [x] Full changed-file coverage ledger ([ADR 0032](decisions/0032-independent-review.md)).
- [x] Finding severity/confidence ([ADR 0032](decisions/0032-independent-review.md)).
- [x] Finding deduplication across reviewers ([ADR 0032](decisions/0032-independent-review.md)).
- [x] Review report ([ADR 0034](decisions/0034-review-report-and-fix-gate.md)).
- [x] Remediation plan synthesis ([ADR 0034](decisions/0034-review-report-and-fix-gate.md)).
- [x] Review-fix approval gate ([ADR 0034](decisions/0034-review-report-and-fix-gate.md)).
- [x] Fix implementation and re-review by the same three reviewers, at most three rounds ([ADR 0035](decisions/0035-fixes-and-re-review.md)).

## M7 — Evals and Regression Harness

- [x] Golden case schema ([ADR 0036](decisions/0036-golden-cases-and-fixtures.md)).
- [x] Fixture repository manager ([ADR 0036](decisions/0036-golden-cases-and-fixtures.md)).
- [x] Deterministic graders ([ADR 0037](decisions/0037-graders.md)).
- [x] Execution graders ([ADR 0037](decisions/0037-graders.md)).
- [x] LLM rubric graders, counted only when calibrated ([ADR 0037](decisions/0037-graders.md)).
- [x] Human-calibration workflow ([ADR 0039](decisions/0039-baselines-regressions-calibration.md)).
- [x] Repeated run scheduler (at most three sessions at a time) ([ADR 0038](decisions/0038-eval-runner.md)).
- [x] Flaky classification ([ADR 0038](decisions/0038-eval-runner.md)).
- [x] Baseline storage outside any project ([ADR 0039](decisions/0039-baselines-regressions-calibration.md)).
- [x] Regression comparison; a critical regression blocks the release ([ADR 0039](decisions/0039-baselines-regressions-calibration.md)).
- [x] Eval run dashboard ([ADR 0040](decisions/0040-eval-dashboard-triggers-plugin-evals.md)).
- [x] JERRY plugin eval integration (`jerry eval plugin`, never published) ([ADR 0040](decisions/0040-eval-dashboard-triggers-plugin-evals.md)).
- [x] Skill/rule version eval triggers ([ADR 0040](decisions/0040-eval-dashboard-triggers-plugin-evals.md)).

## M8 — Reports, Artifacts and Release

- [x] QA handover format ([ADR 0014](decisions/0014-implementation-report-and-acceptance.md)).
- [x] Commit subject suggestions (`/jerry:commit-message`, ADR 0014).
- [x] Final report schema, assembled from recorded facts ([ADR 0041](decisions/0041-final-report.md)).
- [x] Artifact output: an option the user chooses in `/jerry:artifact`, created by Claude ([ADR 0042](decisions/0042-artifact-is-the-users-choice.md)).
- [x] ~~Optional PDF export~~: superseded by the user's decision; Claude's Artifact types handle exports ([ADR 0042](decisions/0042-artifact-is-the-users-choice.md)).
- [x] Artifact list in the dashboard (links to the user's Artifacts) ([ADR 0042](decisions/0042-artifact-is-the-users-choice.md)).
- [x] Versioned release package with checksums ([ADR 0043](decisions/0043-release-package.md)).
- [x] Update and rollback tests ([ADR 0043](decisions/0043-release-package.md)).
- [x] Uninstall retention options (`jerry uninstall` keeps data unless `--purge-data`).
- [x] Security audit ([docs/security/audit.md](security/audit.md), [ADR 0044](decisions/0044-security-audit.md)).
- [x] User documentation ([docs/user-guide.md](user-guide.md)).

## Later

- Tray app (Tauri) for status and notifications.
