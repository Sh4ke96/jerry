# ADR 0037 — Graders: deterministic, execution, and calibrated LLM rubrics

- **Status:** accepted (M7 step 2, task JRY-0007)
- **Date:** 2026-11-06
- **Affects:** spec §13.4 (deterministic, execution, rubric/LLM graders, human calibration), §13.5 (no
  weakening of criteria to pass); roadmap M7 "Deterministic graders", "Execution graders", "LLM rubric graders"

## Decision

- **Deterministic graders** read the session's final answer, the fixture and what JERRY recorded in the
  attempt's own database:
  - `output-matches` (regex, or its negation);
  - `file` (exists or not, contains or not);
  - `git-unchanged` (HEAD and index as before);
  - `gate` (how many gate decisions match a tool, verdict and rule, between a minimum and a maximum);
  - `tool-used` (a tool or subagent type, or its absence);
  - `task-state`;
  - `paths-allowlist` (every changed file inside the globs);
  - `budget` (the session's reported cost; it is also passed to Claude Code as `--max-budget-usd`).
- **Execution graders** (`command`) run a command in the fixture repository with a timeout and check its exit
  code. This is the harness's own throwaway repository, never the user's.
- **LLM rubric graders** (`rubric`):
  - the same Claude Code binary scores the answer from 0 to 1, with the grader's pinned model and no tools,
    answering in JSON;
  - the score counts only when the rubric is calibrated (ADR 0039); until then it is recorded, shown, and
    not counted;
  - an attempt whose only graders are uncalibrated rubrics is ERROR, not PASS.
- **A grader that throws** is a failed grader with the error in its detail, never a silent pass.

## Consequences

- Changing a grader changes what a case measures. Such changes go through review like code, and must not
  weaken a criterion to make a case pass (spec §13.5).
