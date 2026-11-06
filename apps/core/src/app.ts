import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  approvalRequestSchema,
  eventIngestRequestSchema,
  gateCheckRequestSchema,
  gatePreviewRequestSchema,
  JERRY_VERSION,
  planReviseRequestSchema,
  repositoryExclusionRequestSchema,
  sessionRegistrationSchema,
  taskCreateRequestSchema,
  taskIdSchema,
  taskTransitionRequestSchema,
  checkpointRequestSchema,
  reportSubmitRequestSchema,
  type CoreState,
  type CoreStatus,
  type GateCheckRequest,
  type GateDecision,
  type OpenTask,
  type RepositoryState,
  type SessionRegistrationResponse,
  type Task,
  type TaskDetail,
  type TaskSummary,
} from '@jerry/contracts';
import { approvedPlansForRepo, comparablePath, evaluateGate, isRepoExcluded } from '@jerry/policy-engine';
import { isTerminal } from '@jerry/workflow';
import { buildEventEnvelope } from '@jerry/trace-engine';
import type { z } from 'zod';
import { BrowserSessions, clearedSessionCookie, CSRF_HEADER, readCookie, safeEqual, SESSION_COOKIE, sessionCookie, type BrowserSession } from './auth.js';
import { evaluatePending } from './events.js';
import { findGitRoot, realPathOfNearestExisting } from './repo-fs.js';
import { StateError, type StateStore } from './state-store.js';
import { readDashboardFile } from './static-files.js';
import { DASHBOARD_SECURITY_HEADERS, dashboardPlaceholderPage, HTML_SECURITY_HEADERS, signedOutPage } from './ui.js';

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
  /** Built dashboard (index.html, assets/, icons/); without it `/` shows a placeholder page. */
  dashboardDir?: string;
  /** Short hash of the running core.mjs (see buildHash). */
  build?: string;
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
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
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
  app.get('/', { config: SESSION_ONLY, errorHandler: htmlErrors }, async (_request, reply) => {
    const index = readDashboardFile(options.dashboardDir, '', 'index.html');
    if (index === null) {
      return reply.headers(HTML_SECURITY_HEADERS).type('text/html; charset=utf-8').send(dashboardPlaceholderPage(JERRY_VERSION));
    }
    return reply.headers(DASHBOARD_SECURITY_HEADERS).type(index.contentType).send(index.body);
  });

  app.get('/assets/:name', { config: SESSION_ONLY }, async (request, reply) => {
    const file = readDashboardFile(options.dashboardDir, 'assets', (request.params as { name: string }).name);
    if (file === null) throw new HttpError(404, 'No such dashboard asset');
    // Content-hashed file names: safe to cache for good, but only in this user's browser.
    return reply.header('cache-control', 'private, max-age=31536000, immutable').type(file.contentType).send(file.body);
  });

  // The manifest and icons are fetched without cookies when the dashboard is installed as an app; they hold no data.
  app.get('/manifest.webmanifest', async (_request, reply) => {
    const file = readDashboardFile(options.dashboardDir, '', 'manifest.webmanifest');
    if (file === null) throw new HttpError(404, 'The dashboard is not built');
    return reply.type(file.contentType).send(file.body);
  });

  app.get('/icons/:name', async (request, reply) => {
    const file = readDashboardFile(options.dashboardDir, 'icons', (request.params as { name: string }).name);
    if (file === null) throw new HttpError(404, 'No such icon');
    return reply.type(file.contentType).send(file.body);
  });

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
      ...(options.build === undefined ? {} : { build: options.build }),
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
    const text = (key: string): string | undefined => (typeof query[key] === 'string' && query[key] !== '' ? (query[key] as string) : undefined);
    const limit = Math.min(Number(query['limit'] ?? '100') || 100, MAX_EVENTS_PAGE);
    const sessionId = text('sessionId');
    const verdicts = text('verdict')?.split(',').map((verdict) => verdict.trim().toUpperCase());
    const since = text('since');
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new HttpError(400, 'since must be an ISO-8601 timestamp');
    const repoPath = text('repoPath');
    const repoRoot = repoPath === undefined ? undefined : (findGitRoot(realPathOfNearestExisting(repoPath)) ?? repoPath);
    return store.listEvents({
      limit,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(verdicts === undefined ? {} : { verdicts }),
      ...(repoRoot === undefined ? {} : { repoRoot }),
      ...(since === undefined ? {} : { since: new Date(since).toISOString() }),
    });
  });

  app.get('/api/v1/repositories/state', { config: TOKEN_OR_SESSION }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const path = query['path'];
    if (typeof path !== 'string' || path === '') throw new HttpError(400, 'path is required');
    const sessionId = typeof query['sessionId'] === 'string' && query['sessionId'] !== '' ? query['sessionId'] : null;
    const repoRoot = findGitRoot(realPathOfNearestExisting(path));
    const snapshot = store.snapshot();
    const tasks = repoRoot === null ? [] : snapshot.tasks.filter((task) => sameRepo(task.repoRoot, repoRoot));
    const state: RepositoryState = {
      repoRoot,
      excluded: repoRoot !== null && isRepoExcluded(snapshot, repoRoot, process.platform),
      tasks: await summarize(store, tasks),
      sessionTasks: sessionId === null ? [] : (await store.tasksOfSession(sessionId)).filter((taskId) => tasks.some((task) => task.taskId === taskId)),
    };
    return state;
  });

  /** What the gate would say about edits to these paths; nothing is recorded. */
  app.post('/api/v1/gate/preview', { config: TOKEN_ONLY }, async (request) => {
    const body = parse(gatePreviewRequestSchema, request.body);
    return {
      decisions: body.paths.map((target) => ({
        path: target,
        ...evaluate({ sessionId: 'preview', cwd: body.cwd, toolName: 'Write', toolInput: { file_path: target }, toolUseId: null, agentId: null }),
      })),
    };
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
    const excluded = repoRoot !== null && isRepoExcluded(snapshot, repoRoot, process.platform);
    const approvedPlans = repoRoot === null ? [] : approvedPlansForRepo(snapshot, repoRoot, process.platform);
    const response: SessionRegistrationResponse = {
      registered: true,
      repoRoot,
      excluded,
      approvedPlans: approvedPlans.map((plan) => ({ taskId: plan.taskId, planVersion: plan.planVersion, scope: [...plan.scope] })),
      openTasks: repoRoot === null || excluded ? [] : await openTasksFor(store, snapshot, repoRoot, registration.sessionId, new Set(approvedPlans.map((plan) => plan.taskId))),
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

  app.get('/api/v1/tasks', { config: TOKEN_OR_SESSION }, async () => summarize(store, store.snapshot().tasks));

  app.get('/api/v1/tasks/:taskId', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const task = store.snapshot().tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) throw new HttpError(404, `Unknown task ${taskId}`);
    const [summary] = await summarize(store, [task]);
    const detail: TaskDetail = { ...summary!, ...(await store.taskHistory(taskId)), reports: await store.reportsOf(taskId) };
    return detail;
  });

  /** Claude's implementation report (through MCP): moves the task to the user's acceptance. */
  app.post('/api/v1/tasks/:taskId/reports', { config: TOKEN_ONLY }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(reportSubmitRequestSchema, request.body);
    const sessionId = await store.resolveOrigin(body.origin);
    return reply.code(201).send(await store.submitReport(taskId, body.report, body.submittedBy, sessionId, new Date()));
  });

  app.post('/api/v1/tasks', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(taskCreateRequestSchema, request.body);
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    const sessionId = await store.resolveOrigin(body.origin);
    return reply
      .code(201)
      .send(await store.createTask({ repoRoot, title: body.title, scope: body.scope, ...(body.document === undefined ? {} : { document: body.document }), submittedBy: body.submittedBy, sessionId }, new Date()));
  });

  app.post('/api/v1/tasks/:taskId/plan', { config: TOKEN_ONLY }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(planReviseRequestSchema, request.body);
    return store.revisePlan(taskId, body.scope, new Date(), body.document, body.submittedBy, await store.resolveOrigin(body.origin));
  });

  /** Claude's progress notes (through MCP). Notes only: no state changes. */
  app.post('/api/v1/tasks/:taskId/checkpoints', { config: TOKEN_ONLY }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(checkpointRequestSchema, request.body);
    const sessionId = await store.resolveOrigin(body.origin);
    return reply.code(201).send(await store.saveCheckpoint(taskId, { summary: body.summary, nextSteps: body.nextSteps }, sessionId, new Date()));
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

  app.get('/api/v1/tasks/:taskId/transitions', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    return store.listTransitions(taskId);
  });

  /** Pause, resume or cancel: user decisions, like approvals (the CLI asks in a terminal, the dashboard asks for the typed ID). */
  app.post('/api/v1/tasks/:taskId/transitions', { config: TOKEN_OR_SESSION }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(taskTransitionRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    if (fromDashboard && body.event === 'task.cancelled' && body.confirmTaskId !== taskId) {
      throw new HttpError(400, `Cancelling from the dashboard needs the task ID typed as confirmation (${taskId})`);
    }
    return reply.code(201).send(await store.controlTask(taskId, body.event, body.reason, new Date(), fromDashboard ? 'dashboard' : 'cli'));
  });

  app.post('/api/v1/database/backups', { config: TOKEN_OR_SESSION }, async (_request, reply) => reply.code(201).send({ file: await store.backup('manual') }));

  app.get('/api/v1/database/health', { config: TOKEN_ONLY }, async () => ({ integrity: store.integrityCheck(), migration: store.migration, file: store.databaseFile }));

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

function sameRepo(a: string, b: string): boolean {
  return comparablePath(a, a, process.platform) === comparablePath(b, b, process.platform);
}

const NO_ACTIVITY = { activity: { sessionCount: 0, lastSessionId: null, lastActivityAt: null, lastSessionEndedAt: null }, lastCheckpoint: null };

async function summarize(store: StateStore, tasks: readonly Task[]): Promise<TaskSummary[]> {
  const [activity, reports] = await Promise.all([store.taskActivity(), store.latestReports()]);
  return tasks.map((task) => {
    const report = reports.get(task.taskId) ?? null;
    return {
      ...task,
      planDecision: store.planDecision(task.taskId),
      ...(activity.get(task.taskId) ?? NO_ACTIVITY),
      lastReport: report,
      reportDecision: report === null ? null : store.reportDecision(report),
    };
  });
}

/** At most this many open tasks go into a session's start context. */
const MAX_OPEN_TASKS = 10;

/**
 * What a starting session should know to resume work (ADR 0013): the repository's open tasks,
 * the ones this session already worked on first (same ID after resume or compaction), then the
 * most recently active.
 */
async function openTasksFor(store: StateStore, snapshot: CoreState, repoRoot: string, sessionId: string, covering: ReadonlySet<string>): Promise<OpenTask[]> {
  const tasks = snapshot.tasks.filter((task) => sameRepo(task.repoRoot, repoRoot) && !isTerminal(task.state));
  if (tasks.length === 0) return [];
  const activity = await store.taskActivity();
  const mine = new Set(await store.tasksOfSession(sessionId));
  const recency = (task: Task): string => activity.get(task.taskId)?.activity.lastActivityAt ?? task.createdAt;
  return tasks
    .sort((a, b) => Number(mine.has(b.taskId)) - Number(mine.has(a.taskId)) || recency(b).localeCompare(recency(a)))
    .slice(0, MAX_OPEN_TASKS)
    .map((task) => {
      const checkpoint = activity.get(task.taskId)?.lastCheckpoint ?? null;
      return {
        taskId: task.taskId,
        title: task.title,
        state: task.state,
        planVersion: task.plan.version,
        scope: task.plan.scope,
        coversEdits: covering.has(task.taskId),
        workedInThisSession: mine.has(task.taskId),
        lastActivityAt: activity.get(task.taskId)?.activity.lastActivityAt ?? null,
        checkpoint: checkpoint === null ? null : { summary: checkpoint.summary, nextSteps: checkpoint.nextSteps, at: checkpoint.at },
      };
    });
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
