import fs from 'node:fs';
import path from 'node:path';
import type { EvalRunnerStatus } from '@jerry/contracts';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { EvalRunner } from '../../apps/core/src/eval-runner.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { tempDir } from '../helpers/harness.js';

const PORT = 47995;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: no credential-shaped literal.
const TOKEN = ['eval', 'runner', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

/**
 * "Run evals" from the dashboard: Core runs the CLI in the background (here a fake CLI script that
 * prints what it was given), one run at a time, with its output tail; only a dashboard session with
 * CSRF can start or stop it.
 */
describe('eval runner (Core API)', () => {
  const base = tempDir('eval-runner');
  const home = path.join(base, 'home');
  const cli = path.join(base, 'fake-jerry.mjs');
  let store: StateStore;
  let app: FastifyInstance;
  let runner: EvalRunner;
  let auth: { cookie: string; csrf: string };

  beforeAll(async () => {
    fs.mkdirSync(home, { recursive: true });
    // Prints its arguments and JERRY_HOME; "slow" keeps running until it is stopped; "fail" exits 2.
    fs.writeFileSync(
      cli,
      [
        "const args = process.argv.slice(2);",
        "console.log('args: ' + args.join(' '));",
        "console.log('home: ' + process.env.JERRY_HOME);",
        "console.error('\\u001b[31mcolored\\u001b[0m line on stderr');",
        "if (args.includes('slow')) setInterval(() => {}, 1000);",
        "else process.exit(args.includes('fail') ? 2 : 0);",
      ].join('\n'),
    );
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    runner = new EvalRunner({ home, cliPath: cli, casesDir: null });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: home, protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions: new BrowserSessions(), evalRunner: runner, onShutdownRequested: () => undefined });
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const url = new URL(login.url);
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const info = await app.inject({ method: 'GET', url: '/api/v1/ui/session', headers: { host: HOST, cookie } });
    auth = { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  });
  afterAll(async () => {
    await app.close();
    await store.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const asCli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });
  const asBrowser = (method: 'GET' | 'POST', url: string, payload?: Payload, csrf: string | null = auth.csrf): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, cookie: auth.cookie, origin: ORIGIN, ...(csrf === null ? {} : { 'x-jerry-csrf': csrf }) }, ...(payload === undefined ? {} : { payload }) });
  const status = async (): Promise<EvalRunnerStatus> => (await asBrowser('GET', '/api/v1/evals/runner')).json() as EvalRunnerStatus;

  it('is idle at first and only a dashboard session with CSRF may start a run', async () => {
    expect(await status()).toMatchObject({ state: 'idle', unavailable: null, logTail: [], runId: null });
    expect((await asCli('POST', '/api/v1/evals/runner/start', {})).statusCode).toBe(403);
    expect((await asBrowser('POST', '/api/v1/evals/runner/start', {}, null)).statusCode).toBe(403);
    expect((await asBrowser('POST', '/api/v1/evals/runner/start', { suite: '../x' })).statusCode).toBe(400);
    expect((await asBrowser('POST', '/api/v1/evals/runner/start', { suite: 'regression' })).statusCode).toBe(400);
  });

  it('runs the CLI with this JERRY_HOME, keeps the output tail without colors and reports how it ended', async () => {
    const started = await asBrowser('POST', '/api/v1/evals/runner/start', { label: 'nightly' });
    expect(started.statusCode, started.body).toBe(202);
    expect(started.json()).toMatchObject({ state: 'running', label: 'nightly' });
    await runner.idle();
    const done = await status();
    expect(done).toMatchObject({ state: 'finished', exitCode: 0, label: 'nightly' });
    expect(done.logTail).toEqual(expect.arrayContaining(['args: eval run --label nightly', `home: ${home}`, 'colored line on stderr']));
    expect(fs.readFileSync(done.logFile!, 'utf8')).toContain('args: eval run --label nightly');
    expect(done.logFile!.startsWith(path.join(home, 'run', 'eval-runs'))).toBe(true);

    await asBrowser('POST', '/api/v1/evals/runner/start', { label: 'fail' });
    await runner.idle();
    expect(await status()).toMatchObject({ state: 'failed', exitCode: 2 });
  });

  it('runs one at a time and stops a run with everything it started', async () => {
    expect((await asBrowser('POST', '/api/v1/evals/runner/start', { label: 'slow' })).statusCode).toBe(202);
    const again = await asBrowser('POST', '/api/v1/evals/runner/start', {});
    expect(again.statusCode).toBe(409);
    expect((await asCli('POST', '/api/v1/evals/runner/stop', {})).statusCode).toBe(403);
    const stopped = await asBrowser('POST', '/api/v1/evals/runner/stop', {});
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ state: 'stopped', label: 'slow' });
  });

  it('says when no CLI is next to Core', async () => {
    const missing = new EvalRunner({ home, cliPath: path.join(base, 'nope.mjs'), casesDir: null });
    expect(missing.unavailable()).toMatch(/not next to this Core/);
    expect(() => missing.start({ suite: null, label: '' })).toThrow(/not next to this Core/);
  });
});
