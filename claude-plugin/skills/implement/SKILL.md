---
name: implement
description: Implement an approved JERRY plan, alone or with up to three implementer subagents on disjoint files, with JERRY's continuous quality checks and targeted tests. Use when the user approved a plan and asks to implement it, or to split the implementation between implementers.
---

# Implement an approved plan with JERRY

The user approved one exact plan version. Implement that plan, within its scope. JERRY checks every changed
line as you go and tells you about problems. The user stays in charge of approvals and Git.

## 1. Check the starting point

- Call `jerry_get_state`. The task must be in implementation under an approved plan (`approved`). If not, stop:
  the plan needs the user's approval first (or `/jerry:plan` for a change).
- Read the plan's steps, files, tests and Definition of Done. Read `jerry_get_project_profile` for the
  project's commands and instruction files.
- Check `git status` (read-only). The user's uncommitted changes stay as they are.

## 2. Decide: alone or with implementers

- Small or tightly coupled work: implement it yourself, step by step in the plan's order.
- Independent parts with separate files: split them between at most three `jerry:jerry-implementer`
  subagents. Two implementers never share a file. Steps that touch the same file go to the same implementer
  or run one after the other.

To split, call `jerry_assign_work` with the task ID and one assignment per implementer: a label, its plan
steps and, if needed, its files. JERRY refuses overlapping files and unknown steps. It answers with the step
layers that may run in parallel.

Then start the implementers, at most three at a time, in one message for one layer. Give each:
- its label;
- its steps;
- its files;
- the plan's conventions and Definition of Done for its part.

Start the next layer when its dependencies are done.

## 3. While the work goes on

- JERRY adds new findings on the changed lines to your next tool call: rule, severity, file:line and a
  suggested fix. Fix P1 and P2 findings before moving on; fix the rest when they are in your files.
- If you disagree with a finding, tell the user why. Only the user dismisses findings
  (dashboard or `jerry findings set`).
- After two fix rounds that brought the same finding back, JERRY leaves it to the user; do not loop.
- Warnings about an implementer outside its files, or two writers on one file, mean stop that edit and
  reassign (a new `jerry_assign_work`) or serialize the steps.

## 4. Test

- `jerry_list_findings` returns `tests.run`: the project's test command limited to the test files of the
  changed files. Run it, then the project's full test, build, lint and typecheck commands from the profile.
  `tests.changedWithoutTests` lists changed files without a test file; the plan's tests say which to add.
- JERRY never runs these commands itself; it records how your runs ended. Report only real results.

## 5. Finish

When every step is done and the checks ran, write the report with `/jerry:report`. Include:
- the findings still open, and why;
- what the implementers did.

Never commit, push or change Git state: the user does all Git operations.
