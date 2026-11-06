# M0 — Feasibility Spike: wyniki

**Data:** 2026-11-06 · **Środowisko:** Windows 11 Home 26300, Claude Code 2.1.318 (plik binarny z rozszerzenia VS Code),
Node 22.22.2, PowerShell 5.1 (brak PowerShell 7), Git for Windows 2.55 z Git Bash.

## Checklist M0

| # | Pozycja z backlogu | Status | Dowód |
|---|---|---|---|
| 1 | Minimalny plugin z manifestem | ✅ | `claude-plugin/`; `claude plugin validate` → passed (bez `--strict`) |
| 2 | Lokalny marketplace descriptor | ✅ | `jerry install` → `JERRY_HOME/marketplace/.claude-plugin/marketplace.json` |
| 3 | Instalacja marketplace przez oficjalne CLI, user scope | ✅ izolowany profil | `tests/e2e/install-lifecycle.test.ts` |
| 4 | Instalacja pluginu w user scope | ✅ izolowany profil | j.w.: `claude plugin list --json` → `enabled: true, scope: user` |
| 5 | Weryfikacja pluginu w CLI | ✅ | `scripts/e2e-live.mjs`: hooki odpalają w prawdziwych sesjach `claude -p` |
| 6 | Weryfikacja pluginu w VS Code | ⏳ | wymaga instalacji w prawdziwym profilu i przeładowania VS Code (decyzja użytkownika) |
| 7 | `SessionStart` | ✅ | sesje live rejestrowane w Core; kontekst z faktycznym stanem planu |
| 8 | `PreToolUse` dla narzędzi zapisu | ✅ | Write/Edit/MultiEdit/NotebookEdit; live A, C |
| 9 | `PreToolUse` dla shell na Windows | ✅ | Bash **i** PowerShell (oba narzędzia aktywne przy zainstalowanym Git Bash); live B |
| 10 | Jawny shell i `onFailure` dla guarda | ✅ (zmiana) | exec form bez shella + `onFailure: "block"`; [ADR 0001](../decisions/0001-hook-bridge-exec-form.md) |
| 11 | Niezatwierdzony task blokuje zapis | ✅ | integracja + live A, B |
| 12 | Zatwierdzony task dopuszcza tylko zakres | ✅ | integracja + live C (`src/**` przechodzi, `outside.txt` zablokowany) |
| 13 | Fail-closed, gdy Core nie działa | ✅ | Core zatrzymany, zawieszony, zły token, brak `core.json`, śmieci na stdin; live D |
| 14 | Brak zmian w fixture repo | ✅ | snapshot plików + hashy (z `.git/`) + `git status` przed/po |
| 15 | Bezpieczne odinstalowanie | ✅ izolowany profil | niezwiązane klucze `settings.json` zachowane, prawdziwy `~/.claude` bez zmian |

**Exit criteria M0** („czysty Windows 11 oraz profil z istniejącym `settings.json`”): profil z istniejącymi ustawieniami jest
przetestowany na izolowanym `CLAUDE_CONFIG_DIR`. Brakuje: (a) VS Code, (b) czystego profilu Windows,
(c) wariantu bez Git Bash (tylko narzędzie PowerShell, inne zachowanie hooków wg dokumentacji).

## Ustalenia

1. **Izolacja testów:** sam `CLAUDE_CONFIG_DIR` przenosi settings *i* katalog `plugins/`, więc testy instalacji nigdy nie dotykają
   prawdziwego profilu (sprawdzane hashem w teście).
2. **Oficjalne CLI jest merge-safe:** `marketplace add`/`install` dopisują tylko `extraKnownMarketplaces` i `enabledPlugins`.
   Zmienia się kolejność kluczy, a po odinstalowaniu zostają puste obiekty `{}`. Semantycznie ustawienia są zachowane.
3. **Plugin z lokalnego marketplace ładuje się z miejsca** (`readFromFolder` = `JERRY_HOME/marketplace/plugins/jerry`),
   a nie z cache. Aktualizacja to podmiana katalogu (staging + rename) i restart sesji lub `/reload-plugins`.
4. **`add`/`install` są idempotentne**; `uninstall`/`marketplace remove` zwracają `failureCode: not_installed / not_configured`,
   które `jerry uninstall` traktuje jako „już usunięte”.
5. **Domyślnie hook zawodzi otwarcie:** exit ≠ 0/2 i timeout przepuszczają narzędzie. Fail-closed wymaga *jednocześnie*
   `onFailure: "block"` oraz bridge'a, który każdy błąd zamienia na exit 2.
6. **`claude.exe` nie jest w PATH**, gdy Claude Code jest zainstalowany tylko jako rozszerzenie VS Code.
   CLI szuka go w: `JERRY_CLAUDE_BIN` → PATH → `~/.local/bin` → najnowsze rozszerzenie VS Code.
7. **Ważne odkrycie z sesji live:** ogólny komunikat SessionStart („edycje tylko w zatwierdzonym planie, przygotuj plan”) sprawił,
   że model odmówił nawet zapisu objętego *już zatwierdzonym* planem. SessionStart podaje więc teraz konkretny stan:
   zadania, wersje planów i zakres dla repo z sesji. Wniosek dla M2: model potrzebuje aktualnego stanu (MCP
   `jerry_get_approval_status`), nie ogólnych zasad. Zmiana zatwierdzenia w trakcie sesji nie trafia dziś do kontekstu.
8. **Opóźnienie guarda:** ok. 107 ms na guardowane wywołanie (exec form), ok. 290 ms przez PowerShell 5.1 (ADR 0001).

## Znane luki (zgodnie ze spec §8.4: hooki to nie sandbox OS)

- Komenda zapisująca uruchomiona z katalogu **poza** repozytorium (np. `cd D:/repo && rm …` z `C:/Temp`) przechodzi (`shell.outside-repository`).
- Klasyfikator shell to allowlista, ale nie parser: działa konserwatywnie (wątpliwość = zapis), więc może być uciążliwy i wymagać kalibracji.
- Narzędzia MCP innych serwerów (`mcp__*`) nie są guardowane.
- Token Core leży w `JERRY_HOME/run/core.json`, czytelny dla procesów użytkownika. Agent nie może go odczytać ani wywołać API
  przez guardowane narzędzia (`shell.protected-path`, `shell.core-api`), ale narzędzie `Read` nie jest guardowane.
- `jerry approve` wymaga TTY i przepisania ID zadania. Narzędzia shell Claude'a nie mają TTY. W Git Bash/mintty Node nie widzi
  TTY, więc approval trzeba robić z PowerShell / terminala VS Code (albo przez `winpty`).
- Po zatwierdzeniu zmiany każda komenda shell zdolna do zapisu dostaje `ask` (pytanie do użytkownika), bo JERRY nie potrafi
  sprawdzić jej zakresu.

## Odstępstwa od specyfikacji (do decyzji / aktualizacji spec)

| Spec | M0 | Powód |
|---|---|---|
| `hooks/bridge.ps1`, `shell: powershell` | `bridge.mjs` w exec form | ADR 0001 |
| SQLite od startu Core | stan w JSON (zapis atomowy), za interfejsem `StateStore` | SQLite to pozycja M1; seam gotowy |
| Commander/oclif w CLI | `node:util parseArgs` | spike bez zależności; decyzja w M1 |
| `packages/windows` | `packages/platform` | `JERRY_HOME`, lokalizacja `claude.exe` i klient Core nie są specyficzne dla Windows |

## Jak powtórzyć

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm test                 # unit + integracja + E2E instalacji (izolowany profil Claude)
node scripts/bench-hook.mjs 20     # opóźnienie hooka
node scripts/e2e-live.mjs          # prawdziwe sesje Claude Code (haiku), plugin przez --plugin-dir
```
