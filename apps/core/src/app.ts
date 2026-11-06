import fs from 'node:fs';
import path from 'node:path';
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
  taskIntakeRequestSchema,
  findingIdSchema,
  findingStatusRequestSchema,
  findingStatusSchema,
  findingsQuerySchema,
  assignmentRequestSchema,
  fixPlanRequestSchema,
  fixesReportRequestSchema,
  reviewSkipRequestSchema,
  reviewSubmissionRequestSchema,
  evalBaselineRequestSchema,
  evalLabelRequestSchema,
  evalRunSubmissionSchema,
  artifactDecisionRequestSchema,
  taskIdSchema,
  taskTransitionRequestSchema,
  checkpointRequestSchema,
  reportSubmitRequestSchema,
  repositoryScanRequestSchema,
  analysisReportRequestSchema,
  type CoreState,
  type RepositorySummary,
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
import { EMOJI, SEVERITY_EMOJI, decorate } from '@jerry/contracts/emoji';
import { absolutePath, approvedPlansForRepo, comparablePath, evaluateGate, gradePlan, isRepoExcluded, relativeInside } from '@jerry/policy-engine';
import { isTerminal, WORK_STATES } from '@jerry/workflow';
import { buildEventEnvelope } from '@jerry/trace-engine';
import type { z } from 'zod';
import { BrowserSessions, clearedSessionCookie, CSRF_HEADER, readCookie, safeEqual, SESSION_COOKIE, sessionCookie, type BrowserSession } from './auth.js';
import { evaluatePending, withRepoRoot } from './events.js';
import { checkCitations } from './citations.js';
import { ProfileService } from './profiles.js';
import { QualityScheduler } from './quality-scheduler.js';
import { EvalStore } from './eval-store.js';
import { buildFinalReport } from './final-report.js';
import { jerryFingerprint, type JerryFingerprint } from '@jerry/evals';
import { collectTestRun, targetedTestsFor } from './test-runs.js';
import { findGitRoot, realPathOfNearestExisting } from './repo-fs.js';
import { StateError, type StateStore } from './state-store.js';
import { loadDashboard } from './static-files.js';
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
  /** Project profiles; tests may pass one with a fake PATH lookup. */
  profiles?: ProfileService;
  /** Continuous quality checks; tests may pass one with a short debounce. */
  quality?: QualityScheduler;
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
      isUserChangedFile: (taskId, relativePath) => store.isUserChangedFile(taskId, relativePath),
      activeSubagents: (sessionId) => store.activeSubagents(sessionId),
      implementerCheck: (taskId, agentId, relativePath) => store.implementerCheck(taskId, agentId, relativePath),
      agentType: (agentId) => store.agentTypeOf(agentId),
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
  const profiles = options.profiles ?? new ProfileService(store);
  // Read once: a running Core serves the dashboard of its own version, even after a new build or install.
  const dashboard = loadDashboard(options.dashboardDir);
  const quality = options.quality ?? new QualityScheduler({ store, git: store.gitReader });
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES, return503OnClosing: true });
  const origins = (): string[] => [`http://127.0.0.1:${options.port()}`, `http://localhost:${options.port()}`];

  app.decorateRequest('client', null);

  // 1. DNS rebinding: only our own loopback host names are answered.
  // 2. Identify the caller: bearer token (CLI, hooks) or browser session (dashboard).
  // Finish running checks on close; a scheduler passed in (shared across app instances) is stopped by its owner.
  app.addHook('onClose', async () => {
    await quality.idle();
    if (options.quality === undefined) quality.stop();
  });

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
    const index = dashboard.read('', 'index.html');
    if (index === null) {
      return reply.headers(HTML_SECURITY_HEADERS).type('text/html; charset=utf-8').send(dashboardPlaceholderPage(JERRY_VERSION));
    }
    return reply.headers(DASHBOARD_SECURITY_HEADERS).type(index.contentType).send(index.body);
  });

  app.get('/assets/:name', { config: SESSION_ONLY }, async (request, reply) => {
    const file = dashboard.read('assets', (request.params as { name: string }).name);
    if (file === null) throw new HttpError(404, 'No such dashboard asset');
    // Content-hashed file names: safe to cache for good, but only in this user's browser.
    return reply.header('cache-control', 'private, max-age=31536000, immutable').type(file.contentType).send(file.body);
  });

  // The manifest and icons are fetched without cookies when the dashboard is installed as an app; they hold no data.
  app.get('/manifest.webmanifest', async (_request, reply) => {
    const file = dashboard.read('', 'manifest.webmanifest');
    if (file === null) throw new HttpError(404, 'The dashboard is not built');
    return reply.type(file.contentType).send(file.body);
  });

  app.get('/icons/:name', async (request, reply) => {
    const file = dashboard.read('icons', (request.params as { name: string }).name);
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
    if (event !== null) await store.recordEvents([withRepoRoot(event)], now, false);
    // One warning per file and task about the user's uncommitted changes (previews do not count).
    const target = gateRequest.toolInput['file_path'] ?? gateRequest.toolInput['notebook_path'];
    const relative =
      typeof target === 'string' && decision.repoRoot !== null ? relativeInside(absolutePath(realPathOfNearestExisting(absolutePath(target, gateRequest.cwd, process.platform)), gateRequest.cwd, process.platform), decision.repoRoot, process.platform) : null;
    if (decision.ruleId === 'monitor.user-uncommitted-file' && decision.taskId !== null && relative !== null) store.markUserFileWarned(decision.taskId, relative);
    // Who edits which file: concurrent writes, and an implementer's first edit binds it to its assignment.
    if (decision.verdict !== 'DENY' && decision.taskId !== null && relative !== null) await store.noteWrite(decision.taskId, relative, gateRequest.agentId ?? null, now);
    // New quality findings of the work this session does, each told once.
    if (decision.verdict !== 'DENY') {
      const feedback = await qualityFeedback(store, gateRequest.sessionId, now);
      if (feedback !== null) return { ...decision, feedback };
    }
    return decision;
  });

  app.post('/api/v1/events', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(eventIngestRequestSchema, request.body);
    const events = body.events.map((event) => withRepoRoot(evaluatePending(event, evaluate)));
    const inserted = await store.recordEvents(events, new Date(), false);
    // Edits feed the continuous quality checks; they run later, after a quiet period.
    for (const event of events) quality.observe(event);
    // How Claude's test commands ended; never their output.
    for (const event of events) await collectTestRun(store, event);
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
    // Refresh the project profile in the background, so it is ready when Claude asks for it.
    if (repoRoot !== null && !excluded) setImmediate(() => void profiles.get(repoRoot, 'auto').catch(() => undefined));
    return response;
  });

  app.get('/api/v1/repositories/exclusions', { config: TOKEN_OR_SESSION }, async () => store.snapshot().excludedRepos);

  /** The project profile of the repository containing a path; rescanned when stale. */
  app.get('/api/v1/repositories/profile', { config: TOKEN_OR_SESSION }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const target = query['path'];
    if (typeof target !== 'string' || target === '') throw new HttpError(400, 'path is required');
    const mode = query['refresh'] === 'force' || query['refresh'] === 'cached' ? query['refresh'] : 'auto';
    const repoRoot = findGitRoot(realPathOfNearestExisting(target));
    if (repoRoot === null) throw new HttpError(400, `${target} is not inside a Git repository`);
    const profile = await profiles.get(repoRoot, mode);
    if (profile === null) throw new HttpError(404, `No profile for ${repoRoot} yet`);
    return profile;
  });

  /** Rescans a repository now (read-only; the dashboard's Refresh). */
  app.post('/api/v1/repositories/scan', { config: TOKEN_OR_SESSION }, async (request) => {
    const body = parse(repositoryScanRequestSchema, request.body);
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    return profiles.get(repoRoot, 'force');
  });

  /** Repositories JERRY knows, with their cached profiles (no scan). */
  app.get('/api/v1/repositories', { config: TOKEN_OR_SESSION }, async () => {
    const snapshot = store.snapshot();
    const known = await store.knownRepositories();
    const summaries: RepositorySummary[] = [];
    for (const repoRoot of known) {
      summaries.push({
        repoRoot,
        excluded: isRepoExcluded(snapshot, repoRoot, process.platform),
        openTasks: snapshot.tasks.filter((task) => sameRepo(task.repoRoot, repoRoot) && !isTerminal(task.state)).length,
        profile: await profiles.get(repoRoot, 'cached'),
      });
    }
    return summaries;
  });

  /** Links between known repositories from their cached profiles. */
  app.get('/api/v1/workspace/graph', { config: TOKEN_OR_SESSION }, async () => profiles.graph(await store.knownRepositories()));

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
    const detail: TaskDetail = {
      ...summary!,
      ...(await store.taskHistory(taskId)),
      reports: await store.reportsOf(taskId),
      baseline: await store.taskBaseline(taskId),
    };
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
    if ((body.document?.analysis?.reports.length ?? 0) > 0) throw new HttpError(400, 'a new task has no analysis reports to cite; start it with an intake (jerry_start_task) first');
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    const sessionId = await store.resolveOrigin(body.origin);
    return reply
      .code(201)
      .send(await store.createTask({ repoRoot, title: body.title, scope: body.scope, ...(body.document === undefined ? {} : { document: body.document }), submittedBy: body.submittedBy, sessionId }, new Date()));
  });

  /** Task intake before a plan: DISCOVERY with the area to analyse; nothing is approved. */
  app.post('/api/v1/tasks/intake', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(taskIntakeRequestSchema, request.body);
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    const sessionId = await store.resolveOrigin(body.origin);
    return reply.code(201).send(await store.startTask({ repoRoot, title: body.title, goal: body.goal, focus: body.focus, submittedBy: body.submittedBy, sessionId }, new Date()));
  });

  app.post('/api/v1/tasks/:taskId/plan', { config: TOKEN_ONLY }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(planReviseRequestSchema, request.body);
    // A plan may cite only this task's analysis reports.
    const cited = body.document?.analysis?.reports ?? [];
    if (cited.length > 0) {
      const known = new Set((await store.analysesOf(taskId)).map((record) => record.id));
      const unknown = cited.filter((id) => !known.has(id));
      if (unknown.length > 0) throw new HttpError(400, `the plan cites analysis report(s) ${unknown.join(', ')} that ${taskId} does not have`);
    }
    return store.revisePlan(taskId, body.scope, new Date(), body.document, body.submittedBy, await store.resolveOrigin(body.origin));
  });

  /** An analyst's evidence-backed report (through MCP); Core checks its citations. */
  app.post('/api/v1/tasks/:taskId/analyses', { config: TOKEN_ONLY }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(analysisReportRequestSchema, request.body);
    const task = store.snapshot().tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) throw new HttpError(404, `Unknown task ${taskId}`);
    const [sessionId, agentId] = await Promise.all([store.resolveOrigin(body.origin), store.resolveAgent(body.origin)]);
    return reply.code(201).send(await store.saveAnalysisReport(taskId, body.report, checkCitations(task.repoRoot, body.report), sessionId, agentId, new Date()));
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

  /** Quality findings, newest first: by task, repository, status or file. */
  app.get('/api/v1/findings', { config: TOKEN_OR_SESSION }, async (request) => {
    const query = parse(findingsQuerySchema, request.query);
    const repoRoot = query.repoPath === undefined ? undefined : (findGitRoot(realPathOfNearestExisting(query.repoPath)) ?? undefined);
    return store.findings({
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(repoRoot === undefined ? {} : { repoRoot }),
      ...(query.status === undefined ? {} : { statuses: query.status.split(',').map((status) => findingStatusSchema.parse(status.trim().toUpperCase())) }),
      ...(query.file === undefined ? {} : { file: query.file }),
      limit: query.limit,
    });
  });

  app.get('/api/v1/findings/:findingId', { config: TOKEN_OR_SESSION }, async (request) => {
    const findingId = parse(findingIdSchema, (request.params as { findingId: string }).findingId.toUpperCase());
    const [finding] = await store.findings({ findingId });
    if (finding === undefined) throw new HttpError(404, `Unknown finding ${findingId}`);
    return { ...finding, history: await store.findingHistory(findingId) };
  });

  /** The user's decision on a finding, with a reason; the CLI asks in a terminal, the dashboard in a dialog. */
  app.post('/api/v1/findings/:findingId/status', { config: TOKEN_OR_SESSION }, async (request) => {
    const findingId = parse(findingIdSchema, (request.params as { findingId: string }).findingId.toUpperCase());
    const body = parse(findingStatusRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    return store.setFindingStatus(findingId, body.status, body.reason, new Date(), fromDashboard ? 'dashboard' : 'cli');
  });

  /** Up to three implementers with disjoint files; Claude's orchestrator records them through MCP. */
  app.post('/api/v1/tasks/:taskId/assignments', { config: TOKEN_ONLY }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId.toUpperCase());
    const body = parse(assignmentRequestSchema, request.body);
    return reply.code(201).send(await store.assignWork(taskId, body.assignments, await store.resolveOrigin(body.origin), new Date()));
  });

  // --- Final report and the optional Artifact ----------------------------------------------------

  /** The final report, assembled from stored facts; a draft until the task is DONE. */
  app.get('/api/v1/tasks/:taskId/final-report', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId.toUpperCase());
    const task = store.snapshot().tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) throw new HttpError(404, `Unknown task ${taskId}`);
    return buildFinalReport(store, task);
  });

  /** The user's choice about an Artifact, recorded by the skill through MCP. */
  app.post('/api/v1/tasks/:taskId/artifact', { config: TOKEN_ONLY }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId.toUpperCase());
    const body = parse(artifactDecisionRequestSchema, request.body);
    const { origin, ...decision } = body;
    return reply.code(201).send(await store.recordArtifactDecision(taskId, decision, await store.resolveOrigin(origin), new Date()));
  });

  app.get('/api/v1/artifacts', { config: TOKEN_OR_SESSION }, async () => store.artifactDecisions());

  // --- Evals -------------------------------------------------------------------------------------
  const evals = new EvalStore(store.kysely);
  // The plugin this Core ships with (dist/plugin next to dist/core): what the evals measure.
  const ownFingerprint = (): JerryFingerprint | null => {
    const pluginDir = options.dashboardDir === undefined ? null : path.resolve(options.dashboardDir, '..', '..', 'plugin');
    return pluginDir !== null && fs.existsSync(pluginDir) ? jerryFingerprint(pluginDir) : null;
  };

  /** A finished eval run, recorded by the CLI runner. */
  app.post('/api/v1/evals/runs', { config: TOKEN_ONLY }, async (request, reply) => reply.code(201).send(await evals.recordRun(parse(evalRunSubmissionSchema, request.body), new Date())));
  app.get('/api/v1/evals/runs', { config: TOKEN_OR_SESSION }, async () => evals.runs());
  app.get('/api/v1/evals/runs/:runId', { config: TOKEN_OR_SESSION }, async (request) => evals.run((request.params as { runId: string }).runId));
  app.get('/api/v1/evals/status', { config: TOKEN_OR_SESSION }, async () => evals.status(ownFingerprint()));
  app.get('/api/v1/evals/calibration', { config: TOKEN_OR_SESSION }, async () => evals.calibration());

  /** The user's baseline choice: the dashboard also needs the run ID typed. */
  app.post('/api/v1/evals/baseline', { config: TOKEN_OR_SESSION }, async (request) => {
    const body = parse(evalBaselineRequestSchema, request.body);
    if (request.client?.kind === 'session' && body.confirm?.trim().toUpperCase() !== body.runId.toUpperCase()) throw new HttpError(400, `Type ${body.runId} to confirm the new baseline`);
    return evals.setBaseline(body.runId, body.note, new Date());
  });

  /** A human label of a rubric result, for calibration. */
  app.post('/api/v1/evals/labels', { config: TOKEN_OR_SESSION }, async (request, reply) => {
    await evals.label(parse(evalLabelRequestSchema, request.body), new Date());
    return reply.code(201).send(await evals.calibration());
  });

  // --- Independent review -----------------------------------------------------------------------
  const taskParam = (request: { params: unknown }): string => parse(taskIdSchema, (request.params as { taskId: string }).taskId.toUpperCase());

  /** A reviewer's submission (through MCP); tied to its subagent run through the hook's record. */
  app.post('/api/v1/tasks/:taskId/reviews', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(reviewSubmissionRequestSchema, request.body);
    const [sessionId, agentId] = await Promise.all([store.resolveOrigin(body.origin), store.resolveAgent(body.origin)]);
    return reply.code(201).send(await store.submitReview(taskParam(request), body.review, sessionId, agentId, new Date()));
  });

  /** Claude closes a round although a reviewer did not report (the gap stays visible). */
  app.post('/api/v1/tasks/:taskId/reviews/finish', { config: TOKEN_ONLY }, async (request) => store.finishReview(taskParam(request), new Date()));

  app.get('/api/v1/tasks/:taskId/review', { config: TOKEN_OR_SESSION }, async (request) => store.reviewState(taskParam(request)));

  /** Claude's remediation plan; the user decides on it like on a plan (stage REVIEW_FIX). */
  app.post('/api/v1/tasks/:taskId/fix-plan', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(fixPlanRequestSchema, request.body);
    return reply.code(201).send(await store.proposeFixes(taskParam(request), body.plan, await store.resolveOrigin(body.origin), new Date()));
  });

  /** The approved fixes are done; the same reviewers check again. */
  app.post('/api/v1/tasks/:taskId/fixes', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(fixesReportRequestSchema, request.body);
    return reply.code(201).send(await store.reportFixes(taskParam(request), body.summary, await store.resolveOrigin(body.origin), new Date()));
  });

  /** The user waives the review with a reason; the dashboard also needs the typed task ID. */
  app.post('/api/v1/tasks/:taskId/review/skip', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = taskParam(request);
    const body = parse(reviewSkipRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    if (fromDashboard && body.confirmTaskId?.trim().toUpperCase() !== taskId) throw new HttpError(400, `Type ${taskId} to confirm waiving the review`);
    return store.skipReview(taskId, body.reason, new Date(), fromDashboard ? 'dashboard' : 'cli');
  });

  /** The task's current implementer assignments; cheap, no Git. */
  app.get('/api/v1/tasks/:taskId/assignments', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId.toUpperCase());
    if (!store.snapshot().tasks.some((candidate) => candidate.taskId === taskId)) throw new HttpError(404, `Unknown task ${taskId}`);
    return store.assignmentsOf(taskId);
  });

  /** Where the work strays from the plan, the step layers and the assignments. */
  app.get('/api/v1/tasks/:taskId/drift', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId.toUpperCase());
    const task = store.snapshot().tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) throw new HttpError(404, `Unknown task ${taskId}`);
    return store.planDrift(task);
  });

  /** The tests that belong to the task's changes, and the command limited to them. */
  app.get('/api/v1/tasks/:taskId/targeted-tests', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId.toUpperCase());
    const task = store.snapshot().tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) throw new HttpError(404, `Unknown task ${taskId}`);
    return targetedTestsFor(store, task);
  });

  /** Every plan version, oldest first; the dashboard and CLI diff them. */
  app.get('/api/v1/tasks/:taskId/plans', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    return store.planVersions(taskId);
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

/**
 * Findings Claude has not heard about yet, for the tasks in implementation this session works on.
 * Compact on purpose: it goes into Claude's context with a tool call.
 */
async function qualityFeedback(store: StateStore, sessionId: string, now: Date): Promise<string | null> {
  const working = new Set(store.snapshot().tasks.filter((task) => WORK_STATES.has(task.state)).map((task) => task.taskId));
  const tasks = (await store.tasksOfSession(sessionId)).filter((taskId) => working.has(taskId));
  const lines: string[] = [];
  for (const taskId of tasks) {
    for (const finding of await store.takeFeedback(taskId, now)) {
      lines.push(`- ${SEVERITY_EMOJI[finding.severity]} ${finding.findingId} ${finding.severity} ${finding.file}:${finding.lineStart} ${finding.title}: ${finding.evidence} → ${finding.suggestedFix}`);
    }
  }
  if (lines.length === 0) return null;
  return [decorate(EMOJI.finding, `JERRY quality: ${lines.length} new finding(s) in your changes (only changed lines are checked):`), ...lines, 'Fix them within the approved scope, or tell the user why not; jerry_list_findings lists all open ones. The user dismisses findings, not you.'].join('\n');
}

async function summarize(store: StateStore, tasks: readonly Task[]): Promise<TaskSummary[]> {
  const [activity, reports, checks, findingCounts, testRuns] = await Promise.all([store.taskActivity(), store.latestReports(), store.latestCompletionChecks(), store.findingCounts(), store.latestTestRuns()]);
  const summaries: TaskSummary[] = [];
  for (const task of tasks) {
    const report = reports.get(task.taskId) ?? null;
    // Analyses matter while a task is open; finished tasks keep them in their details only.
    const open = !isTerminal(task.state);
    const analyses = open ? await store.analysesOf(task.taskId) : [];
    const agentRuns = open ? await store.agentRunsOf(task.taskId) : [];
    summaries.push({
      ...task,
      planDecision: store.planDecision(task.taskId),
      finalCheck: checks.get(task.taskId) ?? null,
      ...(activity.get(task.taskId) ?? NO_ACTIVITY),
      lastReport: report,
      reportDecision: report === null ? null : store.reportDecision(report),
      analyses,
      agentRuns,
      // Informational: it never blocks an approval.
      planGrade: open ? gradePlan({ planVersion: task.plan.version, document: task.plan.document, analyses, agentRuns, caseInsensitive: process.platform === 'win32' }) : null,
      findings: findingCounts.get(task.taskId) ?? null,
      lastTestRun: testRuns.get(task.taskId) ?? null,
    });
  }
  return summaries;
}

/** At most this many open tasks go into a session's start context. */
const MAX_OPEN_TASKS = 10;

/**
 * What a starting session should know to resume work: the repository's open tasks,
 * the ones this session already worked on first (same ID after resume or compaction), then the
 * most recently active.
 */
async function openTasksFor(store: StateStore, snapshot: CoreState, repoRoot: string, sessionId: string, covering: ReadonlySet<string>): Promise<OpenTask[]> {
  const tasks = snapshot.tasks.filter((task) => sameRepo(task.repoRoot, repoRoot) && !isTerminal(task.state));
  if (tasks.length === 0) return [];
  const activity = await store.taskActivity();
  const mine = new Set(await store.tasksOfSession(sessionId));
  const recency = (task: Task): string => activity.get(task.taskId)?.activity.lastActivityAt ?? task.createdAt;
  const ordered = tasks.sort((a, b) => Number(mine.has(b.taskId)) - Number(mine.has(a.taskId)) || recency(b).localeCompare(recency(a))).slice(0, MAX_OPEN_TASKS);
  // Git is read only for the tasks shown in the start context, within a small time budget.
  const since = await Promise.all(ordered.map((task, index) => (index < OPEN_TASKS_SHOWN && activity.get(task.taskId)?.lastCheckpoint != null ? store.changesSinceCheckpoint(task) : Promise.resolve(null))));
  return ordered.map((task, index) => {
    const checkpoint = activity.get(task.taskId)?.lastCheckpoint ?? null;
    const sinceCheckpoint = since[index] ?? null;
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
      ...(sinceCheckpoint === null ? {} : { sinceCheckpoint }),
    };
  });
}

/** Open tasks the bridge shows in full at session start (apps/hook-bridge OPEN_TASKS_IN_CONTEXT). */
const OPEN_TASKS_SHOWN = 3;

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
