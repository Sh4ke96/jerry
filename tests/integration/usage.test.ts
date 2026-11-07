import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { usageCollectionResultSchema, usageSummarySchema, type Settings, type UsageSummary } from '@jerry/contracts';
import { decorate, EMOJI } from '@jerry/contracts/emoji';
import {
  applyTelemetry,
  disableUsageCollection,
  enableUsageCollection,
  ensureTelemetryKey,
  jerryPaths,
  pluginStatuslinePayload,
  readTelemetryConfig,
  readTelemetryLast,
  removeTelemetry,
  TELEMETRY_KEY_HEADER,
  usageCollectionStatus,
  writeTelemetryLast,
} from '@jerry/platform';
import { afterAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { drainUsageSpool, localDate, UsageStore } from '../../apps/core/src/usage-store.js';
import { api, createFixtureRepo, ROOT, runBridge, startCore, tempDir, TEST_CORE_ENV } from '../helpers/harness.js';

const SCRIPT = path.join(ROOT, 'dist', 'plugin', 'statusline', 'statusline.mjs');
const CLI = path.join(ROOT, 'dist', 'cli', 'jerry.mjs');
const base = tempDir('usage');
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;
function freshDir(name: string): string {
  counter += 1;
  const dir = path.join(base, `${name}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A settings file as Claude Code users have it; written the way JERRY writes JSON, so a restore can be compared byte for byte. */
function writeSettings(claudeConfigDir: string, settings: Record<string, unknown>): string {
  const file = path.join(claudeConfigDir, 'settings.json');
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const backups = (home: string): string[] => (fs.existsSync(jerryPaths(home).backupsDir) ? fs.readdirSync(jerryPaths(home).backupsDir).filter((name) => name.startsWith('claude-settings-')) : []);
const JERRY_ENV_KEYS = ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_METRICS_EXPORTER', 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_HEADERS'];

describe("telemetry in Claude Code's settings (isolated CLAUDE_CONFIG_DIR)", () => {
  const OTHER = { model: 'opus', permissions: { allow: ['Bash(git status)'] }, env: { FOO: 'bar' } };

  it('writes only its env keys with a backup, is idempotent, and disable restores the file exactly', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const file = writeSettings(claudeConfigDir, OTHER);
    const before = fs.readFileSync(file, 'utf8');

    const enabled = applyTelemetry({ home, claudeConfigDir, port: 47823 });
    expect(enabled.change).toBe('enabled');
    expect(fs.readFileSync(enabled.backupFile!, 'utf8')).toBe(before);
    const key = readTelemetryConfig(home)!.key;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const after = readJson(file);
    expect({ ...after, env: undefined }).toEqual({ ...OTHER, env: undefined });
    expect(after['env']).toEqual({
      FOO: 'bar',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:47823/v1/metrics',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: `${TELEMETRY_KEY_HEADER}=${key}`,
    });
    expect(usageCollectionStatus({ home, claudeConfigDir }).telemetry).toBe('on');

    expect(applyTelemetry({ home, claudeConfigDir, port: 47823 }).change).toBe('unchanged');
    expect(backups(home)).toHaveLength(1);
    // A new port updates JERRY's own keys.
    expect(applyTelemetry({ home, claudeConfigDir, port: 47900 }).change).toBe('updated');
    expect((readJson(file)['env'] as Record<string, string>)['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']).toBe('http://127.0.0.1:47900/v1/metrics');

    const removed = removeTelemetry({ home, claudeConfigDir });
    expect(removed.change).toBe('removed');
    expect(removed.backupFile).not.toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(usageCollectionStatus({ home, claudeConfigDir }).telemetry).toBe('off');
    expect(removeTelemetry({ home, claudeConfigDir }).change).toBe('not-enabled');
    // The key stays for the next time.
    expect(readTelemetryConfig(home)!.key).toBe(key);
  });

  it('removes "env" again when there was none, and creates settings.json when missing', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const file = writeSettings(claudeConfigDir, { model: 'opus' });
    applyTelemetry({ home, claudeConfigDir, port: 47823 });
    removeTelemetry({ home, claudeConfigDir });
    expect(readJson(file)).toEqual({ model: 'opus' });

    const empty = freshDir('claude');
    const emptyHome = freshDir('home');
    expect(applyTelemetry({ home: emptyHome, claudeConfigDir: empty, port: 47823 })).toMatchObject({ change: 'enabled', backupFile: null });
    expect(Object.keys(readJson(path.join(empty, 'settings.json'))['env'] as object)).toEqual(JERRY_ENV_KEYS);
    removeTelemetry({ home: emptyHome, claudeConfigDir: empty });
    expect(readJson(path.join(empty, 'settings.json'))).toEqual({});
  });

  it('never overwrites telemetry the user configured: clash, nothing written', () => {
    for (const env of [{ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, { CLAUDE_CODE_ENABLE_TELEMETRY: '1' }, { OTEL_METRICS_EXPORTER: 'console' }, { OTEL_LOGS_EXPORTER: 'otlp' }]) {
      const home = freshDir('home');
      const claudeConfigDir = freshDir('claude');
      const file = writeSettings(claudeConfigDir, { env });
      const before = fs.readFileSync(file, 'utf8');
      const result = applyTelemetry({ home, claudeConfigDir, port: 47823 });
      expect(result.change, JSON.stringify(env)).toBe('clash');
      expect(result.clashKeys).toEqual(Object.keys(env));
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(backups(home)).toEqual([]);
      expect(usageCollectionStatus({ home, claudeConfigDir }).telemetry).toBe('clash');
      expect(removeTelemetry({ home, claudeConfigDir }).change).toBe('not-enabled');
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
  });

  it('leaves a key the user changed after JERRY set it, and removes the rest', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const file = writeSettings(claudeConfigDir, OTHER);
    applyTelemetry({ home, claudeConfigDir, port: 47823 });
    const changed = readJson(file);
    (changed['env'] as Record<string, string>)['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] = 'http://collector:4318/v1/metrics';
    fs.writeFileSync(file, JSON.stringify(changed));
    expect(usageCollectionStatus({ home, claudeConfigDir }).telemetry).toBe('clash');
    expect(removeTelemetry({ home, claudeConfigDir }).change).toBe('removed');
    expect(readJson(file)['env']).toEqual({ FOO: 'bar', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://collector:4318/v1/metrics' });
  });

  it('changes nothing when settings.json is not valid JSON or "env" is not an object', () => {
    for (const content of ['{ "env": ', '{ "env": ["x"] }']) {
      const home = freshDir('home');
      const claudeConfigDir = freshDir('claude');
      const file = path.join(claudeConfigDir, 'settings.json');
      fs.writeFileSync(file, content);
      expect(() => applyTelemetry({ home, claudeConfigDir, port: 47823 })).toThrow(/changed nothing/);
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });

  it('switches both sources together and restores everything exactly', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const original = { ...OTHER, statusLine: { type: 'command', command: 'echo mine' } };
    const file = writeSettings(claudeConfigDir, original);
    const before = fs.readFileSync(file, 'utf8');
    const on = enableUsageCollection({ home, claudeConfigDir, payload: SCRIPT, port: 47823 });
    expect(on.statusline.ok && on.statusline.result.change).toBe('enabled');
    expect(on.telemetry.ok && on.telemetry.result.change).toBe('enabled');
    expect(usageCollectionStatus({ home, claudeConfigDir })).toMatchObject({ statusline: 'on', telemetry: 'on', problem: null });
    const off = disableUsageCollection({ home, claudeConfigDir });
    expect(off.statusline.ok && off.statusline.result.change).toBe('restored');
    expect(off.telemetry.ok && off.telemetry.result.change).toBe('removed');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(usageCollectionStatus({ home, claudeConfigDir })).toMatchObject({ statusline: 'not-jerry', telemetry: 'off' });
  });
});

describe('jerry usage (CLI)', () => {
  function jerry(args: string[], env: Record<string, string>) {
    const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...TEST_CORE_ENV, ...env }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  }

  it('refuses enable and disable without an interactive terminal, and changes nothing', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const file = writeSettings(claudeConfigDir, { model: 'opus' });
    for (const verb of ['enable', 'disable']) {
      const refused = jerry(['usage', verb], { JERRY_HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir });
      expect(refused.exitCode, verb).toBe(1);
      expect(refused.stderr, verb).toContain('interactive terminal');
    }
    expect(readJson(file)).toEqual({ model: 'opus' });
    expect(fs.existsSync(path.join(home, 'config'))).toBe(false);
  });

  it('status is read-only and shows both sources without Core', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const file = writeSettings(claudeConfigDir, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' } });
    const before = fs.readFileSync(file, 'utf8');
    const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir, JERRY_NO_EMOJI: '1' };
    const shown = jerry(['usage'], env);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('status line   off');
    expect(shown.stdout).toContain('telemetry     clash');
    expect(shown.stdout).toContain('telemetry last arrived: never');
    expect(shown.stdout).toContain('JERRY Core is not running');
    const json = JSON.parse(jerry(['usage', 'status', '--json'], env).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ statusline: { state: 'off' }, telemetry: { state: 'clash', endpoint: null }, core: null });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(home, 'config'))).toBe(false);
  });

  it('status shows the attribute names of the last metrics in --json only', () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    writeTelemetryLast(home, new Date().toISOString(), ['claude-vscode'], ['session.id', 'model', 'session.id']);
    const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir, JERRY_NO_EMOJI: '1' };
    const json = JSON.parse(jerry(['usage', 'status', '--json'], env).stdout) as { telemetry: { last: { attributeKeys: string[]; byEntrypoint: Record<string, string> } } };
    expect(json.telemetry.last.attributeKeys).toEqual(['model', 'session.id']);
    expect(Object.keys(json.telemetry.last.byEntrypoint)).toEqual(['claude-vscode']);
    const shown = jerry(['usage', 'status'], env);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('claude-vscode');
    expect(shown.stdout).not.toContain('session.id');
  });
});

// --- Core -------------------------------------------------------------------------------------

const PORT = 47998;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
type Payload = NonNullable<InjectOptions['payload']>;

interface Env {
  home: string;
  claudeConfigDir: string;
  project: string;
  other: string;
  store: StateStore;
  usage: UsageStore;
  app: FastifyInstance;
  token: string;
  key: string;
  cli(method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse>;
  metrics(body: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  summary(): Promise<UsageSummary>;
  close(): Promise<void>;
}

/** A fresh Core app (inject, no network) with a project, another repository and their sessions. */
async function coreEnv(): Promise<Env> {
  const dir = freshDir('core');
  const home = path.join(dir, 'home');
  const claudeConfigDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  const project = createFixtureRepo(path.join(dir, 'project'));
  const other = createFixtureRepo(path.join(dir, 'other'));
  const store = await StateStore.open({ databaseFile: path.join(home, 'database', 'jerry.sqlite'), backupsDir: path.join(home, 'backups'), legacyStateFile: path.join(home, 'none.json') });
  await store.addProject(project, new Date(), 'cli');
  const startedAt = new Date(Date.now() - 60_000);
  const usage = new UsageStore(store, startedAt);
  const token = randomBytes(32).toString('hex');
  const app = buildCoreApp({ token, store, usage, jerryHome: home, claudeConfigDir, telemetryPort: () => PORT, protectedRoots: [], startedAt, port: () => PORT, onShutdownRequested: () => undefined });
  const cli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }) });
  for (const [sessionId, cwd] of [
    ['s-project', project],
    ['s-other', other],
  ] as const) {
    expect((await cli('POST', '/api/v1/sessions', { sessionId, cwd, source: 'startup' })).statusCode).toBe(200);
  }
  const key = ensureTelemetryKey(home).key;
  return {
    home,
    claudeConfigDir,
    project,
    other,
    store,
    usage,
    app,
    token,
    key,
    cli,
    metrics: (body, headers = {}) =>
      app.inject({ method: 'POST', url: '/v1/metrics', headers: { host: HOST, 'content-type': 'application/json', [TELEMETRY_KEY_HEADER]: key, ...headers }, payload: typeof body === 'string' ? body : JSON.stringify(body) }),
    summary: async () => usageSummarySchema.parse((await cli('GET', '/api/v1/usage')).json()),
    close: async () => {
      await app.close();
      await store.close();
    },
  };
}

const text = (key: string, value: string) => ({ key, value: { stringValue: value } });
const nanos = (ms: number): string => String(BigInt(ms) * 1_000_000n);

/**
 * An OTLP/HTTP JSON export like Claude Code's (delta temporality, attributes on the points). With
 * entrypoint null there is no entrypoint attribute, as in Claude Code's real exports.
 */
function otlp(sessionId: string, tokens: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheCreation', number>>, cost: number, at = Date.now(), entrypoint: string | null = 'claude-vscode'): unknown {
  const common = [text('session.id', sessionId), text('model', 'claude-opus-5-5'), text('query_source', 'main')];
  return {
    resourceMetrics: [
      {
        resource: { attributes: [text('service.name', 'claude-code'), ...(entrypoint === null ? [] : [text('app.entrypoint', entrypoint)])] },
        scopeMetrics: [
          {
            metrics: [
              { name: 'claude_code.token.usage', unit: 'tokens', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: Object.entries(tokens).map(([type, value]) => ({ attributes: [...common, text('type', type)], asInt: String(value), startTimeUnixNano: nanos(at - 60_000), timeUnixNano: nanos(at) })) } },
              { name: 'claude_code.cost.usage', unit: 'USD', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ attributes: common, asDouble: cost, timeUnixNano: nanos(at) }] } },
              { name: 'claude_code.session.count', sum: { aggregationTemporality: 1, dataPoints: [{ attributes: common, asInt: '1' }] } },
            ],
          },
        ],
      },
    ],
  };
}

function snapshot(fields: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: null, cwd: null, model: 'Opus', version: '2.1.90', entrypoint: 'cli', at: new Date().toISOString(), ...fields };
}

describe('Core: Claude Code telemetry receiver (/v1/metrics)', () => {
  it('refuses requests without the key, with a wrong key or Host, from a browser or the CLI, too large, not JSON, or malformed', async () => {
    const env = await coreEnv();
    try {
      const body = otlp('s-project', { input: 1 }, 0.01);
      expect((await env.metrics(body, { [TELEMETRY_KEY_HEADER]: '' })).statusCode).toBe(401);
      expect((await env.app.inject({ method: 'POST', url: '/v1/metrics', headers: { host: HOST, 'content-type': 'application/json' }, payload: JSON.stringify(body) })).statusCode).toBe(401);
      expect((await env.metrics(body, { [TELEMETRY_KEY_HEADER]: randomBytes(32).toString('hex') })).statusCode).toBe(401);
      expect((await env.metrics(body, { host: 'evil.example:47998' })).statusCode).toBe(421);
      expect((await env.metrics(body, { origin: ORIGIN })).statusCode).toBe(403);
      expect((await env.metrics(body, { authorization: `Bearer ${env.token}` })).statusCode).toBe(403);
      expect((await env.metrics(body, { 'content-type': 'application/x-protobuf' })).statusCode).toBe(415);
      expect((await env.metrics(body, { 'content-type': 'text/plain' })).statusCode).toBe(415);
      expect((await env.metrics(JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 10) }))).statusCode).toBe(413);
      expect((await env.metrics('{"resourceMetrics": ')).statusCode).toBe(400);
      expect((await env.metrics({ resourceMetrics: {} })).statusCode).toBe(400);
      // Nothing of the refused requests was kept.
      expect((await env.summary()).totals.last30d.tokens).toBe(0);
      expect(readTelemetryLast(env.home)).toBeNull();

      expect((await env.metrics(body, { 'content-encoding': 'br' })).statusCode).toBe(415);
      expect((await env.app.inject({ method: 'POST', url: '/v1/metrics', headers: { host: HOST, 'content-type': 'application/json', 'content-encoding': 'gzip', [TELEMETRY_KEY_HEADER]: env.key }, payload: Buffer.from('not gzip') })).statusCode).toBe(400);
      const bomb = zlib.gzipSync(JSON.stringify({ resourceMetrics: [], padding: ' '.repeat(2 * 1024 * 1024) }));
      expect((await env.app.inject({ method: 'POST', url: '/v1/metrics', headers: { host: HOST, 'content-type': 'application/json', 'content-encoding': 'gzip', [TELEMETRY_KEY_HEADER]: env.key }, payload: bomb })).statusCode).toBe(413);

      const accepted = await env.metrics(body);
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({});
      // Gzipped exports (OTEL_EXPORTER_OTLP_COMPRESSION=gzip) are accepted too.
      const gzipped = await env.app.inject({ method: 'POST', url: '/v1/metrics', headers: { host: HOST, 'content-type': 'application/json', 'content-encoding': 'gzip', [TELEMETRY_KEY_HEADER]: env.key }, payload: zlib.gzipSync(JSON.stringify(body)) });
      expect(gzipped.statusCode).toBe(200);
      expect((await env.summary()).totals.today.tokens).toBe(2);
    } finally {
      await env.close();
    }
  });

  it('keeps only sessions JERRY registered in a project, adds up repeated exports, and notes the client', async () => {
    const env = await coreEnv();
    try {
      for (const sessionId of ['s-project', 's-other', 's-unknown']) expect((await env.metrics(otlp(sessionId, { input: 1000, output: 200, cacheRead: 50, cacheCreation: 10 }, 0.5))).statusCode).toBe(200);
      const once = await env.summary();
      expect(once.totals.today).toEqual({ input: 1000, output: 200, cacheRead: 50, cacheCreation: 10, tokens: 1260, costUsd: 0.5 });
      expect(once.byProject).toEqual([{ repoRoot: env.project, name: 'project', tokens: 1260, costUsd: 0.5 }]);
      expect(once.byModel).toEqual([{ model: 'claude-opus-5-5', tokens: 1260, costUsd: 0.5 }]);
      expect(once.byEntrypoint).toEqual([{ entrypoint: 'claude-vscode', tokens: 1260, costUsd: 0.5 }]);
      expect(once.sources.telemetry.lastAt).not.toBeNull();
      expect(Object.keys(once.sources.telemetry.byEntrypoint)).toEqual(['claude-vscode']);
      const sessions = await env.store.kysely.selectFrom('usage_tokens').select('session_id').distinct().execute();
      expect(sessions.map((row) => row.session_id)).toEqual(['s-project']);

      expect((await env.metrics(otlp('s-project', { input: 1000 }, 0.25))).statusCode).toBe(200);
      const twice = await env.summary();
      expect(twice.totals.today).toMatchObject({ input: 2000, tokens: 2260, costUsd: 0.75 });
    } finally {
      await env.close();
    }
  });

  it('stores the entrypoint a session registers with, and keeps it when a later registration lacks one', async () => {
    const env = await coreEnv();
    try {
      const register = async (payload: Record<string, unknown>) => expect((await env.cli('POST', '/api/v1/sessions', { cwd: env.project, source: 'startup', ...payload })).statusCode).toBe(200);
      await register({ sessionId: 's-vscode', entrypoint: 'claude-vscode' });
      // An older bridge sends no entrypoint; a bridge without CLAUDE_CODE_ENTRYPOINT sends null.
      await register({ sessionId: 's-vscode', source: 'resume' });
      await register({ sessionId: 's-vscode', source: 'compact', entrypoint: null });
      await register({ sessionId: 's-blank', entrypoint: '  ' });
      await register({ sessionId: 's-switch', entrypoint: 'cli' });
      await register({ sessionId: 's-switch', entrypoint: 'claude-vscode' });
      const rows = await env.store.kysely.selectFrom('sessions').select(['session_id', 'entrypoint']).orderBy('session_id').execute();
      expect(rows).toEqual([
        { session_id: 's-blank', entrypoint: null },
        { session_id: 's-project', entrypoint: null },
        { session_id: 's-switch', entrypoint: 'claude-vscode' },
        { session_id: 's-vscode', entrypoint: 'claude-vscode' },
      ]);
      // A session outside the projects is still not recorded.
      expect((await env.cli('POST', '/api/v1/sessions', { sessionId: 's-elsewhere', cwd: env.other, source: 'startup', entrypoint: 'cli' })).json()).toMatchObject({ monitored: false });
      expect(await env.store.kysely.selectFrom('sessions').select('session_id').where('session_id', '=', 's-elsewhere').execute()).toEqual([]);
    } finally {
      await env.close();
    }
  });

  it("gives points without an entrypoint attribute the session's registered entrypoint, and notes only attribute names", async () => {
    const env = await coreEnv();
    try {
      for (const [sessionId, entrypoint] of [
        ['s-vscode', 'claude-vscode'],
        ['s-cli', 'cli'],
      ] as const) {
        expect((await env.cli('POST', '/api/v1/sessions', { sessionId, cwd: env.project, source: 'startup', entrypoint })).statusCode).toBe(200);
      }
      // Claude Code's real exports carry no entrypoint attribute.
      expect((await env.metrics(otlp('s-vscode', { input: 100 }, 0.1, Date.now(), null))).statusCode).toBe(200);
      expect((await env.metrics(otlp('s-cli', { output: 10 }, 0.01, Date.now(), null))).statusCode).toBe(200);
      // A session registered without one (s-project) stays unknown; an attribute still wins.
      expect((await env.metrics(otlp('s-project', { input: 1 }, 0, Date.now(), null))).statusCode).toBe(200);
      expect((await env.metrics(otlp('s-cli', { input: 5 }, 0, Date.now(), 'sdk-ts'))).statusCode).toBe(200);

      const summary = await env.summary();
      expect(summary.byEntrypoint).toEqual([
        { entrypoint: 'claude-vscode', tokens: 100, costUsd: 0.1 },
        { entrypoint: 'cli', tokens: 10, costUsd: 0.01 },
        { entrypoint: 'sdk-ts', tokens: 5, costUsd: 0 },
        { entrypoint: 'unknown', tokens: 1, costUsd: 0 },
      ]);
      const stored = await env.store.kysely.selectFrom('usage_tokens').select(['session_id', 'entrypoint']).distinct().orderBy('session_id').orderBy('entrypoint').execute();
      expect(stored).toEqual([
        { session_id: 's-cli', entrypoint: 'cli' },
        { session_id: 's-cli', entrypoint: 'sdk-ts' },
        { session_id: 's-project', entrypoint: '' },
        { session_id: 's-vscode', entrypoint: 'claude-vscode' },
      ]);
      expect(Object.keys(summary.sources.telemetry.byEntrypoint).sort()).toEqual(['claude-vscode', 'cli', 'sdk-ts', 'unknown']);

      // The attribute names of the last request, sorted; never their values.
      const last = readTelemetryLast(env.home)!;
      expect(last.attributeKeys).toEqual(['app.entrypoint', 'model', 'query_source', 'service.name', 'session.id', 'type']);
      const file = fs.readFileSync(jerryPaths(env.home).telemetryLastFile, 'utf8');
      for (const value of ['s-cli', 'claude-opus-5-5', 'main', 'claude-code']) expect(file).not.toContain(`"${value}"`);
    } finally {
      await env.close();
    }
  });

  it('resolves rows stored before the session registered its entrypoint, and caps the attribute names at 50', async () => {
    const env = await coreEnv();
    try {
      const many = Array.from({ length: 80 }, (_, index) => text(`attr.${String(index).padStart(2, '0')}`, 'v'));
      const body = otlp('s-project', { input: 7 }, 0, Date.now(), null) as { resourceMetrics: Array<{ resource: { attributes: unknown[] } }> };
      body.resourceMetrics[0]!.resource.attributes.push(...many);
      expect((await env.metrics(body)).statusCode).toBe(200);
      expect((await env.summary()).byEntrypoint).toEqual([{ entrypoint: 'unknown', tokens: 7, costUsd: 0 }]);
      const keys = readTelemetryLast(env.home)!.attributeKeys;
      expect(keys).toHaveLength(50);
      expect(keys).toEqual([...keys].sort());

      // The session starts again, now with its entrypoint: earlier rows follow it.
      expect((await env.cli('POST', '/api/v1/sessions', { sessionId: 's-project', cwd: env.project, source: 'resume', entrypoint: 'claude-vscode' })).statusCode).toBe(200);
      expect((await env.summary()).byEntrypoint).toEqual([{ entrypoint: 'claude-vscode', tokens: 7, costUsd: 0 }]);
    } finally {
      await env.close();
    }
  });
});

describe('Core: status-line snapshots, limits and the summary', () => {
  it('keeps limits from any session without session or path, and snapshots only of project sessions', async () => {
    const env = await coreEnv();
    try {
      const resets = new Date(Date.now() + 3 * 3600_000).toISOString();
      const weekly = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const now = Date.now();
      const response = await env.cli('POST', '/api/v1/usage/snapshots', {
        snapshots: [
          snapshot({ sessionId: 's-other', cwd: env.other, fiveHour: { pct: 23, resetsAt: resets }, sevenDay: { pct: 41, resetsAt: weekly }, costUsd: 9, inputTokens: 9000 }),
          snapshot({ sessionId: 's-snap', cwd: path.join(env.project, 'src'), costUsd: 1.2, inputTokens: 100, outputTokens: 50, at: new Date(now - 120_000).toISOString() }),
          snapshot({ sessionId: 's-snap', cwd: path.join(env.project, 'src'), costUsd: 2, inputTokens: 300, outputTokens: 80, at: new Date(now).toISOString() }),
        ],
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: 3, stored: 2, limits: 1 });
      const columns = (await env.store.exclusive((raw) => raw.prepare('PRAGMA table_info(usage_limits)').all() as Array<{ name: string }>)).map((column) => column.name);
      expect(columns.some((name) => /session|path|cwd|repo/.test(name))).toBe(false);

      const summary = await env.summary();
      expect(summary.limits.fiveHour).toEqual({ pct: 23, resetsAt: resets, readAt: expect.any(String), entrypoint: 'cli' });
      expect(summary.limits.sevenDay?.pct).toBe(41);
      // The running totals of the status line, as the usage between snapshots.
      expect(summary.totals.today).toEqual({ input: 300, output: 80, cacheRead: 0, cacheCreation: 0, tokens: 380, costUsd: 2 });
      expect(summary.byProject).toEqual([{ repoRoot: env.project, name: 'project', tokens: 380, costUsd: 2 }]);
      expect(summary.byModel).toEqual([{ model: 'Opus', tokens: 380, costUsd: 2 }]);
    } finally {
      await env.close();
    }
  });

  it('shows no limit once its reset time has passed', async () => {
    const env = await coreEnv();
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      await env.cli('POST', '/api/v1/usage/snapshots', { snapshots: [snapshot({ fiveHour: { pct: 99, resetsAt: past }, sevenDay: { pct: 10, resetsAt: null } })] });
      const { limits } = await env.summary();
      expect(limits.fiveHour).toBeNull();
      expect(limits.sevenDay).toMatchObject({ pct: 10, resetsAt: null });
      const empty = await coreEnv();
      expect((await empty.summary()).limits).toEqual({ fiveHour: null, sevenDay: null });
      await empty.close();
    } finally {
      await env.close();
    }
  });

  it('prefers telemetry over snapshots for a session, and fills the 30 days with zeros', async () => {
    const env = await coreEnv();
    try {
      const threeDaysAgo = Date.now() - 3 * 86_400_000;
      await env.metrics(otlp('s-project', { input: 100 }, 0.1));
      await env.cli('POST', '/api/v1/usage/snapshots', {
        snapshots: [
          // Same session as telemetry: not counted twice.
          snapshot({ sessionId: 's-project', cwd: env.project, inputTokens: 5000, costUsd: 5 }),
          snapshot({ sessionId: 's-old', cwd: env.project, inputTokens: 10, outputTokens: 0, costUsd: 0.01, at: new Date(threeDaysAgo).toISOString() }),
        ],
      });
      const summary = await env.summary();
      expect(summary.daily).toHaveLength(30);
      expect(summary.daily.at(-1)!.date).toBe(localDate(Date.now()));
      expect(summary.daily.at(-4)).toEqual({ date: localDate(threeDaysAgo), tokens: 10, costUsd: 0.01 });
      expect(summary.daily.at(-1)).toMatchObject({ tokens: 100, costUsd: 0.1 });
      expect(summary.daily.filter((day) => day.tokens === 0)).toHaveLength(28);
      expect(summary.totals.today.tokens).toBe(100);
      expect(summary.totals.last7d.tokens).toBe(110);
      expect(summary.totals.last30d).toMatchObject({ tokens: 110, costUsd: 0.11 });
      expect(summary.daily.reduce((total, day) => total + day.tokens, 0)).toBe(summary.totals.last30d.tokens);
    } finally {
      await env.close();
    }
  });

  it('drains the snapshots the status line spooled while Core was down', async () => {
    const env = await coreEnv();
    try {
      const spool = jerryPaths(env.home).usageSpoolFile;
      fs.mkdirSync(path.dirname(spool), { recursive: true });
      const lines = [JSON.stringify(snapshot({ sessionId: 's-spooled', cwd: env.project, inputTokens: 70, outputTokens: 7, costUsd: 0.07, fiveHour: { pct: 12, resetsAt: null } })), 'not json', JSON.stringify({ sessionId: 5 })];
      fs.writeFileSync(spool, `${lines.join('\n')}\n`);
      expect(await drainUsageSpool(env.home, env.usage)).toBe(1);
      expect(fs.existsSync(spool)).toBe(false);
      expect(fs.readdirSync(path.dirname(spool)).filter((name) => name.includes('usage'))).toEqual([]);
      const summary = await env.summary();
      expect(summary.totals.today).toMatchObject({ tokens: 77, costUsd: 0.07 });
      expect(summary.limits.fiveHour?.pct).toBe(12);
      expect(await drainUsageSpool(env.home, env.usage)).toBe(0);
    } finally {
      await env.close();
    }
  });

  it('applies retention, prunes with the events and forgets a project, but keeps account-wide limits on forget', async () => {
    const env = await coreEnv();
    try {
      const old = Date.now() - 10 * 60_000;
      await env.metrics(otlp('s-project', { input: 100 }, 0.1, old));
      await env.cli('POST', '/api/v1/usage/snapshots', { snapshots: [snapshot({ sessionId: 's-project', cwd: env.project, inputTokens: 1, at: new Date(old).toISOString(), fiveHour: { pct: 5, resetsAt: null } })] });
      await env.cli('POST', '/api/v1/usage/jerry-share', { kind: 'mcp', chars: 400, origin: { sessionId: 's-project' } });
      const preview = (await env.cli('POST', '/api/v1/data/prune/preview', { eventsOlderThanDays: 0 })).json() as { rows: Record<string, number> };
      expect(preview.rows).toMatchObject({ usage_tokens: 2, usage_snapshots: 1, usage_limits: 1, usage_jerry_share: 1 });
      const usageCategory = ((await env.cli('GET', '/api/v1/data/usage')).json() as { categories: Array<{ category: string; tables: Array<{ table: string }> }> }).categories.find((category) => category.category === 'events')!;
      expect(usageCategory.tables.map((table) => table.table)).toEqual(expect.arrayContaining(['usage_tokens', 'usage_snapshots', 'usage_limits', 'usage_jerry_share']));

      const forgotten = (await env.cli('POST', '/api/v1/data/forget', { path: env.project })).json() as { rows: Record<string, number> };
      expect(forgotten.rows).toMatchObject({ usage_tokens: 2, usage_snapshots: 1, usage_jerry_share: 1 });
      expect(forgotten.rows['usage_limits']).toBeUndefined();
      expect((await env.summary()).limits.fiveHour?.pct).toBe(5);

      const removed = await env.store.applyRetention(new Date(Date.now() + 2 * 86_400_000), 1);
      expect(removed.usage).toBe(1);
      expect((await env.summary()).limits.fiveHour).toBeNull();
    } finally {
      await env.close();
    }
  });
});

describe('Core: settings, the collection switch and JERRY\'s share', () => {
  async function signIn(env: Env): Promise<{ cookie: string; csrf: string }> {
    const login = (await env.cli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const response = await env.app.inject({ method: 'GET', url: new URL(login.url).pathname + new URL(login.url).search, headers: { host: HOST } });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const info = await env.app.inject({ method: 'GET', url: '/api/v1/ui/session', headers: { host: HOST, cookie } });
    return { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  }

  it('has the usage bar on by default, and the user can turn it off', async () => {
    const env = await coreEnv();
    try {
      expect(((await env.cli('GET', '/api/v1/settings')).json() as Settings).usageShowBar).toBe(true);
      const updated = (await env.cli('POST', '/api/v1/settings', { usageShowBar: false })).json() as Settings;
      expect(updated).toMatchObject({ usageShowBar: false, reviewMode: 'optional' });
      expect((await env.summary()).collection.showBar).toBe(false);
      expect((await env.cli('POST', '/api/v1/settings', { usageShowBar: 'no' })).statusCode).toBe(400);
    } finally {
      await env.close();
    }
  });

  it('switches both sources like the CLI; from the dashboard only with its CSRF token and Origin', async () => {
    const env = await coreEnv();
    try {
      // What "jerry install" leaves in JERRY_HOME: the plugin with the status-line script.
      fs.mkdirSync(path.dirname(pluginStatuslinePayload(env.home)), { recursive: true });
      fs.copyFileSync(SCRIPT, pluginStatuslinePayload(env.home));
      const file = writeSettings(env.claudeConfigDir, { model: 'opus', env: { FOO: 'bar' } });
      const before = fs.readFileSync(file, 'utf8');

      const on = usageCollectionResultSchema.parse((await env.cli('POST', '/api/v1/usage/collection', { enabled: true })).json());
      expect(on).toEqual({ statusline: 'on', telemetry: 'on', showBar: true, problems: [] });
      const env1 = readJson(file)['env'] as Record<string, string>;
      expect(env1['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']).toBe(`http://127.0.0.1:${PORT}/v1/metrics`);
      expect(env1['OTEL_EXPORTER_OTLP_METRICS_HEADERS']).toBe(`${TELEMETRY_KEY_HEADER}=${env.key}`);
      expect(fs.existsSync(jerryPaths(env.home).runtimeStatuslineFile)).toBe(true);

      const browser = await signIn(env);
      const asBrowser = (headers: Record<string, string>) => env.app.inject({ method: 'POST', url: '/api/v1/usage/collection', headers: { host: HOST, cookie: browser.cookie, ...headers }, payload: { enabled: false } });
      expect((await asBrowser({ origin: ORIGIN })).statusCode).toBe(403);
      expect((await asBrowser({ 'x-jerry-csrf': browser.csrf })).statusCode).toBe(403);
      expect(readJson(file)['statusLine']).toBeDefined();
      const off = await asBrowser({ origin: ORIGIN, 'x-jerry-csrf': browser.csrf });
      expect(off.statusCode).toBe(200);
      expect(off.json()).toEqual({ statusline: 'off', telemetry: 'off', showBar: true, problems: [] });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);

      // A telemetry clash is reported, the status line is still turned on.
      writeSettings(env.claudeConfigDir, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' } });
      const clash = usageCollectionResultSchema.parse((await env.cli('POST', '/api/v1/usage/collection', { enabled: true })).json());
      expect(clash).toMatchObject({ statusline: 'on', telemetry: 'clash' });
      expect(clash.problems).toEqual([expect.stringContaining('OTEL_EXPORTER_OTLP_ENDPOINT')]);
      const audit = await env.store.kysely.selectFrom('audit_log').select('action').where('action', '=', 'usage.collection').execute();
      expect(audit).toHaveLength(3);
    } finally {
      await env.close();
    }
  });

  it("counts JERRY's share: reported answers of project sessions, and Core's own warnings", async () => {
    const env = await coreEnv();
    try {
      expect((await env.cli('POST', '/api/v1/usage/jerry-share', { kind: 'mcp', chars: 400, origin: { sessionId: 's-project' } })).json()).toEqual({ recorded: true });
      expect((await env.cli('POST', '/api/v1/usage/jerry-share', { kind: 'sessionStart', chars: 1000, origin: { sessionId: 's-project' } })).json()).toEqual({ recorded: true });
      expect((await env.cli('POST', '/api/v1/usage/jerry-share', { kind: 'mcp', chars: 999, origin: { sessionId: 's-other' } })).json()).toEqual({ recorded: false });
      expect((await env.cli('POST', '/api/v1/usage/jerry-share', { kind: 'warnings', chars: 1 })).statusCode).toBe(400);
      const gate = await env.cli('POST', '/api/v1/gate/check', { sessionId: 's-project', cwd: env.project, toolName: 'Write', toolInput: { file_path: path.join(env.project, 'src', 'new.ts') }, toolUseId: null, agentId: null });
      const decision = gate.json() as { verdict: string; reason: string; ruleId: string };
      expect(decision.verdict).toBe('WARN');
      const warning = decorate(EMOJI.warning, `JERRY: ${decision.reason} [${decision.ruleId}]`).length + decorate(EMOJI.warning, `JERRY warning: ${decision.reason} [${decision.ruleId}]`).length;
      expect((await env.summary()).jerryShare).toEqual({ chars30d: 1400 + warning, estimatedTokens30d: Math.round((1400 + warning) / 4), sessionStart: 1000, warnings: warning, mcp: 400 });
    } finally {
      await env.close();
    }
  });
});

describe('hook bridge: JERRY\'s share without changing what Claude reads (built bundle, real Core)', () => {
  it('reports the session-start context and Core counts the warning exactly as the bridge prints them', async () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const repo = createFixtureRepo(freshDir('bridge-repo'));
    const core = await startCore(home, { CLAUDE_CONFIG_DIR: claudeConfigDir }, { projects: [repo] });
    try {
      const env = { JERRY_HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir };
      const started = runBridge('session-start', { session_id: 'share-session', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }, env);
      expect(started.exitCode, started.stderr).toBe(0);
      const context = (JSON.parse(started.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
      expect(context).toContain('JERRY: monitoring this session');

      const warned = runBridge(
        'pre-tool-use',
        { session_id: 'share-session', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src', 'new.ts'), content: 'x' }, tool_use_id: 'toolu_share' },
        env,
      );
      expect(warned.exitCode, warned.stderr).toBe(0);
      const output = JSON.parse(warned.stdout) as { systemMessage: string; hookSpecificOutput: { additionalContext: string } };
      const summary = usageSummarySchema.parse((await api(core, 'GET', '/api/v1/usage')).body);
      expect(summary.jerryShare).toMatchObject({ sessionStart: context.length, warnings: output.systemMessage.length + output.hookSpecificOutput.additionalContext.length, mcp: 0 });
    } finally {
      await core.stop();
    }
  });

  it("registers the session's CLAUDE_CODE_ENTRYPOINT, so its telemetry without an entrypoint attribute is attributed to it", async () => {
    const home = freshDir('home');
    const claudeConfigDir = freshDir('claude');
    const repo = createFixtureRepo(freshDir('bridge-repo'));
    const core = await startCore(home, { CLAUDE_CONFIG_DIR: claudeConfigDir }, { projects: [repo] });
    try {
      const started = runBridge('session-start', { session_id: 'vscode-session', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' }, { JERRY_HOME: home, CLAUDE_CONFIG_DIR: claudeConfigDir, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' });
      expect(started.exitCode, started.stderr).toBe(0);
      const key = ensureTelemetryKey(home).key;
      const payload = JSON.stringify(otlp('vscode-session', { input: 40, output: 2 }, 0.02, Date.now(), null));
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port: core.info.port, method: 'POST', path: '/v1/metrics', headers: { 'content-type': 'application/json', [TELEMETRY_KEY_HEADER]: key } },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          },
        );
        request.on('error', reject);
        request.end(payload);
      });
      expect(status).toBe(200);
      const summary = usageSummarySchema.parse((await api(core, 'GET', '/api/v1/usage')).body);
      expect(summary.byEntrypoint).toEqual([{ entrypoint: 'claude-vscode', tokens: 42, costUsd: 0.02 }]);
      expect(Object.keys(summary.sources.telemetry.byEntrypoint)).toEqual(['claude-vscode']);
    } finally {
      await core.stop();
    }
  });
});
