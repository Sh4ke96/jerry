# ADR 0007 — Local API on Fastify; token for CLI and hooks, one-time login and CSRF for the browser

- **Status:** accepted (M1 item 5)
- **Date:** 2026-11-06
- **Affects:** spec §4.3 (Fastify, IPC choice), §16.5 (dashboard on 127.0.0.1), §18.1 (local-only, CORS, CSRF, token), §18.4 (API contract); backlog M1 "Local API", "IPC authentication"

## Context

Core's API served only the CLI and hooks, authenticated by a bearer token read from `JERRY_HOME/run/core.json`.
The dashboard (M1 item 7) runs in a browser. A browser must never hold that token, and any website the user
visits can send requests to `127.0.0.1`. The spec also left the IPC choice open: loopback HTTP with a token,
or a Windows named pipe.

## Decision

- **Fastify 5** replaces the hand-written `node:http` server. The API contract is unchanged; all existing
  integration tests pass against it. The Core bundle gets a `createRequire` banner because Fastify is CommonJS.
- **IPC: loopback HTTP with a token.** The browser dashboard needs HTTP on loopback anyway, and one transport
  keeps one security model. Core binds `127.0.0.1` only (ADR 0004). The token lives in `%LOCALAPPDATA%`,
  which is readable only by the user. Agents are kept away from it by hard rules (ADR 0003). Named pipes are
  not used.
- **Two kinds of clients, decided per route:**

  | Client | Credential | Routes |
  |---|---|---|
  | CLI and hooks | `Authorization: Bearer <token>`; refused if an `Origin` header is present | everything, including gate checks, event ingestion, session registration, task and plan creation, shutdown |
  | Dashboard | session cookie | reading (status, tasks, events, exclusions), approvals, exclusions, backups |

- **Browser sign-in:** `jerry ui` asks Core (with the token) for a one-time login code (64 hex characters, single
  use, 60 s) and opens `http://127.0.0.1:47823/ui/login?code=…`. Core redeems it, sets
  `jerry_session` (`HttpOnly; SameSite=Strict; Path=/`, 8 hours) and redirects to `/`. Sessions live in memory,
  so restarting Core signs the dashboard out.
- **Browser request checks:**
  - `Host` must be Core's own loopback origin, which stops DNS rebinding.
  - A cross-origin `Origin` or a cross-site `Sec-Fetch-Site` is refused.
  - Every state-changing request needs the dashboard `Origin` and the session's CSRF token in `X-JERRY-CSRF`,
    which the page reads from `GET /api/v1/ui/session`.
  - No CORS headers are ever sent.
- **User gestures stay explicit:** approving from the dashboard requires `confirmTaskId` equal to the task ID,
  and excluding a repository requires `confirmation: "exclude"`, as the CLI prompts do. The audit log records
  whether a decision came from the CLI or the dashboard.
- **Pages:** HTML is served with `Content-Security-Policy` (`default-src 'none'`, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Until the dashboard app exists, `/` shows a
  placeholder.
- **Hard rules extended:** agents may not run `jerry ui`, and commands touching `/ui/login` or `/ui/logout` are
  blocked like the API, so an agent cannot sign itself in and approve its own plan.

## Evidence

`tests/integration/api-auth.test.ts` runs the real app through `inject()`. It covers Host checks, missing and
wrong tokens, a token sent from a browser, single-use and expiring login codes, the placeholder's security
headers, cross-origin and cross-site refusal, CSRF and Origin on state changes, the typed approval
confirmation, browser access to hook routes refused, and sign-out. The install E2E prints a real login link,
and the live Claude Code check passes 23/23 against the Fastify Core.

## Consequences

- The dashboard (M1 item 7) only needs to call `GET /api/v1/ui/session` once and send `X-JERRY-CSRF` on changes.
- Hooks are not an OS sandbox (spec §8.4): a process running as the user can still read `core.json`. The
  defences stop agents working through Claude Code's tools, not arbitrary local malware.
