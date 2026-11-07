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
| 🔍 **Independent review** | Three read-only reviewers check every changed file. Fixes need your approval, and the same reviewers check again. |
| 📄 **Reports from facts** | Implementation and final reports are built from what JERRY recorded, not from what Claude says: real test results, deviations, risks, QA scenarios. |
| 📊 **Evals** | Golden cases run as real Claude Code sessions in throwaway fixtures, compared with a baseline to catch regressions. |
| 🎨 **Optional Artifact** | After a task is done, Claude can create a presentation or diagram in your claude.ai account, only if you say yes. |

### 🔄 The life of a task

```text
🔎 analysis → 📋 plan → ⏳ your approval → 🛠️ implementation → 📄 report → ⏳ your acceptance
   → 🔍 independent review → (🛠️ fixes you approve → 🔍 re-review) → 🏁 DONE
```

JERRY Core moves the task between states; only you approve, accept, waive, pause or cancel.

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
| `jerry ui` | Open the dashboard with a one-time login link. 🔐 |
| `jerry core start` / `stop` / `status` | Manage the local Core process. `start`/`stop` 🔐 |

### 🗂️ Tasks and plans

| Command | Purpose |
|---|---|
| `jerry task list` | Open tasks and their state. |
| `jerry task show <id>` | A task's state, plan, decisions and history. |
| `jerry task create` | Create a task with plan version 1. |
| `jerry task pause` / `resume` / `cancel <id>` | Pause, resume or cancel a task. 🔐 |
| `jerry plan diff <id>` | What changed between plan versions. |
| `jerry plan revise <id> --scope <glob>` | Create the next plan version with a new scope. |
| `jerry approve <id> --stage plan\|implementation\|review-fix --version <n>` | ✅ Approve a plan, accept a report, or approve review fixes. 🔐 |
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
- **Tasks:** the state, plan, analyses, reports, findings, review, final report and the decisions the state allows;
- **Timeline:** session events;
- **Repositories:** your projects (add and remove them), profiles and links;
- **Data:** what JERRY stores, with preview-first clean-up;
- **Evals:** runs, regressions and calibration.

🎨 It uses the shadcn/ui look with the Geist font. The theme switch in the top bar picks light, dark or your
system's theme. It is reachable only from your machine and needs the one-time login link.

---

## 🪟 JERRY Desktop (optional, Windows)

A small desktop app around the same dashboard. JERRY works fine without it.

- 🖥️ **Dashboard window**, signed in automatically. Closing the window hides it to the tray.
- 🛡️ **Tray icon** with JERRY's state and how many things wait for you. Menu: Open dashboard, Start Core / Stop Core,
  Settings…, Quit.
- 🔔 **Notifications** when a plan, a report or a fix plan waits for your decision, when a task is done or blocked,
  and when Core stops unexpectedly.
- ⚙️ **Settings**:
  - 🚀 launch with Windows (off by default);
  - open the window at start;
  - notifications on or off, per type, with or without sound, plus a test notification.

**Install** from the release package: run `desktop/JERRY-Desktop-<version>-x64-setup.exe`. It installs for your
Windows user, no admin needed. The installer is not code-signed, so Windows SmartScreen may ask once; check
`SHA256SUMS` first.

**Build it yourself** (needs Rust from [rustup.rs](https://rustup.rs) and Visual Studio Build Tools with
"Desktop development with C++"):

```powershell
corepack pnpm desktop:build                 # dist/desktop/JERRY-Desktop-<version>-x64-setup.exe
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
apps/desktop            🪟 JERRY Desktop: Tauri app with tray, notifications and the dashboard (optional)
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
