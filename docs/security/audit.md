# JERRY security audit

- **Version audited:** 0.1.0 (task JRY-0008, M8)
- **Date:** 2026-11-06
- **Scope:** every trust boundary of JERRY on one developer machine. The same OS user runs Claude Code, JERRY
  Core, the CLI, the dashboard (in a browser) and the evals.
- **Method:** code review of each boundary against what an agent (Claude Code, its subagents, a prompt
  injected through repository text) or another local web page could do; verified behaviour in tests and live
  runs.

## Threat model

JERRY guards a user against an AI agent working in their repositories. The agent runs as the user, with the
user's file permissions. JERRY therefore cannot be a security boundary against a determined attacker with the
user's privileges. Its job is:
- to stop accidental or naive harmful actions (hard rules);
- to make everything else visible (monitoring, evidence);
- to keep decisions with the user (approvals).

The relevant attackers are:
1. the agent following its instructions too eagerly;
2. the agent following instructions planted in repository text (prompt injection);
3. a web page in the user's browser trying to reach Core on localhost.

## Trust boundaries and findings

| # | Boundary | Finding | Severity | Status |
|---|---|---|---|---|
| F1 | Agent → Core API | Read, Grep and Glob are not guarded by the hook. An agent can read `JERRY_HOME/run/core.json` (the Core token) and call the API without the literal `/api/v1/` in a shell command, for example from a script built from fragments. That bypasses `hard.core-api` and could approve its own plan. | High | **Decision for the product owner** (below) |
| F2 | Eval case files → shell | A case's `command` graders run shell commands in its fixture, and its prompt runs Claude Code with edit permissions there. `jerry eval run --dir <untrusted>` would run someone else's commands. | Medium | Fixed: the CLI warns for case directories other than JERRY's own; documented in the user guide |
| F3 | Claude Code plugin evals → claude.ai | `claude plugin eval` publishes its report to claude.ai by default. | Medium | Fixed in M7: `jerry eval plugin` always passes `--no-publish`, uses a temporary JERRY home, and writes results to a temp directory |
| F4 | Browser → Core (DNS rebinding, CSRF) | Core binds to 127.0.0.1 only. Requests with an unexpected Host header are refused (421). Browser sessions use an HttpOnly, SameSite=Strict cookie plus a CSRF token and an Origin check for state changes. Token-only routes refuse sessions. | — | Verified (API auth tests) |
| F5 | Dashboard → XSS | No `v-html` or `innerHTML` anywhere; Vue escapes text. A strict CSP applies (`script-src 'self'`, `frame-ancestors 'none'`). Artifact links are accepted only as `https://claude.ai/…/artifact/…`, at Core and again in the dashboard. | — | Verified (dashboard test with hostile content) |
| F6 | Repository → Git reading | JERRY's Git reads run with `--no-optional-locks`, `core.fsmonitor=false`, `--no-ext-diff` and `--no-textconv`, with no shell and with credentials stripped from remote URLs. A clean filter the user configured themselves (for example Git LFS) can still run during `git status`; filters cannot come from a cloned repository's own files. | Low | Accepted |
| F7 | Hook availability | PreToolUse hooks fail closed (`onFailure: block`), and hard rules are evaluated in the bridge itself, also while Core is down. Telemetry hooks are asynchronous and never block. | — | Verified (live scenarios B, D, F) |
| F8 | Secrets in JERRY's data | Prompts are not stored (sizes only). Commands and errors are redacted. Quality findings mask secret values. The project profile never reads `.env` values. Test fixtures build fake credentials from fragments. | — | Verified (redaction and rule tests) |
| F9 | Approvals and other user decisions | No MCP tool approves, accepts, waives or dismisses anything. CLI decisions need an interactive terminal and a typed ID. Dashboard decisions need a session, CSRF and a typed ID. Agent shells are refused by the TTY check, and the user-only commands are a hard rule. Exceptions: `jerry review skip`, `jerry findings set`, `jerry eval baseline` and `jerry eval label` are protected by the TTY check only, not by the hard-rule list. | Low | Decision for the product owner (below) |
| F10 | Release integrity | Packages carry SHA-256 checksums per file and for the archive, but no signature. | Low | Accepted for a local, self-built tool; signing can come with distribution |
| F11 | Login link | `jerry ui` prints a one-time login link with a 64-hex code that expires quickly, in the user's terminal. | Low | Accepted |
| F12 | Claude Artifacts | An Artifact is created only when the user says yes in `/jerry:artifact`. It is a private page in their claude.ai account. JERRY stores only the decision and the link (ADR 0042). | — | By design |
| F13 | JERRY_HOME placement | Core refuses a JERRY home inside a Git repository, so no JERRY data ends up in a project. | — | Verified |

## Decisions for the product owner

These would change JERRY's hard rules, which only the product owner may approve (never weakened or reworded
without explicit approval).

1. **F1: guard reads of JERRY's data.** Add Read, Grep and Glob to the PreToolUse matcher, and apply
   `hard.protected-path` to reads inside `JERRY_HOME` and the Claude settings that enable JERRY. This closes
   the token path. The cost is a hook call on every read, about 70 ms each. The alternative is to accept the
   risk, because an agent with the user's privileges can always read files through other means. JERRY's
   value then rests on monitoring and the audit trail.
2. **F9: extend the user-only commands.** Add `jerry review skip`, `jerry findings set`, `jerry eval baseline`
   and `jerry eval label` to `hard.user-only-command`, as a second layer next to the TTY check.
3. **Reduce false positives** of `hard.core-api` and `hard.git-mutation` on harmless text: `grep` patterns,
   test code or a here-document that mentions Git. They blocked the developer's own harmless commands
   repeatedly during M3 to M8. This would narrow a hard rule, so it needs the same approval.

## Not run

- Dependency vulnerability scan (`pnpm audit`): needs network access to the registry. Run it before a public
  release. Dependencies are pinned to exact versions in the lockfile.
