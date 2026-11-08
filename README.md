# 🛡️ JERRY

A local guardian and agent harness for **Claude Code** and VS Code.
**One installation. Every project. Zero project footprint.**

JERRY watches what Claude Code does in your repositories, keeps every decision with you, and shows it all in a
local dashboard. It never changes your code and never touches Git: you do all Git operations yourself.

---

## ✨ What JERRY does for you

| | |
|---|---|
| 📋 **Plans you approve** | Claude drafts a plan for each change (goal, scope, steps, tests, risks). You approve the exact version. |
| 👀 **Monitoring, not blocking** | Edits without an approved plan, or outside its scope, go through but are recorded as deviations, and Claude and you are warned. |
| ⛔ **Hard rules, always enforced** | No Git command that changes anything, no writes inside `.git`, no tampering with JERRY's data or the settings that enable it, no approving its own work. These hold even when Core is down. |
| 🔎 **Analysis before the plan** | Up to three read-only analysts (architecture, risk, quality) study the repository; the plan cites their evidence. |
| 🐞 **Continuous quality** | JERRY checks the lines Claude changed (naming, error handling, test quality, security) and tells Claude about new findings. |
| 🔍 **Independent review, when you want it** | Three read-only reviewers check every changed file. It is optional by default: you ask for it when you accept a report, or make it required for all projects or one. Fixes need your approval, and the same reviewers check again. |
| 📄 **Reports from facts** | Implementation and final reports are built from what JERRY recorded, not from what Claude says: real test results, deviations, risks, and QA scenarios in Polish or English (your setting). |
| 📊 **Evals** | Golden cases run as real Claude Code sessions in throwaway fixtures, compared with a baseline to catch regressions. |
| 🎨 **Optional Artifact** | After a task is done, Claude can create a presentation or diagram in your claude.ai account, only if you say yes. |

### 🔄 The life of a task

```text
🔎 analysis → 📋 plan → ⏳ your approval → 🛠️ implementation → 📄 report → ⏳ your acceptance → 🏁 DONE
                                                  (optional) → 🔍 independent review → 🛠️ fixes you approve → 🏁 DONE
```

JERRY Core moves the task between states; only you approve, accept, waive, pause or cancel. When you accept a
report you choose whether it goes to independent review; with review required (globally or for a project) it always
does. A task already in review finishes when the review passes or when you skip it.

⏩ You decide in the dashboard (or the CLI) and Claude carries on by itself: after submitting a plan or a report, Claude
waits for your decision (up to about 6 minutes) and continues when you approve, or revises when you reject. You do
not have to type "go" in Claude.

🏁 Before DONE, Core runs its final checks. Files changed after the report block DONE, unless another approved task
changed them as part of its own work; those are listed in the final report as "Changed later by other tasks". When a
task is held back, re-run the checks with **Re-run final checks** on its tile or `jerry task recheck <id>`.

---

## 🚀 Getting started

Requirements: **Node.js ≥ 22.13** (built-in `node:sqlite`), **Claude Code**, and corepack (it fetches pnpm; no global install needed).

```powershell
corepack pnpm install
corepack pnpm build
node dist/cli/jerry.mjs install     # installs the plugin and Core for your Claude Code user
node dist/cli/jerry.mjs doctor      # checks that everything is in place
```

Then restart your Claude Code sessions and **add the projects JERRY should work in**:

```powershell
cd D:\path\to\your\project
jerry project add                   # asks you to type the path to confirm
```

📁 JERRY monitors only projects you added. In any other repository only the hard rules apply (no Git changes, no
tampering with JERRY), nothing is recorded, and Core is not contacted. JERRY starts its Core automatically.

🗂️ Working on several repositories together (say `api`, `shop` and `admin`)? Group them into a **workspace**, like a
VS Code workspace with several folders: **Projects → New workspace** (paste the folders, or let JERRY find the Git
repositories in a parent folder), or `jerry workspace create shop D:\Work\api D:\Work\shop D:\Work\admin`
(`--scan D:\Work` finds them). They become projects, the workspace gets its own page with the open tasks of all of
them, Tasks can be filtered by it, and a Claude Code session in any of them, or in their common folder, is told about
the workspace. Each repository keeps its own plans and tasks; deleting a workspace keeps the projects.

🔀 One feature that touches several of a workspace's repositories is **one task with one plan**: Claude plans it
from the repository that leads the change, gives every other repository its own scope (`repositoryScopes`) and names
the repository of each change and step, so each repository gets only its own changes. You approve the plan once.
JERRY then checks edits in each repository against that repository's scope, takes a Git baseline in each, keeps the
report's evidence and the final checks per repository, and lists the task in every repository it covers (a task bar
shows `+2` for two more). Only repositories of the same workspace that are projects can join a plan. A command that
changes files run in the workspace's parent folder, rather than inside a repository, is recorded as a deviation of the
workspace's open tasks.

Open the dashboard with `jerry ui`.

---

## 💬 In Claude Code: skills

| Skill | What it does |
|---|---|
| `/jerry:analyze` | 🔎 Runs up to three read-only analysts on a task and collects their evidence. |
| `/jerry:plan` | 📋 Drafts the plan from the real repository and submits it for your approval. |
| `/jerry:implement` | 🛠️ Implements the approved plan, alone or with up to three implementers on separate files. |
| `/jerry:report` | 📄 Writes the implementation report with real check results for your acceptance. |
| `/jerry:review` | 🔍 Runs the independent review with three reviewers, plans fixes, and re-reviews. |
| `/jerry:commit-message` | ✍️ Proposes commit messages in your repository's style. You commit. |
| `/jerry:artifact` | 🎨 Asks whether you want an Artifact for a finished task, and creates it only on yes. |

🔌 Claude talks to JERRY through the MCP server **`plugin:jerry:guardian`** (see `/mcp`). Its tools show up as
"Plugin Jerry Guardian [get_state]", "[submit_plan]" and so on, and each answer starts with a one-line summary such as
`📋 JRY-0012 plan v1 submitted · ⏳ waiting for your approval`. For permission rules, the tool ids are
`mcp__plugin_jerry_guardian__<tool>`. None of the tools can approve, accept or waive anything.

### ✨ Your own skills

Besides JERRY's `/jerry:*` skills you can add any Claude Code skill, for example one from GitHub. Open **Skills**
in the dashboard (or the Jerry app), click **Add skill** and give a GitHub URL (repository, folder or `SKILL.md`),
a `.zip`/`.skill` file or a local folder.

- 📂 From GitHub JERRY downloads only the skill's folder at one commit, never the whole repository, so a skill in a
  big repository (e.g. `https://github.com/Leonxlnx/taste-skill/tree/main/skills/taste-skill`) installs fine.
- 🧭 A repository URL with several skills lists them; pick one (in a terminal: one `jerry skill add <folder URL>`
  line per skill).
- 📏 A skill may have up to 50 MB and 5000 files (an uploaded zip up to 50 MB). Above 2 MB or 200 files the preview
  marks it as a large skill and sums up its scripts: read it with that in mind.

Skills you add are started only by JERRY, by task state, and used by Claude:

- 🎯 On the skill's page you tick the task states it belongs to (for example **Code review** and **Re-verification**).
  While a task is in one of them, JERRY's next action tells Claude to use the skill, and Claude runs it.
- 🧾 The skill list shows one full-width row per skill; a click opens its page with the scan, the task states and
  **Recent uses**: when Claude ran it, in which task, and whether that was in its states or a recorded deviation.
- 🙈 JERRY adds `user-invocable: false` to the skill's `SKILL.md`, so it is not in the `/` menu, and sets
  `skillOverrides` to `name-only`, so Claude sees only its name and never picks it on its own.
- ⚠️ If Claude uses the skill in another state, JERRY warns and records a deviation; it does not block.
- 🔁 A skill added before this is converted when you first choose its states (its folder is backed up first).

- 🔍 JERRY shows every file before installing, with its checksum, and flags risky content: instructions that try to
  steer Claude, scripts and binaries, network calls, secrets, and `allowed-tools` with shell access. Nothing is run.
- 📌 GitHub skills are pinned to the commit you saw; **Update** shows what changed and installs only after you confirm.
- 📁 Skills go to `~/.claude/skills/<name>`. JERRY never overwrites a skill it did not install.
- 🔀 The switch turns a skill off through Claude Code's own `skillOverrides` setting, without moving files. **Remove**
  keeps a backup in JERRY's data.
- ⌨️ The same from a terminal: `jerry skill list|show|add|enable|disable|update|remove`, and
  `jerry skill states <name> CODE_REVIEW REVERIFICATION` (or `--clear`) for the task states (changes are yours only 🔐).

---

## ⌨️ CLI: `jerry`

Run `jerry --help` or `jerry <command> --help` for every option. 🔐 marks decisions only you can make: they
need an interactive terminal, and Claude is not allowed to run them.

### 🩺 Setup and health

| Command | Purpose |
|---|---|
| `jerry install` | Install or update the plugin and Core for your Claude Code user. 🔐 |
| `jerry uninstall [--purge-data]` | Remove JERRY. Your data stays unless you pass `--purge-data`. 🔐 |
| `jerry doctor` | Full diagnostics: installation, hooks, Core, database, settings. |
| `jerry status` | Short summary: guard state, plans, today's deviations. |
| `jerry usage status` / `enable` / `disable` | 📊 Claude usage collection (status line + telemetry): what arrives from where. `enable`/`disable` 🔐 |
| `jerry statusline status` / `enable` / `disable` | Only the status line part. `enable`/`disable` 🔐 |
| `jerry ui` | Open the dashboard with a one-time login link. 🔐 |
| `jerry core start` / `stop` / `status` | Manage the local Core process. `start`/`stop` 🔐 |

### 🗂️ Tasks and plans

| Command | Purpose |
|---|---|
| `jerry task list` | Open tasks and their state. |
| `jerry task show <id>` | A task's state, plan, decisions and history. |
| `jerry task create` | Create a task with plan version 1. |
| `jerry task pause` / `resume` / `cancel <id>` | Pause, resume or cancel a task. 🔐 |
| `jerry task recheck <id>` | 🏁 Re-run the final checks of a task Core held back. 🔐 |
| `jerry plan diff <id>` | What changed between plan versions. |
| `jerry plan revise <id> --scope <glob>` | Create the next plan version with a new scope. |
| `jerry approve <id> --stage plan\|implementation\|review-fix --version <n>` | ✅ Approve a plan, accept a report (`--review` / `--no-review`), or approve review fixes. 🔐 |
| `jerry settings` / `settings set review.mode optional\|required [--project <path>]` / `settings set qa.language pl\|en` | ⚙️ Show or change JERRY's settings. `set` 🔐 |
| `jerry reject <id> --stage … --version <n> --comment "…"` | ❌ Reject, or ask for changes. 🔐 |

### 🔍 Quality, review and reports

| Command | Purpose |
|---|---|
| `jerry findings` / `findings show <id>` | 🐞 Quality findings and their evidence. |
| `jerry findings set <id> <status>` | Accept, dismiss as false positive or won't fix, with a reason. 🔐 |
| `jerry review show <id>` | Review rounds, coverage, reviewer independence, open findings. |
| `jerry review skip <id>` | Waive the review, with a reason. 🔐 |
| `jerry report <id>` | 📄 The final report of a task (a draft until it is done). |
| `jerry events` | The latest recorded session events. |

### 📁 Projects and repositories

| Command | Purpose |
|---|---|
| `jerry project add [path]` | Add a project: JERRY works there from now on (default: the current repository). 🔐 |
| `jerry project remove <path>` | Stop working in a project; its open tasks stay. 🔐 |
| `jerry project list` | Your projects, their open tasks and last activity. |
| `jerry workspace list\|show <name>` | Workspaces: several repositories under one name, with their open tasks. |
| `jerry workspace create <name> <folder>… [--scan <folder>]` | Create a workspace; its repositories become projects. 🔐 |
| `jerry workspace add\|remove <name> <folder>`, `rename <name> <new>`, `delete <name>` | Change a workspace; removing and deleting keep the projects. 🔐 |
| `jerry repo scan [path]` | What JERRY detects: languages, commands, CI, API schemas, migrations. |
| `jerry repo profile [path]` | The project profile JERRY keeps, with commands as they run on this machine. |
| `jerry repo graph` | Links between your repositories (shared packages, API contracts). |
| `jerry repo include` / `exclude <path>`, `repo list` | Older names for `project add` / `remove` / `list`. |

### 📊 Evals

| Command | Purpose |
|---|---|
| `jerry eval list` | The golden cases. |
| `jerry eval run` | Run cases as real Claude Code sessions (costs tokens) and compare with the baseline. |
| `jerry eval runs` / `show <runId>` / `status` | Runs, comparisons, calibration. |
| `jerry eval baseline <runId>` | Make a run the baseline. 🔐 |
| `jerry eval label …` | Your verdict on a rubric result, for calibration. 🔐 |
| `jerry eval plugin` | Claude Code's plugin evals for the JERRY plugin, never published. |

### 💾 Your data

| Command | Purpose |
|---|---|
| `jerry data` | What JERRY stores and how much space it takes: per category, per project, backups, logs. |
| `jerry data prune [--done-older-than N] [--events-older-than N] [--evals-older-than N] [--backups-keep N]` | Delete old data: shows exactly what would go, then asks you to type `delete`. 🔐 |
| `jerry data forget <path>` | Delete everything JERRY knows about one project (not while it has open tasks). 🔐 |
| `jerry db backup` / `backups` | Back up the database now, or list backups. |
| `jerry db restore <file>` | Restore a backup (Core stopped). 🔐 |

🛟 Prune and forget always take a backup first (`pre-prune` / `pre-forget`), delete in one transaction and give the
space back. Open tasks and eval baselines are never pruned. Session events are removed automatically after 90 days;
everything else stays until you prune it, which is fine: JERRY's data is usually a few dozen MB.

💡 If your terminal shows boxes instead of emoji, set `JERRY_NO_EMOJI=1` for plain CLI output.

---

## 🖥️ Dashboard: JERRY Control Center

`jerry ui` opens `http://127.0.0.1:47823` in your browser. It shows:
- **Overview:** the guard state and what needs you;
- **Tasks:** tiles with filters (active, waiting for you, in review, finished, cancelled). A tile expands to the key
  facts and the decisions its state allows; a click opens the task's page with its plan, analysis, report, review,
  final report and history;
- **Projects:** your projects as tiles, each with its own page (profile, tasks, links, data, review setting), and
  other repositories you can add;
- **Timeline:** session events;
- **Skills:** JERRY's skills and the ones you added: add, preview, switch off, update, remove;
- **Data:** what JERRY stores, with preview-first clean-up;
- **Evals:** where things stand (baseline, what changed since it, calibration) and the runs as rows; a click opens a
  run's own page with its cases against the baseline and **Make baseline**. **Run evals** starts `jerry eval run` in
  the background (after a confirmation: it starts real Claude Code sessions); its closable progress panel shows the
  output, can stop the run and opens the recorded run. It uses the CLI, plugin and cases that `jerry install` puts next
  to the installed Core; after updating from an older install, run `jerry install` once and restart Core;
- **⚙️ Settings** (bottom of the sidebar): review optional or required, QA language (Polish or English), how decisions
  are confirmed, Claude usage collection and the usage bar, theme; inside the Jerry app also its own settings (start
  with Windows, notifications).

✅ Decisions are one click by default: approving or rejecting a plan, accepting a report or requesting changes,
approving or rejecting a fix plan, skipping the review, cancelling a task, adding or removing a project, deleting data,
forgetting a repository, installing or removing a skill and choosing an eval baseline each open a confirmation dialog
that shows what you decide, with the decision button ready (Enter confirms, Escape cancels); pause and resume act at
once. To type what a decision is about (the task ID, the path, the skill name or `delete`), turn on
**⚙️ Settings → Workflow → Type the ID or name to confirm decisions**. The `jerry` CLI follows the same switch: a y/N
question, or the typed ID, path or name.

📋 Tasks are listed as full-width bars: ID and state, title, project and last activity in one row; the chevron unfolds
the facts and the decisions in place.

🎨 It uses the shadcn/ui look with the Geist font, in light, dark or your system's theme. It is reachable only from
your machine and needs the one-time login link.

---

## 📊 Claude usage

JERRY shows your Claude usage like Claude's `/usage`: two small bars (`23%` · *5h session*, `41%` · *Week session*) at the top of every dashboard view
(and in the Jerry tray tooltip), and a **Usage** card on the Overview with plan limits, tokens and estimated cost per
day, model, project and VS Code vs terminal, plus how much JERRY itself adds.

Where the numbers come from (documented Claude Code features only; JERRY never reads your conversations or your
Claude login):
- **Plan limits** (5-hour and weekly %): Claude Code passes them only to its **status line**, which runs in terminal
  sessions. The VS Code extension does not run it, so JERRY shows the **last known** values with the time they were
  read. The limits are account-wide: one message in a terminal session refreshes them. Per-model weekly limits are not
  available from Claude Code. Readings older than 30 minutes are shown greyed out as "stale".
  - 💡 **Live limits while you work in VS Code:** turn on the Claude Code extension setting **Use Terminal**
    (`"claudeCode.useTerminal": true`). Claude then runs in the VS Code terminal, the status line works, and JERRY
    gets fresh limits after every answer. The extension needs the Claude Code CLI on your PATH: install it with
    `irm https://claude.ai/install.ps1 | iex` and add `%USERPROFILE%\.local\bin` to your user PATH if the installer
    did not, then restart VS Code.
  - 🔤 For a readable terminal: `"terminal.integrated.fontFamily": "Cascadia Code"` (or Geist Mono),
    `"terminal.integrated.fontSize": 14`, `"terminal.integrated.lineHeight": 1.3`; `/theme` and `/terminal-setup` in
    Claude. Windows Terminal is a good alternative outside VS Code.
- **Tokens and cost**: Claude Code's **OpenTelemetry** metrics, sent every minute to the local JERRY Core on
  `127.0.0.1` with a per-install key. Cost is an estimate at list price, not your bill.

`jerry install` turns both on, after backing up `~/.claude/settings.json`. It writes only `statusLine` and a few
`env` keys (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`). If you already have your own status line, it keeps running
next to JERRY's. If you have your own OpenTelemetry setup, JERRY leaves it alone and does not collect tokens.
Turn it off in **⚙️ Settings → Usage**, with `jerry usage disable`, or by installing with `--no-usage`; your previous
settings come back exactly. Only sessions in your projects are stored, apart from the account-wide limit
percentages.

---

## 🪟 Jerry, the desktop app (optional, Windows)

A small desktop app around the same dashboard. JERRY works fine without it.

- 🖥️ **Dashboard window**, signed in automatically. Closing the window hides it to the tray.
- 🛡️ **Tray icon** with JERRY's state and how many things wait for you. Menu: Open dashboard, Start Core / Stop Core,
  Settings…, Quit.
- ⚙️ **Settings** are part of the dashboard's **⚙️ Settings** page, in a **Desktop app** card below Appearance (start
  with Windows, notifications, sound, test notification), saved as you change them. The tray's Settings… opens that
  page. The dashboard may call only these three settings commands of the app; while Core is not reachable the app
  shows its own settings page instead.
- 🔔 **Notifications** when a plan, a report or a fix plan waits for your decision, when a task is done or blocked,
  and when Core stops unexpectedly. Clicking one (while it is on screen) opens that task's page. Pick the sound in
  Settings: the Windows notification sounds or none (Windows does not allow custom sound files for this kind of app).
- ⚙️ **Settings**:
  - 🚀 launch with Windows (off by default);
  - open the window at start;
  - notifications on or off, per type, with or without sound, plus a test notification.

If you installed the earlier "JERRY Desktop", uninstall it once in Windows Settings → Apps; Jerry keeps its settings.

**Install** from the release package: run `desktop/Jerry-<version>-x64-setup.exe`. It installs for your
Windows user, no admin needed. The installer is not code-signed, so Windows SmartScreen may ask once; check
`SHA256SUMS` first.

**Build it yourself** (needs Rust from [rustup.rs](https://rustup.rs) and Visual Studio Build Tools with
"Desktop development with C++"):

```powershell
corepack pnpm desktop:build                 # dist/desktop/Jerry-<version>-x64-setup.exe
corepack pnpm release --with-desktop        # the release package with the installer inside
corepack pnpm desktop:test                  # the app's Rust tests
```

🔒 The app talks to Core only on `127.0.0.1`, keeps the Core token in its own process, and gives the dashboard page no
access to the app. Links to other sites open in your browser. Its settings live in the app's own folder, not in
JERRY's data.

---

## 🧩 What is in this repository

```text
apps/core               🧠 JERRY Core: local HTTP API on 127.0.0.1, state, gate decisions, quality checks
apps/hook-bridge        🪝 Claude Code hook adapter: forwards tool calls to Core and enforces hard rules
apps/mcp-server         🔌 MCP server: Claude's tools for state, plans, reports, reviews
apps/dashboard          🖥️ JERRY Control Center (Vue 3, TSX, Vite), served by Core
apps/cli                ⌨️ the jerry command line
apps/desktop            🪟 Jerry, the desktop app (Tauri): tray, notifications and the dashboard (optional)
packages/contracts      📐 shared schemas and constants (Zod), the emoji vocabulary
packages/database       💾 SQLite (node:sqlite + Kysely): schema, migrations, backup and restore
packages/platform       🧰 JERRY_HOME, Core client, Claude Code discovery, safe file writes
packages/policy-engine  ⚖️ gate logic: paths, shell command classification, hard rules
packages/trace-engine   🧾 session events, data minimization and redaction
packages/workflow       🔄 task states and the transitions Core validates
packages/discovery      🔎 read-only repository scanner, project profile, repository graph
packages/quality        🐞 quality rule packs and targeted test selection
packages/evals          📊 golden cases, graders, eval runner, baselines
claude-plugin/          🧩 plugin files: manifest, hooks, skills, agents, plugin evals
evals/cases/            🧪 golden eval cases
tests/                  ✅ integration and end-to-end tests
scripts/                🛠️ build, release, live Claude Code check, hook benchmark
```

### 🗄️ Where JERRY keeps its data

Everything lives in `JERRY_HOME` (on Windows `%LOCALAPPDATA%\JERRY`): the database, logs, backups, project
profiles and the list of your projects. Nothing is written into your repositories, `.git` included. `jerry data`
shows what is there.

---

## 👩‍💻 Development

```powershell
corepack pnpm install
corepack pnpm build          # dist/plugin, dist/core, dist/cli
corepack pnpm check          # typecheck + all tests
corepack pnpm release        # dist/release/jerry-<version>.tar.gz with checksums (--with-desktop adds the app)
node dist/cli/jerry.mjs --help
```

- 🧪 Install tests use an isolated `CLAUDE_CONFIG_DIR` and check that the real `~/.claude` does not change.
- 🤖 `node scripts/e2e-live.mjs` runs real Claude Code sessions (haiku) with the plugin loaded through
  `--plugin-dir`, without changing any settings.
- 🔐 No secret-shaped literals in the source, not even fake ones: tests build credential-like fixtures from
  fragments at runtime.
- 📝 Code, comments and this README are in English.
