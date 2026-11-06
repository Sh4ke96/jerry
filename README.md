# JERRY

A local agent harness and development guardian for Claude Code and VS Code.
**One installation. Every project. Zero project footprint.**

This repository contains the source of JERRY itself. The zero-footprint requirement applies to the user's
repositories, not to this one.

**Status:**
- Version 0.1.0. Start with the [user guide](docs/user-guide.md); the
  [security audit](docs/security/audit.md) lists what JERRY does and does not protect against.
- Complete:
  - M8 Reports, Artifacts and Release ([report](docs/milestones/M8-reports-and-release.md));
  - M7 Evals and Regression Harness ([report](docs/milestones/M7-evals.md));
  - M6 Independent Code Review ([report](docs/milestones/M6-independent-review.md));
  - M5 Implementation and Continuous Quality ([report](docs/milestones/M5-implementation-and-quality.md));
  - M4 Analysis and Planning ([report](docs/milestones/M4-analysis-and-planning.md));
  - M3 Repository Discovery ([report](docs/milestones/M3-repository-discovery.md));
  - M2 Workflow Control ([report](docs/milestones/M2-workflow-control.md));
  - M1 Core Foundation ([report](docs/milestones/M1-core-foundation.md)).
- What remains: [docs/roadmap.md](docs/roadmap.md).
- M0 spike: [docs/spikes/M0-feasibility.md](docs/spikes/M0-feasibility.md).

## What works

- A Claude Code plugin (`claude-plugin/`) with `SessionStart` and `PreToolUse` hooks
  (Write/Edit/MultiEdit/NotebookEdit/Bash/PowerShell/Monitor).
- JERRY Core: a local HTTP process on `127.0.0.1` with a per-start token. It stores tasks, versioned plans
  (content hash) and approvals in `JERRY_HOME`.
- Monitoring, not blocking ([ADR 0003](docs/decisions/0003-monitor-not-block.md)): edits without an approved
  plan, or outside the approved plan's scope, proceed but are recorded as deviations, and Claude and the user
  are warned.
- Hard rules, always blocked, also while Core is down: Git state changes through shell commands or Git-server
  MCP tools (the user does all Git operations), writes inside `.git`, tampering with JERRY data or the Claude
  Code settings that enable it.
- `jerry repo exclude <path>` turns monitoring off for a repository; hard rules still apply there.
- Core starts automatically from Claude Code sessions and listens on `127.0.0.1:47823` (`JERRY_CORE_PORT`);
  `jerry core stop` pauses it until `jerry core start` ([ADR 0004](docs/decisions/0004-core-autostart-fixed-port.md)).
- JERRY never modifies any repository ([ADR 0002](docs/decisions/0002-jerry-never-modifies-repositories.md)).
- State in SQLite (`JERRY_HOME/database/jerry.sqlite`) with in-code migrations, a backup before every migration,
  automatic restore when a migration fails, and full plan history ([ADR 0005](docs/decisions/0005-sqlite-node-builtin-kysely.md)).
- Session events (prompts by size only, tool calls and results, subagents, stop, session end) with redaction,
  a spool while Core is down, and 90-day retention ([ADR 0006](docs/decisions/0006-session-events-spool-retention.md)).
- Local API on Fastify: bearer token for the CLI and hooks; `jerry ui` signs the browser in with a one-time link,
  with CSRF and Origin checks for the dashboard ([ADR 0007](docs/decisions/0007-local-api-fastify-browser-sessions.md)).
- `/jerry:plan`: Claude studies the repository, drafts the full plan (spec §7.2) and submits it with
  `jerry_submit_plan`; you approve the exact document in the dashboard or CLI
  ([ADR 0011](docs/decisions/0011-plans-submitted-by-claude.md)).
- `/jerry:analyze`: analysis before the plan. Claude takes the task in (goal and focus, nothing approved), runs
  at most three of JERRY's read-only analysts in parallel, reads their evidence-backed reports with
  `jerry_get_analysis`, and submits a plan that cites them and carries their gaps. JERRY moves the task
  through Discovery and Analysis on its own; the approval stays yours
  ([ADR 0024](docs/decisions/0024-analysis-first-workflow.md)).
- Plan completeness: a deterministic rubric checks every plan, for example scope against changes and steps,
  step order, tests that fit the change, risks, unknowns and the analysis it should cite. It only informs you
  in the dashboard, `jerry task show` and Claude's MCP answers, and never blocks an approval
  ([ADR 0025](docs/decisions/0025-plan-completeness-grader.md)).
- Plan revisions: the dashboard ("Changes since v…") and `jerry plan diff <taskId>` show what changed between
  plan versions, section by section and scope first, so you review a revision without re-reading the whole
  plan ([ADR 0026](docs/decisions/0026-plan-version-diff.md)).
- Continuous quality while Claude implements. JERRY checks only the lines Claude changed, a moment after each
  edit. It never writes to the repository and never runs project commands.
  - Rule packs: naming and prose, error handling, test quality and security
    ([ADR 0028](docs/decisions/0028-rule-engine-and-packs.md)).
  - Findings carry severity P1–P4, evidence, why it matters and a fix. Claude hears about new ones with its next
    tool call, once each, at most two rounds ([ADR 0029](docs/decisions/0029-quality-scheduler-and-feedback.md)).
  - JERRY marks a finding fixed when a later check no longer sees it. Only you accept or dismiss one, with a
    reason, in the dashboard or with `jerry findings set`
    ([ADR 0027](docs/decisions/0027-findings-model.md)).
  - JERRY suggests the tests for the changed files, Claude runs them, and JERRY records how they ended. The
    report shows a check it claims passed that JERRY saw fail
    ([ADR 0030](docs/decisions/0030-targeted-tests-and-test-results.md)).
- `/jerry:implement`: alone or with up to three implementer subagents on disjoint files (`jerry_assign_work`).
  JERRY warns when an implementer edits outside its files or two agents write one file, and shows plan drift
  ([ADR 0031](docs/decisions/0031-implementers-conflicts-and-drift.md)).
- Independent code review (`/jerry:review`) after you accept an implementation. Three read-only reviewers
  check every changed file: correctness and tests, security and contracts, architecture, quality and UX.
  - JERRY shows coverage, reviewer independence and the merged findings, and warns if a reviewer writes
    ([ADR 0032](docs/decisions/0032-independent-review.md),
    [ADR 0033](docs/decisions/0033-reviewer-independence-and-read-only.md)).
  - A fix plan needs your approval (`jerry approve <id> --stage review-fix`); then the same reviewers check
    again, at most three rounds in total
    ([ADR 0034](docs/decisions/0034-review-report-and-fix-gate.md),
    [ADR 0035](docs/decisions/0035-fixes-and-re-review.md)).
  - DONE needs a passed review, or your waiver with a reason (`jerry review skip`).
- Evals (`jerry eval run`): golden cases run as real Claude Code sessions. Each attempt gets a temporary
  fixture repository, JERRY home and Core, so your repositories and JERRY data are never touched.
  - Graders are deterministic, execution, or LLM rubrics; a rubric counts only after calibration against your
    labels ([ADR 0036](docs/decisions/0036-golden-cases-and-fixtures.md),
    [ADR 0037](docs/decisions/0037-graders.md), [ADR 0038](docs/decisions/0038-eval-runner.md)).
  - Results are compared per case with your baseline; flaky runs are never called regressions, and a critical
    safety regression blocks the release ([ADR 0039](docs/decisions/0039-baselines-regressions-calibration.md)).
  - The dashboard's Evals view shows runs, regressions, calibration and what changed since the baseline;
    `jerry eval plugin` runs the Claude Code plugin evals of the JERRY plugin, never published
    ([ADR 0040](docs/decisions/0040-eval-dashboard-triggers-plugin-evals.md)).
- Final report for every task, assembled from what JERRY recorded: in the dashboard, with `jerry report <id>`,
  or through `jerry_get_final_report` ([ADR 0041](docs/decisions/0041-final-report.md)).
- An optional Artifact: `/jerry:artifact` asks whether you want Claude to create one (a stakeholder
  presentation, the architecture before and after, UI flows, or an endpoint and contract map). It is created
  only on yes, and JERRY records your choice and the link
  ([ADR 0042](docs/decisions/0042-artifact-is-the-users-choice.md)).
- Releases: `pnpm release` builds a versioned package with checksums; install, update and rollback are tested
  ([ADR 0043](docs/decisions/0043-release-package.md)).
- Task workflow states (spec §7.1), changed only through Core's transition validator, with full history. An
  approved plan covers edits only while its task is in implementation. Pause, resume and cancel are your
  decisions (dashboard or `jerry task pause|resume|cancel`)
  ([ADR 0012](docs/decisions/0012-workflow-states.md)).
- Sessions and tasks are linked: JERRY records which Claude Code session submitted, edited or checkpointed
  which task. Claude saves progress notes with `jerry_save_checkpoint`. A new, resumed or compacted session
  starts knowing the open tasks, their state and the last checkpoint
  ([ADR 0013](docs/decisions/0013-session-task-correlation-and-recovery.md)).
- `/jerry:report`: Claude reports the implementation. The report covers changed files, real check results
  (NOT_RUN with a reason, never an assumed PASS), differences from the plan, risks, QA scenarios and commit
  subjects. JERRY adds what it recorded itself: deviations, blocks, and edited files missing from the report.
  You accept exactly that report version, or send it back with a comment, in the dashboard or with
  `jerry approve|reject <id> --stage implementation`. `/jerry:commit-message` proposes commit messages in the
  repository's convention; you commit ([ADR 0014](docs/decisions/0014-implementation-report-and-acceptance.md)).
- DONE is set only by Core, in the step where you accept the report, after its final checks. A failed check, a
  critical risk, or code changed after the report keeps the task open with the reasons; you send it back or
  cancel it ([ADR 0016](docs/decisions/0016-done-validator.md)).
- Repository discovery, read-only. JERRY never writes to a repository, `.git` included.
  - Git baselines: Claude is warned before editing a file with your uncommitted changes, and reports and DONE
    see shell-made changes ([ADR 0017](docs/decisions/0017-git-baseline.md)).
  - A scanner detects the stack, the project's own commands, CI, API schemas and migrations
    ([ADR 0018](docs/decisions/0018-repository-scanner.md)).
  - It also indexes docs, project instruction files and suspicious repository text
    ([ADR 0019](docs/decisions/0019-docs-instructions-injection.md)).
  - A project profile kept outside the repository is refreshed when its sources change
    ([ADR 0020](docs/decisions/0020-project-profile.md)).
  - JERRY maps the links between repositories ([ADR 0021](docs/decisions/0021-workspace-graph.md)).
  - Claude reads all of this through `jerry_get_project_profile`. You see it in the dashboard (Repositories)
    and with `jerry repo scan|profile|graph`.
- JERRY Control Center at `http://127.0.0.1:47823` (open it with `jerry ui`): overview, tasks with their state,
  plan, history and the decisions their state allows, session timeline, repositories; installable as an app
  ([ADR 0009](docs/decisions/0009-dashboard.md)).
- MCP server in the plugin: read-only tools for the live plan state, path checks and recorded deviations,
  plus plan and report submission and progress checkpoints; nothing in it can approve, accept, pause or
  complete anything
  ([ADR 0008](docs/decisions/0008-local-mcp-server.md)).
- `jerry status` (quick summary) and `jerry doctor` (full diagnostics); the hook bridge loads no heavy
  dependencies, about 30 ms per guarded call ([ADR 0010](docs/decisions/0010-fast-bridge-cli-doctor.md)).
- `jerry` CLI (Commander, `jerry --help`): `install`, `uninstall`, `doctor`, `ui`, `core start|stop|status`,
  `task create|list|show|pause|resume|cancel`, `plan revise`, `approve`/`reject --stage plan|implementation`, `repo exclude|include|list|scan|profile|graph`,
  `events`, `db backup|backups|restore` (approve, reject, pause, resume, cancel, exclude and restore require an
  interactive terminal).

## Layout

```text
apps/core               JERRY Core (HTTP API, state, gate decisions)
apps/hook-bridge        Claude Code hook adapter → Core (bundled into the plugin)
apps/mcp-server         read-only MCP server for Claude (bundled into the plugin)
apps/dashboard          JERRY Control Center (Vue 3, TSX, Vite), served by Core
apps/cli                jerry CLI
packages/contracts      Zod schemas shared across processes
packages/database       SQLite (node:sqlite + Kysely): schema, migrations, backup and restore
packages/platform       JERRY_HOME, Core client, claude.exe discovery, atomic writes, home safety
packages/policy-engine  pure gate logic: paths, shell classification, approvals
packages/trace-engine   event envelopes, data minimization and redaction
packages/workflow       task workflow: the transition table Core validates every state change with
packages/discovery      read-only repository scanner, detectors, profile freshness, workspace graph
claude-plugin/          static plugin files (manifest, hooks.json)
tests/                  integration (bridge + Core) and install E2E
scripts/                build, hook benchmark, live Claude Code check
docs/                   spikes and architecture decision records (ADR)
```

## Development

Requires Node ≥ 22.13 (built-in `node:sqlite`) and corepack (pnpm is fetched by corepack; no global install needed).

```powershell
corepack pnpm install
corepack pnpm build          # dist/plugin, dist/core, dist/cli
corepack pnpm check          # typecheck + all tests
node dist/cli/jerry.mjs help
```

Install tests use an isolated `CLAUDE_CONFIG_DIR` and assert that the real `~/.claude` does not change.
`scripts/e2e-live.mjs` runs real Claude Code sessions on the signed-in account (haiku model) with the plugin
loaded through `--plugin-dir`, without changing any settings.

## Working rules

- The specification is the source of requirements; changes need a rationale and a version (ADR in `docs/decisions/`).
- Do not start the next phase before the critical tests of the current one pass.
- No real Claude Code OAuth tokens in tests or code; no external telemetry.
- No secret-shaped literals in the source, not even fake ones: the repository is scanned by GitGuardian.
  Tests assemble credential-like fixtures from fragments at runtime (see `packages/trace-engine/test/events.test.ts`).
- Commit, push and merge only with explicit approval.
- At most three subagents, at a time and per phase, in JERRY's workflows and in work on JERRY itself
  ([ADR 0015](docs/decisions/0015-at-most-three-subagents.md)).
- READMEs, code comments and ADRs are written in English.
