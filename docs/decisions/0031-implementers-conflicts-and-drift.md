# ADR 0031 — Implementers: task DAG, disjoint assignments, conflicting writes and plan drift

- **Status:** accepted (M5 steps 6–7, task JRY-0005)
- **Date:** 2026-11-06
- **Affects:** spec §7.2 Phase 4 (sub-tasks with clear scope, parallel independent tasks, serialized
  conflicting edits, every change compared with the plan), ADR 0015 (at most three subagents), ADR 0003
  (warn, block only hard rules); roadmap M5 "Implementation task DAG", "File-scope assignment", "Conflicting
  writes serialization", "Plan drift detector", "Agent concurrency cap"

## Decision

- **Task DAG.** `planLayers` orders the plan's steps by `dependsOn` into layers. Steps in one layer may run in
  parallel. Cycles and dependencies on missing steps are reported as blocked.
- **Assignments.** `jerry_assign_work` (MCP) → `POST /api/v1/tasks/:id/assignments` records up to three
  implementers.
  - Each has a label, plan steps and files: by default the files of its steps, all inside the approved scope.
  - Core refuses:
    - overlapping files (a conservative glob overlap check);
    - unknown steps;
    - more than three implementers;
    - tasks not under an approved plan.
  - A new set replaces the previous one (migration 0014, `implementer_assignments`).
- **Work order for implementers.**
  - While a plan is implemented, `jerry_get_state` returns the plan's goal, every step with its files and
    dependencies, the Definition of Done, and the assignments (label, steps, files, started).
  - The first live run showed implementers stopping because they could not see the step text. They now start
    from this work order.
- **Binding without prompt parsing.** A `jerry-implementer` subagent is bound to the one free assignment
  whose files contain the first file it edits. JERRY never reads prompts to find out.
- **Warnings (never blocks):**
  - `monitor.concurrent-write`: a file the task's running subagent wrote recently is now written by another
    agent or the main session. Spec §7.2 asks for conflicting edits to be serialized; JERRY says so and leaves
    the coordination to the orchestrator.
  - `monitor.implementer-scope`: an implementer edits outside its assignment, a file assigned to another
    implementer, or a file in no assignment.
  - These checks run in the gate synchronously from memory (assignments, last writer per file), plus agent
    runs from SQLite.
- **Concurrency cap.** The warning before a fourth subagent exists since ADR 0023. Blocking it would be a new
  hard rule, which is the product owner's decision.
- **Plan drift** (`GET /api/v1/tasks/:id/drift`, dashboard "Plan drift", report evidence):
  - in-scope files changed since approval that no plan step or change names;
  - steps with files none of which changed yet;
  - the layers;
  - the assignments with their bound implementers.
- **Report and final checks.** The report evidence adds `quality`:
  - open findings, with the open P1/P2 ones listed;
  - the latest observed test run;
  - checks the report calls PASS that JERRY saw end otherwise;
  - unplanned files and untouched steps.

  The DONE validator records open P1/P2 findings and contradicted claims as limitations (non-blocking): the
  product owner's proposal was that open P1 findings do not block DONE.
- **Skill.** `/jerry:implement` covers: alone or split; `jerry_assign_work`; layers; findings and the
  two-round limit; targeted tests; the report. The implementer agent's instructions say the same, and it can
  read findings.

## Consequences

- When the main session hands a file to an implementer that is still running, the next edit is warned about
  until that implementer stops. This is intended: a running writer means the file is not handed over yet.
