# JERRY user guide

JERRY is a local guardian for Claude Code. It keeps Git and every decision with you, shows what Claude does,
checks the quality of what it writes, and has its work independently reviewed. It never writes into your
repositories.

## 1. Install

Requirements: Windows, macOS or Linux; Node.js 22.13 or newer; Claude Code (CLI or the VS Code extension).

1. Unpack the release package (`jerry-<version>.tar.gz`) anywhere outside your projects, and check it against
   `SHA256SUMS`.
2. Run `node jerry-<version>/cli/jerry.mjs install`. This installs the JERRY plugin in Claude Code (user
   scope) and JERRY Core in `JERRY_HOME` (default `%LOCALAPPDATA%\JERRY` on Windows).
3. Restart your Claude Code sessions, then run `jerry doctor`: every check should pass.

In the commands below, `jerry` stands for `node <package>/cli/jerry.mjs`, or for an alias you make.

**Update:** install the newer package the same way, then `jerry core stop` and `jerry core start`. Your data
stays, and the database is backed up before every migration.

**Roll back:** install the previous package. If needed, `jerry db backups` lists backups and
`jerry db restore <file>` restores one (interactive).

**Uninstall:** `jerry uninstall` keeps your data; `jerry uninstall --purge-data` removes it.

## 2. What JERRY always enforces (hard rules)

- Only you run Git operations that change anything: commit, push, merge, rebase, checkout, reset, stash and
  similar. Claude may read Git (status, diff, log, show).
- Nothing is written inside `.git`, into JERRY's data, or into the Claude Code settings that keep JERRY on.
- Approvals and the other user-only commands are yours. Claude cannot approve its own plan.

Everything else is monitoring: JERRY lets Claude work and warns about deviations. It does not block them.

## 3. The daily workflow

| Step | Claude (in Claude Code) | You |
|---|---|---|
| Analyse (optional) | `/jerry:analyze <change>`: up to three read-only analysts report with evidence | read the findings |
| Plan | `/jerry:plan <change>`: a full plan, with a completeness check | approve: dashboard, or `jerry approve <id> --stage plan --version <n>` |
| Implement | `/jerry:implement`: alone or with up to three implementers on separate files; JERRY checks changed lines and reports findings to Claude | watch the dashboard |
| Report | `/jerry:report`: what changed, real test results, deviations | accept, or request changes: `--stage implementation` |
| Review | `/jerry:review`: three independent read-only reviewers check every changed file | approve a fix plan (`--stage review-fix`), or waive the review (`jerry review skip`) |
| Done | JERRY's final checks set DONE | read the final report: dashboard or `jerry report <id>` |
| Artifact (optional) | `/jerry:artifact` asks whether you want one, and creates it only on yes | choose |
| Commit | `/jerry:commit-message` proposes messages | you commit |

Edits before a plan is approved are allowed but recorded as deviations. Editing a file that has your
uncommitted changes is warned about, and your lines are kept.

## 4. The dashboard

Open it with `jerry ui`; it signs you in with a one-time link.

- **Overview:** the guard state, decisions waiting for you, recent deviations.
- **Tasks:**
  - every task with its plan (and changes since the last version), analysis, plan completeness, quality
    findings, last tests, review, plan drift and history;
  - the final report and the Artifact link;
  - your decisions, each confirmed by typing the task ID.
- **Timeline:** every recorded session event.
- **Repositories:** project profiles, instruction files, suspicious text and links between repositories.
- **Evals:** eval runs against your baseline.

## 5. Quality findings

JERRY checks only the lines Claude changed, a moment after each edit: naming and prose, error handling, test
quality and security.
- Claude is told about new findings with its next tool call.
- A finding closes itself when the code no longer has it.
- You dismiss a finding with a reason: the dashboard or `jerry findings set <id> false_positive`.
- Three false positives mute a rule.

## 6. Evals

`jerry eval run` runs JERRY's golden cases as real Claude Code sessions. Each runs in a temporary repository,
JERRY home and Core, so your work and data are never touched. It costs tokens.

- `jerry eval status`: the baseline, and whether anything changed since it.
- `jerry eval baseline <run>`: makes a run the baseline (interactive, with a reason).
- `jerry eval label …`: labels rubric results, to calibrate LLM graders.
- `jerry eval plugin --trust`: runs Claude Code's own plugin evals for JERRY; reports are never published.
- Only run case directories you trust (`--dir`): cases can run commands in their fixtures.

## 7. Troubleshooting

- **`jerry doctor`:** a full diagnosis of the plugin, hooks, Core, database and settings.
- **"Core is not reachable":** run `jerry core start`. Hard rules still apply without Core.
- **The dashboard looks wrong after an update:** restart Core. A running Core serves the dashboard of its own
  version.
- **A hard rule blocked something harmless:** report it. Hard rules change only with the owner's approval
  (see `docs/security/audit.md`).
