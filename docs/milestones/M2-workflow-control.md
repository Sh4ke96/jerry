# M2 — Workflow Control: completion report

**Date:** 2026-11-06 · **Environment:** Windows 11 Home 26300, Claude Code 2.1.318 (VS Code extension), Node 22.22.2.

## Backlog checklist

| Backlog item | Status | Where |
|---|---|---|
| Task intake and IDs | ✅ | `/jerry:plan` skill, `jerry_submit_plan`, `JRY-NNNN` IDs ([ADR 0011](../decisions/0011-plans-submitted-by-claude.md)) |
| Workflow state machine | ✅ | spec §7.1 states in `packages/workflow` ([ADR 0012](../decisions/0012-workflow-states.md)) |
| State transition validator | ✅ | one pure transition table with actors; Core applies it in the same transaction ([ADR 0012](../decisions/0012-workflow-states.md)) |
| Plan schema | ✅ | the 18 sections of spec §7.2 ([ADR 0011](../decisions/0011-plans-submitted-by-claude.md)) |
| Plan versioning and hash | ✅ | every version kept; the hash covers the whole document ([ADR 0011](../decisions/0011-plans-submitted-by-claude.md)) |
| Approval model | ✅ | approvals bound to version and hash, for plans and implementation reports ([ADR 0014](../decisions/0014-implementation-report-and-acceptance.md)) |
| Dashboard approve/reject actions | ✅ | typed confirmation; accept or request changes on reports |
| CLI approve/reject commands | ✅ | `jerry approve|reject --stage plan|implementation`, interactive terminal only |
| MCP read-only workflow status | ✅ | `jerry_get_state` with a state-aware next action |
| `PreToolUse` approval guard | ✅ | edits are covered only while the task is in implementation ([ADR 0003](../decisions/0003-monitor-not-block.md), [ADR 0012](../decisions/0012-workflow-states.md)) |
| Session/task correlation | ✅ | tool-use ID matched to the hook's record ([ADR 0013](../decisions/0013-session-task-correlation-and-recovery.md)) |
| Pause/resume | ✅ | `jerry task pause|resume|cancel`, dashboard buttons ([ADR 0012](../decisions/0012-workflow-states.md)) |
| Session recovery | ✅ | open tasks and checkpoints at SessionStart, also after resume and compaction ([ADR 0013](../decisions/0013-session-task-correlation-and-recovery.md)) |
| Final DONE validator | ✅ | Core-only DONE after its final checks ([ADR 0016](../decisions/0016-done-validator.md)) |

Beyond the backlog item list: implementation reports with JERRY's own record of what happened, and the
`/jerry:report` and `/jerry:commit-message` skills (ADR 0014).

## Product decisions taken during M2

- Only Core changes a task's state, through one transition table. User decisions stay with the user:
  approvals, acceptance, pause, resume and cancel. Claude submits plans, reports and checkpoints. Core alone
  sets DONE.
- `jerry task pause|resume|cancel` joined the user-only commands that the hard rules block for agents. The
  hard-rule text Claude receives is unchanged.
- A closed Claude Code session does not pause its task. The interruption is recorded on the session (ADR 0013).
- At most three subagents, at a time and per phase ([ADR 0015](../decisions/0015-at-most-three-subagents.md)).

## Measurements

- Hook bridge: 26 KiB, Zod-free; the workflow transition table is tree-shaken out of it.
- Start context: as in M1, plus roughly 40–120 tokens per open task shown (at most three).
- Tests: 359 passing. Live Claude Code check (`scripts/e2e-live.mjs`, scenarios A–K, haiku): 43/43. In
  scenario K the model's report said honestly that one plan step was still missing and claimed no check it had
  not run. Core then set DONE with "no check ran" and two deviations recorded as limitations.

## Known gaps carried forward

- Code changed by shell commands is not attributed to files; observed edits cover the file tools (ADR 0014).
- Whether the repository changed since a checkpoint (HEAD, diff baseline) arrives with the Git baseline
  snapshot in M3.
- The final report document of spec Phase 9 is M8; code review conditions on DONE come with M6.
- Whether JERRY blocks a fourth concurrent subagent is still the product owner's decision (ADR 0015).
