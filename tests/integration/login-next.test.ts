import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions, loginRedirectTarget } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { ROOT, tempDir } from '../helpers/harness.js';

const DASHBOARD_DIR = path.join(ROOT, 'dist', 'core', 'dashboard');
const PORT = 47998;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = 'c'.repeat(64);
const LOGIN_CODES = '/api/v1/ui/login-codes';
type Payload = NonNullable<InjectOptions['payload']>;

/** Routes a login link may land on, and everything that must land on the dashboard's root instead. */
const VALID = ['#/tasks/JRY-0001', '#/tasks', '#/', '#/projects/D%3A%5CWork', '#/tasks?filter=waiting&x=1', `#/${'a'.repeat(198)}`];
const INVALID: unknown[] = [
  'http://evil.example/',
  'https://evil.example/#/tasks',
  '//evil.example',
  '//evil.example/#/tasks',
  'javascript:alert(1)',
  '/other',
  '/#/tasks',
  'tasks/JRY-0001',
  '#tasks',
  '#/tasks\r\nset-cookie: x=1',
  '#/tasks/<script>',
  '#/tasks/JRY 0001',
  '#/tasks/"quoted"',
  '#/tasks/é',
  `#/${'a'.repeat(199)}`,
  '',
  42,
  ['#/tasks', '#/projects'],
  { route: '#/tasks' },
  null,
  undefined,
];

/**
 * A login link may carry the dashboard route to open after signing in (the Jerry app's
 * notifications). Only plain dashboard routes are kept; the redirect never leaves the dashboard.
 */
describe('login links with a landing route', () => {
  const base = tempDir('login-next');
  const sessions = new BrowserSessions();
  let store: StateStore;
  let app: FastifyInstance;

  beforeAll(async () => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: base, protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions, dashboardDir: DASHBOARD_DIR, onShutdownRequested: () => undefined });
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const requestLink = async (payload?: Payload): Promise<URL> => {
    const response = await app.inject({ method: 'POST', url: LOGIN_CODES, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode).toBe(200);
    return new URL((response.json() as { url: string }).url);
  };

  const redeem = (url: URL | string): Promise<LightMyRequestResponse> => {
    const target = typeof url === 'string' ? url : url.pathname + url.search;
    return app.inject({ method: 'GET', url: target, headers: { host: HOST } });
  };

  it('keeps a valid route from the login code request and lands on it after signing in', async () => {
    for (const next of VALID) {
      const link = await requestLink({ next });
      expect(link.origin).toBe(ORIGIN);
      expect(link.searchParams.get('next')).toBe(next);
      const response = await redeem(link);
      expect(response.statusCode, next).toBe(302);
      expect(response.headers.location, next).toBe(`/${next}`);
      expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly/);
    }
  });

  it('ignores an invalid route in the request: the link carries none and lands on the root', async () => {
    for (const next of INVALID) {
      const link = await requestLink(next === undefined ? {} : { next } as Payload);
      expect(link.searchParams.has('next'), String(next)).toBe(false);
      const response = await redeem(link);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/');
    }
  });

  it('still issues a plain link without a body or with an odd one', async () => {
    for (const link of [await requestLink(), await requestLink([]), await requestLink({ other: '#/tasks' })]) {
      expect(link.searchParams.has('next')).toBe(false);
      expect((await redeem(link)).headers.location).toBe('/');
    }
  });

  it('validates a route given on the login link itself', async () => {
    for (const next of VALID) {
      const link = await requestLink({});
      const response = await redeem(`${link.pathname}${link.search}&next=${encodeURIComponent(next)}`);
      expect(response.headers.location, next).toBe(`/${next}`);
    }
    for (const next of INVALID.filter((value): value is string => typeof value === 'string')) {
      const link = await requestLink({});
      const response = await redeem(`${link.pathname}${link.search}&next=${encodeURIComponent(next)}`);
      expect(response.statusCode, next).toBe(302);
      expect(response.headers.location, next).toBe('/');
    }
    // A repeated parameter is an array, not a route.
    const link = await requestLink({});
    const repeated = await redeem(`${link.pathname}${link.search}&next=${encodeURIComponent('#/tasks')}&next=${encodeURIComponent('#/projects')}`);
    expect(repeated.headers.location).toBe('/');
  });

  it('never redirects without a valid code, whatever the route', async () => {
    const response = await redeem(`/ui/login?code=${'d'.repeat(64)}&next=${encodeURIComponent('#/tasks/JRY-0001')}`);
    expect(response.statusCode).toBe(401);
    expect(response.headers.location).toBeUndefined();
  });

  it('turns every value into the root or a dashboard route on this origin', () => {
    for (const next of VALID) expect(loginRedirectTarget(next)).toBe(`/${next}`);
    for (const next of INVALID) {
      const target = loginRedirectTarget(next);
      expect(target, String(next)).toBe('/');
    }
  });
});
