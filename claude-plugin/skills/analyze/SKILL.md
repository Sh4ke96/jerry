---
name: analyze
description: Analyse a planned change with JERRY's read-only analysts (architecture, risk, quality) before planning it, then build the plan from their evidence-backed reports. Use for a non-trivial change (new feature, cross-cutting refactoring, security- or data-sensitive work) in a repository JERRY monitors, or when the user asks for an analysis first.
---

# Analyse a change with JERRY, then plan it

Read-only analysts look at the repository from separate perspectives and report with `path:line` evidence.
The plan you then write rests on what they found, not on assumptions. Nothing here changes code: edits before
the user approves the plan are recorded as deviations.

## 1. Take in the task

- Restate the goal in one or two sentences. If something essential is missing, ask the user first.
- Call `jerry_get_state`. If an open task already covers this change, continue with it instead of starting a
  new one.
- Call `jerry_get_project_profile` for the stack, commands, instruction files and suspicious text.
- Decide the focus: repo-relative globs of the area the change will likely touch (`src/auth/**`,
  `tests/auth/**`). Keep it narrow; it becomes the analysts' starting point, not the approved scope.
- Call `jerry_start_task` with a short `title`, the `goal` and the `focus`. Note the task ID it returns.

## 2. Run the analysts (at most three)

Start them in parallel, in one message, each with the Task/Agent tool:

| Subagent | Perspective |
|---|---|
| `jerry:jerry-architecture-analyst` | architecture and impact, API and contracts, data, links to other repositories |
| `jerry:jerry-risk-analyst` | security and threats, devil's advocate |
| `jerry:jerry-quality-analyst` | tests and QA, regression, UI/UX and accessibility |

- Never more than three subagents at a time. JERRY warns on a fourth.
- Choose the ones the change needs. A backend change without UI still gets the quality analyst for tests. A
  docs-only change may need none (go straight to `/jerry:plan` with the task ID).
- Give each one the task ID, the goal, the focus globs and what in particular to look at. Tell it to submit
  its report with `jerry_submit_analysis_report` for that task ID.
- Analysts only read. Do not ask them to edit, run commands or fix anything.

## 3. Read the reports

- Call `jerry_get_analysis` with the task ID. It lists every report (observations with evidence, risks,
  recommendations, confidence, gaps), citations JERRY could not verify, and analysts that stopped without a
  report or timed out.
- If an analyst left no report, or its citations failed, you may run that one analyst once more with what
  was missing. Do not loop: after one retry, carry the gap into the plan.
- Check the most important observations yourself in the cited files before relying on them. A report is
  evidence, not a verdict.

## 4. Build the plan

Use `/jerry:plan` with the same task ID (`jerry_submit_plan` with `taskId`):

- Set `analysis.reports` to the IDs of the reports the plan uses, and `analysis.gaps` to every gap
  (missing analyst, unverified citation, what an analyst could not check).
- Turn the analysts' risks into plan risks with mitigations, their recommendations into changes, steps or
  tests, and their gaps into open questions or `UNKNOWN`.
- Where analysts disagree, say so in the plan and let the user decide (`openQuestions`).
- `scope.include` is what you will edit; it may be narrower or wider than the focus.

## 5. Hand over to the user

Tell the user the task ID and plan version, the analysts that reported, the main findings and gaps, and how
to approve the plan: in the JERRY dashboard (Tasks tab, `jerry ui`) or with
`jerry approve <taskId> --stage plan --version <n>`. Never approve it yourself. Git operations stay with the
user.
