# JERRY

Lokalny Agent Harness / Development Guardian dla Claude Code i VS Code.
**One installation. Every project. Zero project footprint.**

To repozytorium zawiera kod samego produktu JERRY. Wymóg zero footprint dotyczy repozytoriów użytkownika, nie tego repozytorium.

**Status:** M0 Feasibility Spike. Wyniki i luki są w [docs/spikes/M0-feasibility.md](docs/spikes/M0-feasibility.md).

## Co działa w M0

- Plugin Claude Code (`claude-plugin/`) z hookami `SessionStart` i `PreToolUse` (Write/Edit/MultiEdit/NotebookEdit/Bash/PowerShell/Monitor).
- JERRY Core: lokalny proces HTTP na `127.0.0.1` z tokenem. Trzyma zadania, wersjonowane plany (hash) i approvals w `JERRY_HOME`.
- Approval gate: zapis w repozytorium Git przechodzi tylko w zakresie zatwierdzonej, aktualnej wersji planu. Działa fail-closed.
- `jerry` CLI: `install`, `uninstall`, `doctor`, `core start|stop|status`, `task`, `plan revise`, `approve`/`reject` (approve/reject wymagają TTY).

## Struktura

```text
apps/core           JERRY Core (HTTP API, stan, decyzje bramki)
apps/hook-bridge    adapter hooków Claude Code → Core (bundlowany do pluginu)
apps/cli            jerry CLI
packages/contracts  schematy Zod współdzielone przez procesy
packages/platform   JERRY_HOME, klient Core, lokalizacja claude.exe, zapis atomowy
packages/policy-engine  czysta logika bramki: ścieżki, klasyfikacja shell, approvals
claude-plugin/      statyczna część pluginu (manifest, hooks.json)
tests/              integracja (bridge + Core) i E2E instalacji
scripts/            build, benchmark hooka, test na żywej sesji Claude Code
docs/               spike'i i decyzje architektoniczne (ADR)
```

## Development

Wymagane: Node ≥ 22.12, corepack (pnpm jest pobierany przez corepack, bez globalnej instalacji).

```powershell
corepack pnpm install
corepack pnpm build          # dist/plugin, dist/core, dist/cli
corepack pnpm check          # typecheck + wszystkie testy
node dist/cli/jerry.mjs help
```

Testy instalacji używają izolowanego `CLAUDE_CONFIG_DIR` i sprawdzają, że prawdziwy `~/.claude` się nie zmienia.
`scripts/e2e-live.mjs` uruchamia prawdziwe sesje Claude Code na zalogowanym koncie (model haiku) z pluginem
załadowanym przez `--plugin-dir`, bez zmian w ustawieniach.

## Zasady pracy

- Specyfikacja jest źródłem wymagań; zmiany wymagają uzasadnienia i wersjonowania (ADR w `docs/decisions/`).
- Nie przechodzimy do kolejnej fazy bez zaliczenia krytycznych testów poprzedniej.
- Bez prawdziwych tokenów OAuth Claude Code w testach i kodzie; bez zewnętrznej telemetrii.
- Commit, push i merge tylko za jawną zgodą.
