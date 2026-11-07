import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loginCodeRequestSchema, loginNextSchema } from '@jerry/contracts';

/**
 * Browser access to Core. The dashboard never sees the CLI/hook token. Instead:
 *   1. the user runs `jerry ui`; the CLI (token-authenticated) asks Core for a one-time login code;
 *   2. the browser opens /ui/login?code=…; Core redeems the code (single use, 60 s) and sets an
 *      HttpOnly, SameSite=Strict session cookie;
 *   3. every state-changing browser request must carry the session's CSRF token and a same-origin
 *      Origin header.
 * Sessions live in memory: restarting Core signs the dashboard out.
 */

export const SESSION_COOKIE = 'jerry_session';
export const CSRF_HEADER = 'x-jerry-csrf';
export const LOGIN_CODE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface BrowserSession {
  id: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export class BrowserSessions {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly now: () => number = Date.now) {}

  issueLoginCode(): { code: string; expiresAt: number } {
    this.sweep();
    const code = randomBytes(32).toString('hex');
    const expiresAt = this.now() + LOGIN_CODE_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** Single use: a code is deleted on the first attempt, valid or not. */
  redeemLoginCode(code: string): BrowserSession | null {
    const expiresAt = this.codes.get(code);
    this.codes.delete(code);
    if (expiresAt === undefined || expiresAt < this.now()) return null;
    const createdAt = this.now();
    const session: BrowserSession = {
      id: randomBytes(32).toString('hex'),
      csrfToken: randomBytes(32).toString('hex'),
      createdAt,
      expiresAt: createdAt + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): BrowserSession | null {
    const session = this.sessions.get(id);
    if (session === undefined) return null;
    if (session.expiresAt < this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  revoke(id: string): void {
    this.sessions.delete(id);
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, expiresAt] of this.codes) if (expiresAt < now) this.codes.delete(code);
    for (const [id, session] of this.sessions) if (session.expiresAt < now) this.sessions.delete(id);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export function sessionCookie(session: BrowserSession): string {
  const maxAge = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/**
 * The dashboard route a login code request asks to land on ({ next: "#/tasks/JRY-0001" }); a
 * missing body, a body that is not an object or an invalid route gives none.
 */
export function loginNextFromBody(body: unknown): string | undefined {
  const parsed = loginCodeRequestSchema.safeParse(body ?? {});
  return parsed.success ? parsed.data.next : undefined;
}

/** The address of a login link, with its landing route when there is a valid one. */
export function loginUrl(origin: string, code: string, next: string | undefined): string {
  const url = `${origin}/ui/login?code=${code}`;
  return next === undefined ? url : `${url}&next=${encodeURIComponent(next)}`;
}

/**
 * Where the browser goes once a login code is redeemed: "/" plus a valid dashboard route
 * ("/#/tasks/JRY-0001"), otherwise the dashboard's root. Absolute or protocol-relative URLs,
 * other paths, scripts and over-long or odd values all give the root.
 */
export function loginRedirectTarget(next: unknown): string {
  const parsed = loginNextSchema.safeParse(next);
  return parsed.success ? `/${parsed.data}` : '/';
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
