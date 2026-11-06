# ADR 0002 — JERRY never modifies repositories; it is only a guard

- **Status:** accepted (product-owner decision)
- **Date:** 2026-11-06
- **Affects:** spec §0, §1 (JR-002, JR-016, JR-017), §4.6, §5.4, §12, §14.3, §22 (Phase 7), backlog M5/M7

## Decision

JERRY (Core, CLI, hook bridge, MCP server, dashboard, quality/eval engine) **may not** change anything in any
repository. It does not edit, create or delete files, commit, push, merge, or touch `.git`. JERRY only
**guards Claude Code**: it observes, evaluates, blocks, reports and asks the user for decisions.

All code changes are made by Claude Code, under JERRY's gates. Git operations are performed by the user, or by
Claude Code with the user's explicit consent (JR-016).

The only place JERRY writes to is `JERRY_HOME`, plus the Claude Code settings, which change only through the
official CLI during install/uninstall.

## Enforcement in code (since M0)

- Core and the CLI refuse to run when `JERRY_HOME` is inside a Git repository (`assertJerryHomeOutsideRepositories`).
- `jerry uninstall --purge-data` removes only the entries JERRY creates (`run`, `state`, `logs`, `config`,
  `marketplace`), never the whole directory tree.
- Core is started with `cwd = JERRY_HOME`, so it never holds a project folder as its working directory
  (on Windows that would prevent the folder from being deleted or renamed).
- Zero-footprint tests (a snapshot of every file with its hash, including `.git/`, plus `git status`) cover the
  gate, install, doctor, uninstall and a misconfigured `JERRY_HOME`.

## Consequences for the specification (to be applied)

| Spec section | Before | After ADR 0002 |
|---|---|---|
| §5.4 exception "Allow project artifact write" | JERRY writes an artifact into the project after consent | Remove. An artifact in the project can only appear as a Claude change covered by a plan |
| §14.3 step 7, §22 Phase 7 | JERRY syncs a patch from an external copy into the original checkout | Claude Code (behind the gate) or the user applies the patch; JERRY only shows and verifies it |
| §4.6 `quality-engine` | "does not change code without an authorised workflow" | "does not change code" |
| §12 / M5 "Targeted test runner" | JERRY runs tests | Tests run in the user's repository can write files (coverage, snapshots, caches), so JERRY does not run them there. Options to decide in M5: (a) Claude runs the tests and JERRY collects results from `PostToolUse`; (b) JERRY runs them in an external copy under `JERRY_HOME/workspaces/` |
| M3 discovery | `git status` etc. | Read-only commands only, with `GIT_OPTIONAL_LOCKS=0` / `--no-optional-locks`: a plain `git status` can rewrite `.git/index` |
| Static analysers | — | Only in modes that do not write (no `--fix`, no cache files in the repository), or in an external copy |
