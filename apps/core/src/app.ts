import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  approvalRequestSchema,
  eventIngestRequestSchema,
  gateCheckRequestSchema,
  JERRY_VERSION,
  planReviseRequestSchema,
  repositoryExclusionRequestSchema,
  sessionRegistrationSchema,
  taskCreateRequestSchema,
  taskIdSchema,
  type CoreState,
  type CoreStatus,
  type GateCheckRequest,
  type GateDecision,
  type SessionRegistrationResponse,
} from '@jerry/contracts';
import { approvedPlansForRepo, evaluateGate, isRepoExcluded } from '@jerry/policy-engine';
import { buildEventEnvelope } from '@jerry/trace-engine';
import type { z } from 'zod';
import { BrowserSessions, clearedSessionCookie, CSRF_HEADER, readCookie, safeEqual, SESSION_COOKIE, sessionCookie, type BrowserSession } from './auth.js';
import { evaluatePending } from './events.js';
import { findGitRoot, realPathOfNearestExisting } from './repo-fs.js';
import { StateError, type StateStore } from './state-store.js';
import { dashboardPlaceholderPage, HTML_SECURITY_HEADERS, signedOutPage } from './ui.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENTS_PAGE = 500;

/** token: the CLI and hooks (bearer token from core.json). session: the dashboard in a browser. */
type Client = { kind: 'token' } | { kind: 'session'; session: BrowserSession };
type ClientKind = Client['kind'];

declare module 'fastify' {
  interface FastifyRequest {
    client: Client | null;
  }
  interface FastifyContextConfig {
    /** Who may call the route. Routes without it are public (health, login). */
    clients?: readonly ClientKind[];
  }
}

export interface CoreAppOptions {
  token: string;
  store: StateStore;
  jerryHome: string;
  protectedRoots: readonly string[];
  startedAt: Date;
  /** The port Core listens on; Host and Origin checks are derived from it. */
  port: () => number;
  sessions?: BrowserSessions;
  onShutdownRequested: () => void;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The gate as Core evaluates it: real filesystem lookups plus the current state snapshot. */
export function gateEvaluator(store: StateStore, protectedRoots: readonly string[]): (request: GateCheckRequest) => GateDecision {
  return (request) => {
    const snapshot: CoreState = store.snapshot();
    return evaluateGate(request, {
      platform: process.platform,
      protectedRoots,
      realPath: realPathOfNearestExisting,
      findRepoRoot: findGitRoot,
      approvedPlans: (repoRoot) => approvedPlansForRepo(snapshot, repoRoot, process.platform),
      isExcluded: (repoRoot) => isRepoExcluded(snapshot, repoRoot, process.platform),
    });
  };
}

const TOKEN_ONLY = { clients: ['token'] } as const;
const TOKEN_OR_SESSION = { clients: ['token', 'session'] } as const;
const SESSION_ONLY = { clients: ['session'] } as const;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function buildCoreApp(options: CoreAppOptions): FastifyInstance {
  const { store } = options;
  const sessions = options.sessions ?? new BrowserSessions();
  const evaluate = gateEvaluator(store, options.protectedRoots);
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES, return503OnClosing: true });
  const origins = (): string[] => [`http://127.0.0.1:${options.port()}`, `http://localhost:${options.port()}`];

  app.decorateRequest('client', null);

  // 1. DNS rebinding: only our own loopback host names are answered.
  // 2. Identify the caller: bearer token (CLI, hooks) or browser session (dashboard).
  app.addHook('onRequest', async (request) => {
    const host = request.headers.host ?? '';
    if (!origins().some((origin) => origin === `http://${host}`)) throw new HttpError(421, 'Unexpected Host header');
    request.client = identify(request, options.token, sessions, origins());
  });

  // 3. Per-route access: who may call it, and CSRF for state-changing browser requests.
  app.addHook('preHandler', async (request) => {
    const allowed = request.routeOptions.config.clients;
    if (allowed === undefined) return;
    const client = request.client;
    if (client === null) throw new HttpError(401, 'Missing or invalid JERRY credentials. Open the dashboard with "jerry ui".');
    if (!allowed.includes(client.kind)) throw new HttpError(403, client.kind === 'session' ? 'This endpoint is for the JERRY CLI and hooks only' : 'This endpoint is for the dashboard only');
    if (client.kind === 'session' && MUTATING.has(request.method)) {
      const origin = request.headers.origin;
      if (origin === undefined || !origins().includes(origin)) throw new HttpError(403, 'State-changing browser requests must come from the JERRY dashboard origin');
      const csrf = request.headers[CSRF_HEADER];
      if (typeof csrf !== 'string' || !safeEqual(csrf, client.session.csrfToken)) throw new HttpError(403, 'Missing or invalid CSRF token');
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message, details: error.details });
    if (error instanceof StateError) return reply.code(error.statusCode).send({ error: error.message });
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'internal error' });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: `No route for ${request.method} ${request.url.split('?')[0]}` }));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  // --- public -----------------------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ui/login', async (request, reply) => {
    const code = (request.query as { code?: unknown }).code;
    const session = typeof code === 'string' ? sessions.redeemLoginCode(code) : null;
    reply.headers(HTML_SECURITY_HEADERS).header('referrer-policy', 'no-referrer');
    if (session === null) return reply.code(401).type('text/html; charset=utf-8').send(signedOutPage('This login link is invalid, already used or expired. Run "jerry ui" again.'));
    return reply.header('set-cookie', sessionCookie(session)).redirect('/', 302);
  });

  // --- dashboard (browser session) -----------------------------------------------------------
  app.get('/', { config: SESSION_ONLY, errorHandler: htmlErrors }, async (_request, reply) =>
    reply.headers(HTML_SECURITY_HEADERS).type('text/html; charset=utf-8').send(dashboardPlaceholderPage(JERRY_VERSION)),
  );

  app.get('/api/v1/ui/session', { config: SESSION_ONLY }, async (request) => {
    const { session } = request.client as Extract<Client, { kind: 'session' }>;
    return { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  app.post('/ui/logout', { config: SESSION_ONLY }, async (request, reply) => {
    sessions.revoke((request.client as Extract<Client, { kind: 'session' }>).session.id);
    return reply.header('set-cookie', clearedSessionCookie()).send({ signedOut: true });
  });

  // --- CLI and hooks (bearer token) -----------------------------------------------------------
  app.post('/api/v1/ui/login-codes', { config: TOKEN_ONLY }, async () => {
    const { code, expiresAt } = sessions.issueLoginCode();
    return { url: `${origins()[0]}/ui/login?code=${code}`, expiresAt: new Date(expiresAt).toISOString() };
  });

  app.get('/api/v1/status', { config: TOKEN_OR_SESSION }, async () => {
    const snapshot = store.snapshot();
    const status: CoreStatus = {
      status: 'ok',
      version: JERRY_VERSION,
      pid: process.pid,
      startedAt: options.startedAt.toISOString(),
      jerryHome: options.jerryHome,
      taskCount: snapshot.tasks.length,
      sessionCount: store.sessionCount,
      database: { file: store.databaseFile, migration: store.migration },
    };
    return status;
  });

  app.post('/api/v1/gate/check', { config: TOKEN_ONLY }, async (request) => {
    const now = new Date();
    const gateRequest = parse(gateCheckRequestSchema, request.body);
    const decision = evaluate(gateRequest);
    const event = buildEventEnvelope(
      {
        hook_event_name: 'PreToolUse',
        session_id: gateRequest.sessionId,
        cwd: gateRequest.cwd,
        tool_name: gateRequest.toolName,
        tool_input: gateRequest.toolInput,
        tool_use_id: gateRequest.toolUseId,
        agent_id: gateRequest.agentId,
      },
      {
        ...(gateRequest.eventId === undefined ? {} : { eventId: gateRequest.eventId }),
        timestamp: now,
        verdict: decision.verdict,
        ruleId: decision.ruleId,
        taskId: decision.taskId,
        repoRoot: decision.repoRoot,
        extraPayload: { reason: decision.reason },
      },
    );
    if (event !== null) await store.recordEvents([event], now, false);
    return decision;
  });

  app.post('/api/v1/events', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(eventIngestRequestSchema, request.body);
    const inserted = await store.recordEvents(body.events.map((event) => evaluatePending(event, evaluate)), new Date(), false);
    return reply.code(202).send({ accepted: body.events.length, inserted });
  });

  app.get('/api/v1/events', { config: TOKEN_OR_SESSION }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const limit = Math.min(Number(query['limit'] ?? '100') || 100, MAX_EVENTS_PAGE);
    const sessionId = typeof query['sessionId'] === 'string' ? query['sessionId'] : undefined;
    const verdict = typeof query['verdict'] === 'string' ? query['verdict'] : undefined;
    return store.listEvents({ limit, ...(sessionId === undefined ? {} : { sessionId }), ...(verdict === undefined ? {} : { verdict }) });
  });

  app.post('/api/v1/sessions', { config: TOKEN_ONLY }, async (request) => {
    const now = new Date();
    const registration = parse(sessionRegistrationSchema, request.body);
    await store.registerSession(registration, now);
    const sessionEvent = buildEventEnvelope(
      { hook_event_name: 'SessionStart', session_id: registration.sessionId, cwd: registration.cwd, source: registration.source },
      { timestamp: now },
    );
    if (sessionEvent !== null) await store.recordEvents([sessionEvent], now, false);
    const repoRoot = findGitRoot(realPathOfNearestExisting(registration.cwd));
    const snapshot = store.snapshot();
    const response: SessionRegistrationResponse = {
      registered: true,
      repoRoot,
      excluded: repoRoot !== null && isRepoExcluded(snapshot, repoRoot, process.platform),
      approvedPlans:
        repoRoot === null
          ? []
          : approvedPlansForRepo(snapshot, repoRoot, process.platform).map((plan) => ({ taskId: plan.taskId, planVersion: plan.planVersion, scope: [...plan.scope] })),
    };
    return response;
  });

  app.get('/api/v1/repositories/exclusions', { config: TOKEN_OR_SESSION }, async () => store.snapshot().excludedRepos);

  app.post('/api/v1/repositories/exclusions', { config: TOKEN_OR_SESSION }, async (request) => {
    const body = parse(repositoryExclusionRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    if (fromDashboard && body.excluded && body.confirmation !== 'exclude') {
      throw new HttpError(400, 'Excluding a repository from the dashboard needs the typed confirmation "exclude"');
    }
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    await store.setExcluded(repoRoot, body.excluded, new Date(), fromDashboard ? 'dashboard' : 'cli');
    return { repoRoot, excluded: body.excluded };
  });

  app.get('/api/v1/tasks', { config: TOKEN_OR_SESSION }, async () =>
    store.snapshot().tasks.map((task) => ({ ...task, planDecision: store.planDecision(task.taskId) })),
  );

  app.post('/api/v1/tasks', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(taskCreateRequestSchema, request.body);
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    return reply.code(201).send(await store.createTask({ repoRoot, title: body.title, scope: body.scope }, new Date()));
  });

  app.post('/api/v1/tasks/:taskId/plan', { config: TOKEN_ONLY }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(planReviseRequestSchema, request.body);
    return store.revisePlan(taskId, body.scope, new Date());
  });

  app.post('/api/v1/tasks/:taskId/approvals', { config: TOKEN_OR_SESSION }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(approvalRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    if (fromDashboard && body.confirmTaskId !== taskId) {
      throw new HttpError(400, `Approving from the dashboard needs the task ID typed as confirmation (${taskId})`);
    }
    return reply.code(201).send(await store.recordApproval(taskId, body, new Date(), fromDashboard ? 'dashboard' : 'cli'));
  });

  app.post('/api/v1/database/backups', { config: TOKEN_OR_SESSION }, async (_request, reply) => reply.code(201).send({ file: await store.backup('manual') }));

  app.post('/api/v1/shutdown', { config: TOKEN_ONLY }, async (_request, reply) => {
    setImmediate(options.onShutdownRequested);
    return reply.code(202).send({ stopping: true });
  });

  return app;
}

/**
 * Bearer token: CLI and hooks. A request carrying both a token and an Origin header came from a
 * browser page holding the token, which never happens legitimately, so it is refused.
 * Session cookie: the dashboard; a cross-site Origin or Sec-Fetch-Site is refused.
 */
function identify(request: FastifyRequest, token: string, sessions: BrowserSessions, origins: readonly string[]): Client | null {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!safeEqual(presented, token)) throw new HttpError(401, 'Missing or invalid JERRY token');
    if (request.headers.origin !== undefined) throw new HttpError(403, 'Browser-originated requests may not use the CLI token');
    return { kind: 'token' };
  }
  const sessionId = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (sessionId === null) return null;
  const session = sessions.get(sessionId);
  if (session === null) return null;
  const origin = request.headers.origin;
  if (origin !== undefined && !origins.includes(origin)) throw new HttpError(403, 'Cross-origin requests are not accepted');
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site requests are not accepted');
  return { kind: 'session', session };
}

/** Pages get a readable HTML answer instead of JSON when access is refused. */
function htmlErrors(error: Error, _request: FastifyRequest, reply: FastifyReply): FastifyReply {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  return reply.code(statusCode).headers(HTML_SECURITY_HEADERS).type('text/html; charset=utf-8').send(signedOutPage('Open the JERRY dashboard with "jerry ui" in a terminal.'));
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'Request validation failed', result.error.issues);
  return result.data;
}
