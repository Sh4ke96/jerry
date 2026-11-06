# ADR 0012 — Task workflow states, validated only by Core

- **Status:** accepted (M2 item 2, task JRY-0002)
- **Date:** 2026-11-06
- **Affects:** spec §7.1 (workflow states), §7.2 Phase 9 (DONE is not set by a model), §17 (database); backlog M2
  "Workflow state machine", "Pause, resume, cancel"

## Context

Until now a task had no state. Whether its plan covered edits depended only on the latest decision for the
current plan version. That could not express "the implementation is finished and waits for acceptance",
"paused" or "cancelled". It also gave the dashboard and Claude no answer to "what happens next".

## Decision

- **States** (spec §7.1):
  - DISCOVERY, PARALLEL_ANALYSIS;
  - PLAN_DRAFT, WAIT_PLAN_APPROVAL;
  - IMPLEMENTATION, IMPLEMENTATION_REPORT, WAIT_IMPLEMENTATION_ACCEPTANCE;
  - CODE_REVIEW, REVIEW_REPORT, WAIT_REVIEW_FIX_APPROVAL, FIX_IMPLEMENTATION, REVERIFICATION;
  - FINAL_REPORT, DONE, BLOCKED, plus PAUSED and CANCELLED.

  The review states exist from the start, so later milestones only add transitions.
- **One pure transition table** (`packages/workflow`) decides every change. It records who may cause each
  event:

  | Event | From | To | Who |
  |---|---|---|---|
  | `plan.submitted` | new | WAIT_PLAN_APPROVAL | user, Claude |
  | `plan.revised` | discovery, analysis, PLAN_DRAFT, WAIT_PLAN_APPROVAL, IMPLEMENTATION, WAIT_IMPLEMENTATION_ACCEPTANCE, BLOCKED | WAIT_PLAN_APPROVAL | user, Claude |
  | `plan.approved` | WAIT_PLAN_APPROVAL, PLAN_DRAFT | IMPLEMENTATION | user |
  | `plan.rejected` | WAIT_PLAN_APPROVAL, IMPLEMENTATION (withdraws the approval) | PLAN_DRAFT | user |
  | `report.submitted` | IMPLEMENTATION | WAIT_IMPLEMENTATION_ACCEPTANCE | Claude, user |
  | `changes.requested` | WAIT_IMPLEMENTATION_ACCEPTANCE | IMPLEMENTATION | user |
  | `implementation.accepted` | WAIT_IMPLEMENTATION_ACCEPTANCE | FINAL_REPORT | user |
  | `task.completed` | FINAL_REPORT | DONE | Core only |
  | `task.paused` | any open state | PAUSED | user |
  | `task.resumed` | PAUSED | the state it was paused in | user |
  | `task.cancelled` | any open state, PAUSED | CANCELLED | user |

  DONE and CANCELLED are final. Until independent review exists (M6), an accepted implementation goes straight
  to the final checks.
- **Core is the only writer.** The state store reads the current state inside the same SQLite transaction
  that applies the change, so two concurrent requests cannot both pass the check. A refused step returns
  HTTP 409 with the reason and leaves no trace: no transition, approval or plan version.
- **History:** every transition goes to `workflow_transitions` (from, to, event, actor, reason, time). The
  history is how resume finds the state from before the pause.
- **Migration `0004_workflow`:**
  - adds `tasks.state`;
  - derives the state of existing tasks with the rule the gate used before: the latest decision on the
    current plan version and hash gives approved → IMPLEMENTATION, rejected → PLAN_DRAFT, otherwise
    WAIT_PLAN_APPROVAL;
  - the M0 JSON import uses the same rule.
- **An approved plan covers edits only while its task is being implemented** (IMPLEMENTATION, later also
  FIX_IMPLEMENTATION) and the user approved exactly its current version. A paused task, one waiting for
  acceptance, a finished one and a cancelled one cover nothing: edits are recorded as deviations and Claude is
  warned. Edits are never blocked (ADR 0003).
- **User decisions:**
  - Pause, resume and cancel go through `POST /api/v1/tasks/:id/transitions`. That endpoint accepts only these
    three events. Plans and approvals keep their own endpoints.
  - In the CLI, `jerry task pause|resume|cancel` need an interactive terminal; cancel also needs the task ID
    typed.
  - In the dashboard, pause and resume are one click; cancel needs the typed task ID.
  - The hard rule `hard.user-only-command` now also blocks agents from running `jerry task pause|resume|cancel`.
    This only tightens enforcement; the hard-rule text Claude sees at SessionStart is unchanged.
- **Claude's view:**
  - `jerry_get_state` lists open tasks with their state, the plans that cover edits now, and a state-aware
    next action: `work-within-approved-scope`, `wait-for-approval`, `wait-for-acceptance`, `paused`,
    `revise-plan` or `propose-plan`.
  - Finished and cancelled tasks are left out to keep the answer short.
  - `jerry_submit_plan` returns the new state.
- **Visibility:**
  - The dashboard shows a state badge, only the actions the workflow allows in that state, and the history on
    demand. Finished and cancelled tasks are folded away.
  - `jerry task list` shows open tasks with their state (`--all` for every task).
  - `jerry task show <id>` prints the plan, the decision and the history.
  - `jerry status` counts tasks in implementation, waiting and paused.

## Evidence

- Unit tests (`packages/workflow`):
  - the happy path to DONE, and the loops back on rejection, revision and requested changes;
  - every user decision refuses Claude and Core, and only Core can complete;
  - pause and resume return to the previous state;
  - nothing leaves DONE or CANCELLED, and cancel works from every open state;
  - a task is created only through a first plan.
- Gate tests: only IMPLEMENTATION and FIX_IMPLEMENTATION cover edits. `jerry task pause|resume|cancel` is
  blocked for agents, while `task show` and `task list --all` count as read-only.
- Migration test: tasks that were approved, withdrawn, revised after approval and never decided get the
  expected states.
- Integration tests:
  - the store keeps the full history across restart, refuses invalid steps with 409 without side effects, and
    the M0 import gets a state;
  - the API: pause, resume and cancel from the dashboard, cancel only with the typed ID, CSRF required, other
    events refused;
  - MCP state for waiting, in implementation, paused and cancelled tasks;
  - the CLI: list, show, and the terminal requirement;
  - the dashboard: state-dependent buttons, pause, typed cancel, history.
- Live (`scripts/e2e-live.mjs`, scenario I): a real Claude Code session edits inside the scope of a paused task.
  The edit goes through and is recorded as a deviation; through `jerry_get_state` Claude sees that the task is
  paused. Resume returns the task to IMPLEMENTATION.

## Consequences

- Reaching WAIT_IMPLEMENTATION_ACCEPTANCE, FINAL_REPORT and DONE needs the implementation report and the DONE
  validator (M2 items 4 and 5). Until then, tasks that were approved before this change stay in
  IMPLEMENTATION, and the user can cancel or pause them.
- Approving a plan that is already being implemented is refused (409): there is no second approval of the same
  version.
