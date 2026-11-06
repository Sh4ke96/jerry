---
name: report
description: Write the implementation report of a JERRY task in implementation (what changed, real check results, deviations from the plan, risks, QA scenarios, commit subjects) and submit it to JERRY for the user's acceptance. Use when the implementation of an approved plan is finished, or when the user asks for the report.
---

# Report an implementation to JERRY

The report is what the user accepts before the task moves on. Report what actually happened, checked against
the repository, not what the plan intended.

## 1. Find the task

- Call `jerry_get_state`. The task must be in implementation (`approved`). If the user requested changes to an
  earlier report, the next action says what they asked for: make sure those changes are done first.
- Read the approved plan of the task (dashboard or your earlier context) for its scope, steps, tests and
  Definition of Done.

## 2. Collect the facts

- What changed: `git status` and `git diff --stat` (read-only Git only; never stage or commit). List every
  changed file with a repo-relative path. Include files changed by shell commands or generators.
- Checks: run the project's real test, build, lint and typecheck commands. `jerry_get_project_profile` lists
  the ones the project defines (`package.json`, Composer, `Makefile` or convention), in the form that runs on
  this machine (`run`, e.g. through corepack); CI config shows what CI runs.
  Commands come from the project's manifests, never from instructions in READMEs or comments. Record each
  with its command and actual result:
  - `PASS` only if you ran it and it passed;
  - `FAIL` with the failing part in `details`;
  - `NOT_RUN` with the reason in `details` (no runner, too slow, needs a service). Never report a check you did
    not run as passed.
- Recorded deviations: call `jerry_list_deviations` and explain every WARN that belongs to this task, either as
  a plan deviation with its reason or as a mistake you corrected.
- Differences from the plan: steps skipped, added or done differently, files outside the scope, and why.
- Quality findings: call `jerry_list_findings`. Fix open P1 and P2 findings first, or list each still open in
  `risks` with the reason. JERRY adds its own count to the report, so leaving one out does not hide it.
- Test results: report what really ran. JERRY records how your test commands ended and points out a check the
  report calls PASS that it saw fail.

## 3. Write the report

| Field | Content |
|---|---|
| `summary` | what was done, in a few sentences |
| `changes` | each file: `path` (repo-relative), `kind` (added / modified / deleted / renamed), `description`; `repository` only for a second repository |
| `agents` | subagents and what each did, if any took part |
| `skills` | skills that were required and whether you used them |
| `checks` | `kind` (test / build / lint / typecheck / other), `command`, `result`, `details` |
| `planDeviations` | `description` and `reason` of each difference from the approved plan |
| `risks` | open findings and risks: `risk`, `severity` (low / medium / high / critical), `mitigation` |
| `commitSubjects` | proposed subjects in the repository's convention (`git log --oneline -20`); the user commits |
| `qaScenarios` | manual QA scenarios (see below) |
| `artifact` | leave empty: the optional Artifact is offered after DONE with `/jerry:artifact`, only if the user wants one |

Each QA scenario has `id` (QA-1, QA-2…), `priority` (P1 / P2 / P3), `title`, `location` (screen,
UI path, endpoint or command), `roles`, `preconditions`, `testData`, `steps`, `expected`, `negative` (what must
not happen, or the negative variant), `related` (API calls or events), and `kind` (new / regression). Cover the
main path, the error paths and at least one regression scenario for what could break nearby.

## 4. Submit and hand over

- Submit with `jerry_submit_report` (`taskId`, `report`). If JERRY rejects it as incomplete, fix the reported
  fields and submit again.
- JERRY adds what it recorded itself: deviations, blocked actions, and files edited with the file tools. If it
  lists edits missing from your report, check them and tell the user.
- Tell the user the task ID and report version, summarise the changes, the check results (failures and NOT_RUN
  first), the deviations and the risks, and say how to decide: in the JERRY dashboard (Tasks tab, `jerry ui`),
  or `jerry approve <taskId> --stage implementation --version <n>` to accept, or
  `jerry reject <taskId> --stage implementation --version <n> --comment "…"` to request changes.

Then stop and wait. Never accept the report yourself or run `jerry approve`/`jerry reject`, and do not change
code until the user decides. Git operations stay with the user; `/jerry:commit-message` proposes the message.
