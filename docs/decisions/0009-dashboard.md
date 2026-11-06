# ADR 0009 — Dashboard: Vue 3 in TSX, served by Core, installable as an app

- **Status:** accepted (M1 item 7)
- **Date:** 2026-11-06
- **Affects:** spec §4.2 D (Control Center), §4.3 (Vue 3 + Vite), §16 (dashboard UX), §16.5 (local web app, later desktop shell); backlog M1 "Minimal dashboard shell", M2 "Dashboard approve/reject actions"

## Decision

- **Stack:** Vue 3.5 with Vite 8, as the spec recommends. Components are written in **TSX** (`@vitejs/plugin-vue-jsx`)
  rather than `.vue` single-file components. The repository's TypeScript 7 type-checks TSX directly; `.vue`
  checking would need `vue-tsc`, which builds on the TypeScript 5 API. Templates are compiled at build time and
  the runtime-only Vue build ships, so the page runs under a CSP without `unsafe-eval`.
- **Delivery:** the build writes the app to `dist/core/dashboard/` (about 80 KiB). `jerry install` copies it with Core,
  and Core serves it on its fixed origin `http://127.0.0.1:47823` (ADR 0004).
  - `/` and `/assets/*` need the browser session from `jerry ui` (ADR 0007). Content-hashed assets are cached privately.
  - `/manifest.webmanifest` and `/icons/*` are public, because browsers fetch them without cookies when installing
    the app. They contain no data.
  - Files are served from fixed folders, single-level names only, and must resolve inside the dashboard directory.
- **CSP:** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self';
  manifest-src 'self'; frame-ancestors 'none'`, plus `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
  There is no inline code and no third-party resource.
- **Installable app:** the web app manifest (`display: standalone`) and PNG icons (generated at build time by
  `scripts/icons.mjs`, no image tooling) let Edge and Chrome install the dashboard as a window with its own
  taskbar icon. There is no service worker, so the page never shows stale data from a cache. A Tauri shell
  (spec §16.5) stays a later option around the same app.
- **Screens:**
  - Overview: guard state, plans (approved and waiting), today's deviations and blocks, latest deviations.
  - Plans: per task its scope, plan hash and decision. Approve and Reject open a dialog that needs the task ID
    typed, like the CLI. The request carries the CSRF token and `confirmTaskId`.
  - Timeline: events with filters for everything, tool calls, deviations and blocked actions; the hover title
    shows JERRY's reason.
  - Repositories: excluded repositories with "Monitor again", and exclusion behind a typed "exclude".
- **Freshness:** the dashboard polls every 5 s, only while the tab is visible.
- **No new capabilities for agents:** the dashboard uses the session API from ADR 0007. Agents cannot reach it,
  because `jerry ui` and the login routes are hard rules (ADR 0003, 0007).

## Evidence

- `apps/dashboard/test/app.test.tsx` runs the app in happy-dom against stubbed Core responses. It covers the
  overview content, approving only after the task ID is typed (with the CSRF header and confirmation sent),
  timeline filters, every tab rendering, and the signed-out screen.
- `apps/dashboard/test/confirm-dialog.test.tsx` covers the typed-confirmation dialog.
- `tests/integration/api-auth.test.ts` covers the app behind a session with its CSP, assets only with a session,
  public manifest and icons, and path traversal refused. The built bundle contains no `eval` or `new Function`.

## Consequences

- No browser-level end-to-end tests yet (Playwright would add a browser download). The app logic is covered in
  happy-dom, and the server side by inject tests.
- Polling instead of server-sent events: simple and good enough for one local user. Server-sent events can
  replace it without API changes.
