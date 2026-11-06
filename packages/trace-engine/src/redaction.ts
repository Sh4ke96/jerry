/**
 * Masks credentials in text JERRY records (commands, error messages). Spec §18.2: tokens,
 * passwords, keys, cookies and connection strings are never stored. Patterns are deliberately
 * broad; masking a harmless value costs nothing, missing a secret does.
 */

export interface Redacted {
  text: string;
  reasons: string[];
}

const MASK = '[REDACTED]';

const RULES: ReadonlyArray<{ reason: string; pattern: RegExp; replace: string }> = [
  { reason: 'authorization-header', pattern: /(authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s'"]+/gi, replace: `$1${MASK}` },
  { reason: 'cookie-header', pattern: /((?:set-)?cookie\s*:\s*)[^'"\r\n]+/gi, replace: `$1${MASK}` },
  { reason: 'url-credentials', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, replace: `$1${MASK}@` },
  {
    reason: 'credential-assignment',
    pattern: /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;'"]+)/gi,
    replace: `$1${MASK}`,
  },
  { reason: 'credential-flag', pattern: /(--?(?:password|passwd|token|api-key|apikey|secret|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, replace: `$1${MASK}` },
  { reason: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: MASK },
  { reason: 'api-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: MASK },
  { reason: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: MASK },
  { reason: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: MASK },
  { reason: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: MASK },
  { reason: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: MASK },
];

export function redactText(text: string): Redacted {
  const reasons = new Set<string>();
  let result = text;
  for (const rule of RULES) {
    const next = result.replace(rule.pattern, rule.replace);
    if (next !== result) reasons.add(rule.reason);
    result = next;
  }
  return { text: result, reasons: [...reasons] };
}

export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
