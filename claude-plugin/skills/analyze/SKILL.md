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
- Call `get_state`. If an open task already covers this change, continue with it instead of starting a
  new one.
- Call `get_project_profile` for the stack, commands, instruction files and suspicious text.
- Decide the focus: repo-relative globs of the area the change will likely touch (`src/auth/**`,
  `tests/auth/**`). Keep it narrow; it becomes the analysts' starting point, not the approved scope.
- Classify the change with the plan's classification values (`ui-ux`, `frontend`, `api-backend`, `database`,
  `infrastructure`, `security`, `docs`, `tests`, `refactoring`, `tooling`).
- Call `start_task` with a short `title`, the `goal`, the `focus` and the `classification`. Pass
  `depth: "full"` only when the user asks for the full analysis. Note the task ID and the `analysts` it
  returns.

## 2. Run the analysts JERRY suggests (at most three)

JERRY sizes the analysis to the change: all three for security, database or infrastructure work, several
repositories, or a focus on API schemas or migrations; fewer for smaller changes; none for docs only (then go
straight to `/jerry:plan` with the task ID). Start exactly the analysts `start_task` returned, in parallel,
in one message, each with the Task/Agent tool:

| Subagent | Perspective |
|---|---|
| `jerry:jerry-architecture-analyst` | architecture and impact, API and contracts, data, links to other repositories |
| `jerry:jerry-risk-analyst` | security and threats, devil's advocate |
| `jerry:jerry-quality-analyst` | tests and QA, regression, UI/UX and accessibility |

- Never more than three subagents at a time. JERRY warns on a fourth.
- Run an analyst JERRY did not suggest only when the user asks for it. Their models and effort are the
  user's choice (dashboard, on this skill's page); do not pass a model yourself.
- Give each one the task ID, the goal, the focus globs and what in particular to look at. Tell it to submit
  its report with `submit_analysis_report` for that task ID.
- Analysts only read. Do not ask them to edit, run commands or fix anything.

## 3. Read the reports

- Call `get_analysis` with the task ID. It lists every report (observations with evidence, risks,
  recommendations, confidence, gaps), citations JERRY could not verify, and analysts that stopped without a
  report or timed out.
- If an analyst left no report, or its citations failed, you may run that one analyst once more with what
  was missing. Do not loop: after one retry, carry the gap into the plan.
- Check the most important observations yourself in the cited files before relying on them. A report is
  evidence, not a verdict.

## 4. Build the plan

Use `/jerry:plan` with the same task ID (`submit_plan` with `taskId`):

- Set `analysis.reports` to the IDs of the reports the plan uses, and `analysis.gaps` to every gap
  (a suggested analyst without a report, unverified citation, what an analyst could not check). If the plan
  turns out to be a bigger kind of change than the intake said (for example it adds `security`), name the
  analysts that did not run in `analysis.gaps`; JERRY's completeness check points this out.
- Turn the analysts' risks into plan risks with mitigations, their recommendations into changes, steps or
  tests, and their gaps into open questions or `UNKNOWN`.
- Where analysts disagree, say so in the plan and let the user decide (`openQuestions`).
- `scope.include` is what you will edit; it may be narrower or wider than the focus.

## 5. Hand over to the user

Tell the user the task ID and plan version, the analysts that reported, the main findings and gaps, and how
to approve the plan: in the JERRY dashboard (Tasks tab, `jerry ui`) or with
`jerry approve <taskId> --stage plan --version <n>`. Keep it short and end with one line on what waits and
where (one click in the dashboard).

Then do not end your turn: wait for the decision with `wait_for_decision` (`stage: plan`) and continue as
`/jerry:plan` describes in "Wait for the decision and continue": implement on approval, revise and resubmit
on rejection, and call it again while pending, at most 4 calls in a row. Never approve it yourself. Git
operations stay with the user.
