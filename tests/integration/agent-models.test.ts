import fs from 'node:fs';
import path from 'node:path';
import type { AgentModelsResponse } from '@jerry/contracts';
import { readAgentModel } from '@jerry/platform';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCoreApp } from '../../apps/core/src/app.js';
import { BrowserSessions } from '../../apps/core/src/auth.js';
import { StateStore } from '../../apps/core/src/state-store.js';
import { tempDir } from '../helpers/harness.js';

const PORT = 47996;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;
// Built at runtime: a fixed-looking credential literal is not needed for an in-process test.
const TOKEN = ['agent', 'models', 'test'].join('-').padEnd(64, 'x');
type Payload = NonNullable<InjectOptions['payload']>;

const REPO_AGENTS = path.resolve(import.meta.dirname,'..', '..', 'claude-plugin', 'agents');

/**
 * The model and effort of JERRY's read-only subagents: defaults from the plugin, the user's choice
 * stored in Core and written into the installed plugin's agent files, again at every Core start.
 */
describe('models of the read-only subagents (Core API)', () => {
  const base = tempDir('agent-models');
  const home = path.join(base, 'home');
  const installedAgents = path.join(home, 'marketplace', 'plugins', 'jerry', 'agents');
  const sessions = new BrowserSessions();
  let store: StateStore;
  let app: FastifyInstance;

  const open = async (): Promise<void> => {
    store = await StateStore.open({ databaseFile: path.join(base, 'jerry.sqlite'), backupsDir: path.join(base, 'backups'), legacyStateFile: path.join(base, 'none.json') });
    app = buildCoreApp({ token: TOKEN, store, jerryHome: home, protectedRoots: [], startedAt: new Date(), port: () => PORT, sessions, onShutdownRequested: () => undefined });
    await app.ready();
  };
  const close = async (): Promise<void> => {
    await app.close();
    await store.close();
  };
  /** A fresh copy of the plugin's agents, as "jerry install" leaves them. */
  const install = (): void => {
    fs.rmSync(installedAgents, { recursive: true, force: true });
    fs.mkdirSync(installedAgents, { recursive: true });
    for (const name of fs.readdirSync(REPO_AGENTS)) fs.copyFileSync(path.join(REPO_AGENTS, name), path.join(installedAgents, name));
  };
  const installed = (role: string) => readAgentModel(fs.readFileSync(path.join(installedAgents, `${role}.md`), 'utf8'));

  beforeAll(async () => {
    install();
    await open();
  });
  afterAll(async () => {
    await close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const asCli = (method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, authorization: `Bearer ${TOKEN}` }, ...(payload === undefined ? {} : { payload }) });

  async function signIn(): Promise<{ cookie: string; csrf: string }> {
    const login = (await asCli('POST', '/api/v1/ui/login-codes', {})).json() as { url: string };
    const url = new URL(login.url);
    const response = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { host: HOST } });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const info = await app.inject({ method: 'GET', url: '/api/v1/ui/session', headers: { host: HOST, cookie } });
    return { cookie, csrf: (info.json() as { csrfToken: string }).csrfToken };
  }
  const asBrowser = (auth: { cookie: string; csrf?: string }, method: 'GET' | 'POST', url: string, payload?: Payload): Promise<LightMyRequestResponse> =>
    app.inject({ method, url, headers: { host: HOST, cookie: auth.cookie, origin: ORIGIN, ...(auth.csrf === undefined ? {} : { 'x-jerry-csrf': auth.csrf }) }, ...(payload === undefined ? {} : { payload }) });

  it('lists the six read-only subagents with the plugin defaults, which the shipped agent files carry', async () => {
    const response = (await asCli('GET', '/api/v1/agents/models')).json() as AgentModelsResponse;
    expect(response.problems).toEqual([]);
    expect(response.agents.map((agent) => agent.role)).toEqual([
      'jerry-architecture-analyst',
      'jerry-risk-analyst',
      'jerry-quality-analyst',
      'jerry-correctness-reviewer',
      'jerry-security-reviewer',
      'jerry-design-reviewer',
    ]);
    expect(response.agents.find((agent) => agent.role === 'jerry-quality-analyst')).toEqual({ role: 'jerry-quality-analyst', phase: 'analysis', model: 'claude-sonnet-5-5', effort: 'medium', defaults: { model: 'claude-sonnet-5-5', effort: 'medium' } });
    for (const agent of response.agents) expect(installed(agent.role)).toEqual(agent.defaults);
    // The implementer is not a model choice: it keeps the session's model.
    expect(installed('jerry-implementer')).toEqual({ model: 'inherit', effort: 'default' });
  });

  it('stores a choice, writes it into the installed agent file and audits it', async () => {
    const changed = await asCli('POST', '/api/v1/agents/models', { agents: [{ role: 'jerry-quality-analyst', model: 'claude-haiku-5-5', effort: 'low' }] });
    expect(changed.statusCode, changed.body).toBe(200);
    const body = changed.json() as AgentModelsResponse;
    expect(body.problems).toEqual([]);
    expect(body.agents.find((agent) => agent.role === 'jerry-quality-analyst')).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(installed('jerry-quality-analyst')).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    // Other agents keep theirs.
    expect(installed('jerry-risk-analyst')).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    const audit = await store.kysely.selectFrom('audit_log').select(['action', 'details_json']).where('action', '=', 'agents.models').execute();
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.details_json)).toMatchObject({ channel: 'cli', update: [{ role: 'jerry-quality-analyst', model: 'claude-haiku-5-5', effort: 'low' }] });
  });

  it('inherit and default remove the lines, so the subagent follows the session', async () => {
    await asCli('POST', '/api/v1/agents/models', { agents: [{ role: 'jerry-design-reviewer', model: 'inherit', effort: 'default' }] });
    const text = fs.readFileSync(path.join(installedAgents, 'jerry-design-reviewer.md'), 'utf8');
    expect(text).not.toMatch(/^model:/m);
    expect(text).not.toMatch(/^effort:/m);
  });

  it('refuses unknown roles, the implementer, unknown models and efforts', async () => {
    for (const agents of [
      [{ role: 'jerry-implementer', model: 'claude-opus-5-5', effort: 'high' }],
      [{ role: 'someone', model: 'claude-opus-5-5', effort: 'high' }],
      [{ role: 'jerry-risk-analyst', model: 'gpt-x', effort: 'high' }],
      [{ role: 'jerry-risk-analyst', model: 'claude-opus-5-5', effort: 'extreme' }],
      [{ role: 'jerry-risk-analyst', model: 'claude-opus-5-5\nhooks: evil', effort: 'high' }],
      [],
    ]) {
      expect((await asCli('POST', '/api/v1/agents/models', { agents })).statusCode).toBe(400);
    }
    expect(installed('jerry-risk-analyst')).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('changes models from the dashboard only with its CSRF token and Origin', async () => {
    const auth = await signIn();
    const payload = { agents: [{ role: 'jerry-risk-analyst', model: 'claude-sonnet-5-5', effort: 'xhigh' }] };
    expect((await asBrowser({ cookie: auth.cookie }, 'POST', '/api/v1/agents/models', payload)).statusCode).toBe(403);
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/agents/models', headers: { host: HOST, cookie: auth.cookie, origin: 'https://evil.example', 'x-jerry-csrf': auth.csrf }, payload });
    expect(foreign.statusCode).toBe(403);
    expect(installed('jerry-risk-analyst')).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    const changed = await asBrowser(auth, 'POST', '/api/v1/agents/models', payload);
    expect(changed.statusCode, changed.body).toBe(200);
    expect(installed('jerry-risk-analyst')).toEqual({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
  });

  it('writes the choice again at the next Core start, after a reinstall replaced the files', async () => {
    await close();
    install();
    expect(installed('jerry-quality-analyst')).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
    await open();
    expect(installed('jerry-quality-analyst')).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(installed('jerry-risk-analyst')).toEqual({ model: 'claude-sonnet-5-5', effort: 'xhigh' });
  });

  it('reports a missing plugin instead of failing', async () => {
    fs.rmSync(path.join(home, 'marketplace'), { recursive: true, force: true });
    const changed = await asCli('POST', '/api/v1/agents/models', { agents: [{ role: 'jerry-security-reviewer', model: 'claude-opus-5-5', effort: 'max' }] });
    expect(changed.statusCode).toBe(200);
    expect((changed.json() as AgentModelsResponse).problems[0]).toContain('jerry install');
  });
});
