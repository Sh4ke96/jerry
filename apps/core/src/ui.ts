/**
 * Server-rendered pages until the dashboard app arrives (M1 item 7). No scripts, no external
 * resources; the CSP allows nothing beyond this document's own inline styles.
 */

export const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

const STYLE = `
  :root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1d1d1b; --muted: #6b6b66; --card: #ffffff; --line: #e3e3de; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecece8; --muted: #a2a29b; --card: #1f1f1d; --line: #33332f; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 34rem; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 28px 32px; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 8px 0; color: var(--muted); }
  code { font-size: 13px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function dashboardPlaceholderPage(version: string): string {
  return page(
    'JERRY',
    `<h1>JERRY Control Center</h1><p>You are signed in to JERRY Core ${version}. The dashboard itself arrives in a later step of M1.</p><p>Until then, use <code>jerry status</code>, <code>jerry task list</code> and <code>jerry events</code> in a terminal.</p>`,
  );
}

export function signedOutPage(message: string): string {
  return page('JERRY', `<h1>JERRY Control Center</h1><p>${message.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`)}</p>`);
}
