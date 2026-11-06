# ADR 0003 — JERRY monitors Claude Code and blocks only hard rules

- **Status:** accepted (product-owner decision)
- **Date:** 2026-11-06
- **Affects:** spec §1 (JR-008, JR-011, JR-016, JR-018), §7.2 (Phases 3–8), §8.2–8.3, §11.1, §19, §20; backlog M0 items 11–13, M2 "PreToolUse approval guard"
- **Builds on:** [ADR 0002](0002-jerry-never-modifies-repositories.md) (JERRY never modifies repositories)

## Context

The specification makes JERRY a hard gate: no code write before the user approves the exact plan
version (JR-008), and gates fail closed (JR-018). M0 implemented that gate.

The product owner wants to keep working with Claude Code freely. JERRY should check and control
Claude's work, not stop it. Git is the exception: all Git operations are done manually by the user,
and neither JERRY nor Claude may perform them.

## Decision

Every guarded tool call (Write, Edit, MultiEdit, NotebookEdit, Bash, PowerShell, Monitor) gets one verdict:

| Verdict | Effect | When |
|---|---|---|
| `PASS` | proceeds silently; Claude Code's own permissions decide | in the approved scope, read-only commands, outside repositories, excluded repositories |
| `WARN` | proceeds; recorded as a deviation; Claude gets `additionalContext`, the user gets a `systemMessage` | edit or write-capable command with no approved plan, or outside the approved plan's scope |
| `DENY` | blocked (hook exit 2) | hard rules only |

**Hard rules** (always enforced, including in excluded repositories and while Core is down):

1. Any command that changes Git state: `git` subcommands outside a read-only allowlist (status, diff, log,
   show, blame, …), Git extensions (`git-*`), mutating `gh` commands, `npm|pnpm|yarn version`, and Git invoked
   indirectly (`xargs git …`, `bash -c "git …"`, `Start-Process git`, sub-expressions).
2. Any write inside a `.git` directory.
3. Any write to, or command touching, JERRY data (`JERRY_HOME`) or the Claude Code settings and plugins
   that keep JERRY enabled.
4. An agent running user-only JERRY commands (`approve`, `reject`, `repo`, `install`, `uninstall`, `core`)
   or calling the Core API.

**Repository exclusion:** `jerry repo exclude <path>` turns monitoring off for one repository. Because
it weakens oversight, it requires an interactive terminal and a typed confirmation, like approvals.
`jerry repo include` and `jerry repo list` complete the set. Hard rules stay enforced in excluded repositories.

**Failure behaviour:**

- The bridge evaluates the hard rules locally before contacting Core, so they hold while Core is down.
- After the hard rules pass, any Core problem (down, hung, wrong token) lets the call proceed unrecorded:
  an outage costs monitoring, never Claude's ability to work. `jerry doctor` reports `DEGRADED`.
- If the hook input cannot be parsed, the hard rules cannot be checked, so the call is blocked.
- `hooks.json` keeps `onFailure: "block"`. It only takes effect when the bridge cannot run at all
  (`node` missing, a crash before the bridge code runs, a hook timeout). In that case JERRY cannot guarantee
  the Git rule, and a visible stop is preferred over silently allowing Git changes.

## Consequences for the specification (to be applied)

| Spec | Before | After |
|---|---|---|
| JR-008 | no code write before plan approval | plan approval is the baseline for deviation detection; writes without it are recorded and warned, not blocked |
| JR-011 | review fixes need a separate approval before they start | same model: a separate approved fix plan is the baseline; unapproved fixes are deviations |
| JR-016 | commit/push/merge/tag/deploy need separate user consent | Git state changes are made only by the user; Claude is blocked even with consent |
| JR-018 | Core failure during a gate blocks writes | Core failure turns monitoring off (`DEGRADED`); only hard rules fail closed |
| §8.3 gating rules | blocks for missing plan, hash mismatch, scope drift | these produce findings and warnings; DONE is still decided by Core from gates and findings |
| §20 status | `UNGUARDED` blocks implementation | `GUARDED` = monitoring + hard rules; `DEGRADED` = hard rules only; `UNGUARDED` = plugin not active |

## Evidence (live Claude Code sessions, `scripts/e2e-live.mjs`, 15/15)

- An edit without a plan is created; Claude quotes the JERRY warning and the gate log records `WARN`.
- With an approved plan (`src/**`), an in-scope edit is silent and an out-of-scope edit proceeds with a warning.
- `git add` (Bash) and `git commit` (PowerShell) are blocked; no commit or staging happens; this holds with Core stopped.
- When told the hard rules at SessionStart, the model does not even attempt Git changes. The hook is verified
  separately with a plugin copy that has no SessionStart hook, simulating a model that ignores its instructions.

## Known gaps

- Git run inside scripts the classifier cannot see (`npm run release`, a project script calling `git push`) is not detected.
- MCP tools of other servers (for example a GitHub MCP server that can push or merge) are not guarded yet.
- `git status` run by Claude may refresh `.git/index` stat data (an optional lock); content and history do not change.
