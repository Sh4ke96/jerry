# ADR 0001 — Hook bridge uruchamiany jako `node` w exec form, nie przez PowerShell

- **Status:** zaakceptowana w M0, do potwierdzenia przez właściciela produktu
- **Data:** 2026-11-06
- **Dotyczy:** spec §4.5 (`hooks/bridge.ps1`), §11.4, backlog M0 „Jawnie określić PowerShell shell i `onFailure` dla guard hook”

## Kontekst

Specyfikacja przewiduje `hooks/bridge.ps1` i `shell: powershell` dla hooków blokujących, żeby zachowanie na
Windows było przewidywalne. Claude Code 2.1.318 obsługuje trzy formy hooka `command`:

1. shell form z `shell: "bash"` (domyślnie, gdy jest Git Bash),
2. shell form z `shell: "powershell"`,
3. exec form: `command` + `args`, uruchamiane bez żadnej powłoki.

Guard `PreToolUse` uruchamia się przy **każdym** zapisie pliku i **każdej** komendzie shell, więc jego koszt
startu bezpośrednio spowalnia pracę agenta.

## Pomiar (M0, `scripts/bench-hook.mjs`, i5-13600K, Node 22.22.2, 20 prób)

| Wariant | Mediana | p95 |
|---|---|---|
| exec form: `node bridge.mjs` | 107 ms | 114 ms |
| `shell: powershell` (PowerShell 5.1) → `node bridge.mjs` | 292 ms | 350 ms |
| sam start Node (`node -e ""`), punkt odniesienia | 51 ms | 58 ms |

## Decyzja

Guard i SessionStart uruchamiamy w **exec form**:

```json
{ "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/bridge.mjs", "pre-tool-use"],
  "timeout": 10, "onFailure": "block" }
```

- Brak powłoki, więc nie ma problemów z quotingiem, profilem PowerShell, ExecutionPolicy ani różnicami
  Git Bash/PowerShell. To jest cel zapisu w specyfikacji („przewidywalne zachowanie Windows”), osiągnięty
  prościej.
- `onFailure: "block"` zamyka lukę, której bridge sam nie obsłuży: brak `node`, crash przed startem kodu,
  timeout hooka.
- Logika bridge'a jest w TypeScript, ze wspólnymi kontraktami Zod i policy engine (testowalna, jedna implementacja),
  zamiast drugiej implementacji w PowerShell.

## Konsekwencje

- Node.js musi być w `PATH` sesji Claude Code. Jeśli go nie ma, każdy guardowany zapis jest blokowany
  (fail-closed), a `jerry doctor` to raportuje. Specyfikacja i tak wymaga Node LTS.
- Narzut bridge'a ponad sam start Node wynosi ~55 ms, głównie parsowanie bundla (461 KiB, w większości Zod).
  Możliwe optymalizacje w M1: `zod/mini`, `module.enableCompileCache()`.
- Specyfikację (§4.5, §11.4, §18.5) należy zaktualizować: `bridge.ps1` → `bridge.mjs` w exec form.
