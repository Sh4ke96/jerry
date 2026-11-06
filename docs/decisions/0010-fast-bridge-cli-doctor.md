# ADR 0010 — Dependency-free hook bridge; Commander CLI; full `jerry doctor`

- **Status:** accepted (M1 item 8)
- **Date:** 2026-11-06
- **Affects:** ADR 0001 (bridge cost), spec §4.3 (CLI: Commander or oclif), §20 (doctor), backlog M1 "CLI bootstrap", "`jerry status`", "`jerry doctor`"

## Hook bridge without Zod

The bridge runs on every guarded tool call, so its start-up time is paid many times per session. Measured
breakdown: 443 of its 470 KiB were Zod. Loading the bundle cost about 42 ms above bare Node start-up, while the
request to Core took about 8 ms.

**Decision:** the bridge loads no Zod.
- `@jerry/contracts/constants` holds plain lists: hook event types, gate verdicts, the task-ID and token patterns,
  versions. The Zod schemas are built from these lists, so there is one source of truth.
- `@jerry/contracts/guards` holds dependency-free validators for exactly what the bridge parses: PreToolUse and
  SessionStart input, gate decisions, session registration responses and `core.json`. The bridge and
  `@jerry/platform`'s Core client use them; Core, CLI and MCP server keep Zod.
- `packages/contracts/test/guards.test.ts` checks every guard against its Zod schema on valid fixtures and on
  variants: each field removed, unusual values, wrong literals, edge-case timestamps, nested plan entries.
- `scripts/build.mjs` fails the build if Zod, Kysely or Fastify ever appear in the bridge bundle again.
- The hard rules (`packages/policy-engine`) are unchanged; only input parsing moved.

**Result:** bundle 470 KiB → 24 KiB. A guarded call takes about 62 ms instead of 83 ms in the same
benchmark run, about 27 ms above bare Node instead of about 49 ms. A V8 compile cache was measured as well and
gave about 5 ms on the old bundle and nothing on the new one, so it is not used.

## CLI on Commander

The `parseArgs` dispatcher is replaced by Commander 15:
- help for every command, required options and typed validation (positive integers, `--stage plan`);
- the same commands and options as before;
- positional program options, so in `jerry approve … --version 2` the `--version` is the plan version.

**`jerry status`** is a quick summary without calling Claude Code: guard state, Core, plans approved and waiting,
today's deviations and blocks, and the dashboard address.

## Full `jerry doctor` (spec §20)

| Section | Checks |
|---|---|
| System | OS; the `node` that hooks find on PATH (missing means every guarded call is blocked, older than 22.13 means Core cannot start); Git Bash and PowerShell |
| Claude Code | CLI version at least 2.1.295 (`onFailure`); plugin installed, enabled and complete; marketplace path; installed plugin matches this build; no `disableAllHooks` and no plugin disabled in user or project settings |
| JERRY Core | `JERRY_HOME`; Core running; running build matches the installed runtime (build hash in status); port; API refuses requests without the token; autostart |
| Data | SQLite `quick_check` and schema (new `GET /api/v1/database/health`); disk usage; spool |
| Project | no JERRY files in the repository |

Doctor only reads and reports; each WARN or FAIL names the command that fixes it.

## Evidence

- `tests/integration/cli.test.ts` covers version and help, `--version` after `approve`, argument validation, and
  `jerry status` with and without Core.
- The install E2E requires PASS for node-for-hooks, claude-cli, plugin, marketplace, plugin-build, settings,
  core-build, api-auth and database in an isolated profile.
- On the real installation, doctor correctly reported an outdated plugin, an outdated running Core and an old
  runtime, instead of a database failure.
- Live Claude Code check: 25/25 with the dependency-free bridge.
