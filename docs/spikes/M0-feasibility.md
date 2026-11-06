# M0 — Feasibility spike: results

**Date:** 2026-11-06 · **Environment:** Windows 11 Home 26300, Claude Code 2.1.318 (binary shipped with the VS Code
extension), Node 22.22.2, PowerShell 5.1 (no PowerShell 7), Git for Windows 2.55 with Git Bash.

## M0 checklist

| # | Backlog item | Status | Evidence |
|---|---|---|---|
| 1 | Minimal plugin with a manifest | ✅ | `claude-plugin/`; `claude plugin validate` → passed (without `--strict`) |
| 2 | Local marketplace descriptor | ✅ | `jerry install` → `JERRY_HOME/marketplace/.claude-plugin/marketplace.json` |
| 3 | Marketplace installed through the official CLI, user scope | ✅ isolated profile | `tests/e2e/install-lifecycle.test.ts` |
| 4 | Plugin installed in user scope | ✅ isolated profile | same: `claude plugin list --json` → `enabled: true, scope: user` |
| 5 | Plugin verified in the CLI | ✅ | `scripts/e2e-live.mjs`: hooks fire in real `claude -p` sessions |
| 6 | Plugin verified in VS Code | ⏳ | needs an install into the real profile and a VS Code reload (user's decision) |
| 7 | `SessionStart` | ✅ | live sessions are registered in Core; context carries the actual plan state |
| 8 | `PreToolUse` for write tools | ✅ | Write/Edit/MultiEdit/NotebookEdit; live A, C |
| 9 | `PreToolUse` for shell tools on Windows | ✅ | Bash **and** PowerShell (both tools are active when Git Bash is installed); live B |
| 10 | Explicit shell and `onFailure` for the guard | ✅ (changed) | exec form without a shell + `onFailure: "block"`; [ADR 0001](../decisions/0001-hook-bridge-exec-form.md) |
| 11 | An unapproved task blocks writes | ✅ → changed by ADR 0003 | first proven as a block; now the write proceeds, is recorded and warned (live A) |
| 12 | An approved task allows only its scope | ✅ → changed by ADR 0003 | in scope is silent, out of scope proceeds with a warning (live C) |
| 13 | Fail-closed when Core is down | ✅ → changed by ADR 0003 | hard rules (Git, `.git`, JERRY data) stay blocked with Core stopped or hung; edits proceed unrecorded (live D) |
| 14 | No changes in the fixture repo | ✅ | snapshot of files + hashes (including `.git/`) + `git status` before/after |
| 15 | Safe uninstall | ✅ isolated profile | unrelated `settings.json` keys preserved, real `~/.claude` unchanged |

**M0 exit criteria** ("clean Windows 11 and a profile with an existing `settings.json`"): the profile with existing
settings is tested on an isolated `CLAUDE_CONFIG_DIR`. Still missing: (a) VS Code, (b) a clean Windows profile,
(c) the variant without Git Bash (PowerShell tool only; the docs describe different hook behaviour there).

## Findings

1. **Test isolation:** `CLAUDE_CONFIG_DIR` alone relocates both the settings *and* the `plugins/` directory, so
   install tests never touch the real profile (verified by a hash in the test).
2. **The official CLI merges safely:** `marketplace add`/`install` only add `extraKnownMarketplaces` and
   `enabledPlugins`. Key order changes, and empty `{}` objects remain after uninstall. Settings are semantically preserved.
3. **A plugin from a local marketplace loads in place** (`readFromFolder` = `JERRY_HOME/marketplace/plugins/jerry`),
   not from the cache. Updating means swapping the directory (staging + rename) and restarting sessions or running `/reload-plugins`.
4. **`add`/`install` are idempotent**; `uninstall`/`marketplace remove` return `failureCode: not_installed / not_configured`,
   which `jerry uninstall` treats as "already removed".
5. **Hooks fail open by default:** an exit code other than 0/2 and a timeout let the tool run. Fail-closed requires
   *both* `onFailure: "block"` and a bridge that turns every error into exit 2.
6. **`claude.exe` is not on `PATH`** when Claude Code is installed only as the VS Code extension.
   The CLI looks in: `JERRY_CLAUDE_BIN` → `PATH` → `~/.local/bin` → the newest VS Code extension.
7. **Key finding from the live sessions:** a generic SessionStart message ("edits only within an approved plan;
   prepare a plan") made the model refuse even a write covered by an *already approved* plan. SessionStart now
   states the concrete state: tasks, plan versions and scope for the session's repository. Lesson for M2: the model
   needs the current state (MCP `jerry_get_approval_status`), not general rules. An approval granted mid-session
   does not reach the context today.
8. **Guard latency:** ~107 ms per guarded call in exec form, ~290 ms through PowerShell 5.1 (ADR 0001).
9. **Warnings reach both sides:** a `PreToolUse` output with `additionalContext` and `systemMessage` and no
   `permissionDecision` lets the call proceed; Claude quotes the warning back verbatim (live A, C).
10. **Told rules are followed:** once the SessionStart context lists the hard rules, the model declines Git
    changes without attempting them. Enforcement is therefore tested with a plugin copy that has no
    SessionStart hook (live B, D).

## Known gaps (per spec §8.4: hooks are not an OS sandbox)

See also the gaps listed in [ADR 0003](../decisions/0003-monitor-not-block.md).

- A write-capable command run from a directory **outside** any repository (e.g. `cd D:/repo && rm …` from `C:/Temp`)
  is not recorded as a deviation (`monitor.outside-repository`). Git changes are still blocked there.
- The shell classifier is an allowlist, not a parser: it is conservative (doubt means write-capable), so it can be
  annoying and needs calibration.
- Tools from other MCP servers (`mcp__*`) are not guarded.
- The Core token lives in `JERRY_HOME/run/core.json`, readable by the user's processes. The agent cannot read it or
  call the API through guarded tools (`shell.protected-path`, `shell.core-api`), but the `Read` tool is not guarded.
- `jerry approve` requires a TTY and typing the task ID. Claude's shell tools have no TTY. In Git Bash/mintty Node
  does not see a TTY, so approvals must be made from PowerShell or the VS Code terminal (or through `winpty`).
- With an approved plan, write-capable shell commands pass without a scope check, because JERRY cannot tell
  which files they touch. Detecting the actual file changes (diff collector) is an M5 item.

## Deviations from the specification (to decide / update the spec)

| Spec | M0 | Reason |
|---|---|---|
| `hooks/bridge.ps1`, `shell: powershell` | `bridge.mjs` in exec form | ADR 0001 |
| SQLite from the start of Core | JSON state (atomic writes) behind the `StateStore` interface | SQLite is an M1 item; the seam is ready |
| Commander/oclif for the CLI | `node:util parseArgs` | dependency-free spike; decide in M1 |
| `packages/windows` | `packages/platform` | `JERRY_HOME`, `claude.exe` discovery and the Core client are not Windows-specific |
| §5.4, §12, §14.3, §22 | JERRY may write into projects in some flows | [ADR 0002](../decisions/0002-jerry-never-modifies-repositories.md): JERRY never modifies repositories |
| JR-008, JR-011, JR-016, JR-018, §8.3 | hard approval gate, fail-closed | [ADR 0003](../decisions/0003-monitor-not-block.md): monitor and warn; block only hard rules (Git, `.git`, JERRY data) |

## How to reproduce

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm test                 # unit + integration + install E2E (isolated Claude profile)
node scripts/bench-hook.mjs 20     # hook latency
node scripts/e2e-live.mjs          # real Claude Code sessions (haiku), plugin via --plugin-dir
```
