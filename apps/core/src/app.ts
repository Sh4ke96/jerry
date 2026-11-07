import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  type WorkflowState,
  approvalRequestSchema,
  decisionWaitQuerySchema,
  eventIngestRequestSchema,
  gateCheckRequestSchema,
  gatePreviewRequestSchema,
  JERRY_VERSION,
  planReviseRequestSchema,
  repositoryExclusionRequestSchema,
  forgetRequestSchema,
  projectAddRequestSchema,
  projectRemoveRequestSchema,
  pruneRequestSchema,
  projectSettingsRequestSchema,
  settingsUpdateRequestSchema,
  jerryShareRequestSchema,
  usageCollectionRequestSchema,
  usageSnapshotsRequestSchema,
  type UsageCollectionResult,
  type UsageSummary,
  type Project,
  type Settings,
  type ProjectAddResult,
  type ProjectRemoveResult,
  type ProjectSummary,
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
  finalChecksRerunRequestSchema,
  type FinalChecksRerun,
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
  type ApprovalRecord,
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
import { absolutePath, approvedPlansForRepo, comparablePath, evaluateGate, gradePlan, isComparableInside, relativeInside } from '@jerry/policy-engine';
import { isTerminal, WORK_STATES } from '@jerry/workflow';
import { buildEventEnvelope } from '@jerry/trace-engine';
import type { z } from 'zod';
import { disableUsageCollection, enableUsageCollection, jerryPaths, readTelemetryConfig, resolveClaudeConfigDir, resolveCorePort, TELEMETRY_KEY_HEADER, TELEMETRY_METRICS_PATH, usageCollectionStatus, writeTelemetryLast, type UsageCollectionChange } from '@jerry/platform';
import { BrowserSessions, clearedSessionCookie, CSRF_HEADER, loginNextFromBody, loginRedirectTarget, loginUrl, readCookie, safeEqual, SESSION_COOKIE, sessionCookie, type BrowserSession } from './auth.js';
import { evaluatePending, isMonitoredEvent, withRepoRoot } from './events.js';
import { dataUsage, forget, previewForget, previewPrune, prune, type DataContext } from './data-maintenance.js';
import { checkCitations } from './citations.js';
import { DecisionWaits } from './decision-wait.js';
import { ProfileService } from './profiles.js';
import { QualityScheduler } from './quality-scheduler.js';
import { EvalStore } from './eval-store.js';
import { buildFinalReport } from './final-report.js';
import { jerryFingerprint, type JerryFingerprint } from '@jerry/evals';
import { collectTestRun, targetedTestsFor } from './test-runs.js';
import { findGitRoot, realPathOfNearestExisting } from './repo-fs.js';
import { StateError, type StateStore } from './state-store.js';
import { loadDashboard } from './static-files.js';
import { OtlpError, parseOtlpMetrics } from './otlp.js';
import { UsageStore } from './usage-store.js';
import { registerSkillRoutes } from './skill-routes.js';
import { SkillService } from './skill-service.js';
import type { GitHubFetchOptions } from '@jerry/skills';
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
  /** Days events and sessions are kept (shown in the data usage). */
  retentionDays?: number;
  /** Claude Code's user config dir, whose settings.json the usage switch changes (default: CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeConfigDir?: string;
  /** The port Claude Code's telemetry is sent to (default: the configured port, else the one Core listens on). */
  telemetryPort?: () => number;
  /** Claude usage; Core's main passes the one its spool drain also uses. */
  usage?: UsageStore;
  /** Where skills are downloaded from GitHub; tests pass a local fake. */
  skillsGitHub?: GitHubFetchOptions;
}

export const DEFAULT_RETENTION_DAYS = 90;

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
export function gateEvaluator(store: StateStore, protectedRoots: readonly string[], skillStates?: (name: string) => readonly WorkflowState[] | null): (request: GateCheckRequest) => GateDecision {
  return (request) => {
    const snapshot: CoreState = store.snapshot();
    return evaluateGate(request, {
      ...(skillStates === undefined ? {} : { skillStates }),
      openTasks: (repoRoot) => snapshot.tasks.filter((task) => !isTerminal(task.state) && sameRepo(task.repoRoot, repoRoot)).map((task) => ({ taskId: task.taskId, state: task.state })),
      platform: process.platform,
      protectedRoots,
      realPath: realPathOfNearestExisting,
      findRepoRoot: findGitRoot,
      approvedPlans: (repoRoot) => approvedPlansForRepo(snapshot, repoRoot, process.platform),
      isMonitored: (repoRoot) => store.isMonitored(repoRoot),
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
  // The skills service is built further down; the gate reads its states through this reference.
  let skillService: SkillService | null = null;
  const evaluate = gateEvaluator(store, options.protectedRoots, (name) => skillService?.triggerStates(name) ?? null);
  const profiles = options.profiles ?? new ProfileService(store);
  // Read once: a running Core serves the dashboard of its own version, even after a new build or install.
  const dashboard = loadDashboard(options.dashboardDir);
  const quality = options.quality ?? new QualityScheduler({ store, git: store.gitReader });
  const usage = options.usage ?? new UsageStore(store, options.startedAt);
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
    // A gzip body that does not unpack (zlib errors: Z_DATA_ERROR, Z_BUF_ERROR, …).
    if (/^Z_/.test(String((error as { code?: unknown }).code))) return reply.code(400).send({ error: 'The request body is not valid gzip' });
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
    const { code, next } = request.query as { code?: unknown; next?: unknown };
    const session = typeof code === 'string' ? sessions.redeemLoginCode(code) : null;
    reply.headers(HTML_SECURITY_HEADERS).header('referrer-policy', 'no-referrer');
    if (session === null) return reply.code(401).type('text/html; charset=utf-8').send(signedOutPage('This login link is invalid, already used or expired. Run "jerry ui" again.'));
    // An optional landing route (next=#/tasks/JRY-0001); anything but a plain dashboard route lands on the root.
    return reply.header('set-cookie', sessionCookie(session)).redirect(loginRedirectTarget(next), 302);
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
  app.post('/api/v1/ui/login-codes', { config: TOKEN_ONLY }, async (request) => {
    const { code, expiresAt } = sessions.issueLoginCode();
    return { url: loginUrl(origins()[0]!, code, loginNextFromBody(request.body)), expiresAt: new Date(expiresAt).toISOString() };
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
    // Outside the projects the user added only the hard rules apply, and nothing is recorded. The
    // bridge does not ask Core there; this keeps it so for any other caller.
    if (!store.isMonitored(relevantPath(gateRequest.toolInput, gateRequest.cwd))) return decision;
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
    const feedback = decision.verdict === 'DENY' ? null : await qualityFeedback(store, gateRequest.sessionId, now);
    const answer: GateDecision = feedback === null ? decision : { ...decision, feedback };
    // JERRY's share of Claude's context: what the bridge prints for this answer.
    const injected = injectedChars(answer);
    const repoRoot = decision.repoRoot ?? store.projectOf(relevantPath(gateRequest.toolInput, gateRequest.cwd))?.repoRoot ?? null;
    if (injected > 0 && repoRoot !== null) await usage.addJerryShare({ sessionId: gateRequest.sessionId, repoRoot, kind: 'warnings', chars: injected }, now);
    return answer;
  });

  app.post('/api/v1/events', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(eventIngestRequestSchema, request.body);
    // Events from outside the projects are not stored.
    const events = body.events.filter((event) => isMonitoredEvent(store, event)).map((event) => withRepoRoot(evaluatePending(event, evaluate)));
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
    const monitored = repoRoot !== null && store.isMonitored(repoRoot);
    const state: RepositoryState = {
      repoRoot,
      excluded: repoRoot !== null && !monitored,
      monitored,
      tasks: await summarize(store, tasks),
      sessionTasks: sessionId === null ? [] : (await store.tasksOfSession(sessionId)).filter((taskId) => tasks.some((task) => task.taskId === taskId)),
      preferences: { qaLanguage: store.settings().qaLanguage, reviewMode: store.effectiveReviewModeAt(repoRoot ?? realPathOfNearestExisting(path)) },
      skills: monitored ? (skillService?.triggers() ?? []) : [],
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
    const repoRoot = findGitRoot(realPathOfNearestExisting(registration.cwd));
    // A session outside the projects is neither registered nor recorded; only hard rules apply there.
    if (!store.isMonitored(realPathOfNearestExisting(registration.cwd))) {
      const response: SessionRegistrationResponse = { registered: true, repoRoot, excluded: true, monitored: false, approvedPlans: [], openTasks: [] };
      return response;
    }
    await store.registerSession(registration, now);
    const sessionEvent = buildEventEnvelope(
      { hook_event_name: 'SessionStart', session_id: registration.sessionId, cwd: registration.cwd, source: registration.source },
      { timestamp: now },
    );
    if (sessionEvent !== null) await store.recordEvents([sessionEvent], now, false);
    const snapshot = store.snapshot();
    const approvedPlans = repoRoot === null ? [] : approvedPlansForRepo(snapshot, repoRoot, process.platform);
    const response: SessionRegistrationResponse = {
      registered: true,
      repoRoot,
      excluded: false,
      monitored: true,
      approvedPlans: approvedPlans.map((plan) => ({ taskId: plan.taskId, planVersion: plan.planVersion, scope: [...plan.scope] })),
      openTasks: repoRoot === null ? [] : await openTasksFor(store, snapshot, repoRoot, registration.sessionId, new Set(approvedPlans.map((plan) => plan.taskId))),
    };
    // Refresh the project profile in the background, so it is ready when Claude asks for it.
    if (repoRoot !== null) setImmediate(() => void profiles.get(repoRoot, 'auto').catch(() => undefined));
    return response;
  });

  /** The exclusions recorded before projects existed; monitoring follows the projects now. */
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
    for (const project of store.projects()) {
      if (!known.some((repoRoot) => sameRepo(repoRoot, project.repoRoot))) known.push(project.repoRoot);
    }
    const summaries: RepositorySummary[] = [];
    for (const repoRoot of known.sort()) {
      const project = store.isMonitored(repoRoot);
      summaries.push({
        repoRoot,
        excluded: !project,
        project,
        openTasks: snapshot.tasks.filter((task) => sameRepo(task.repoRoot, repoRoot) && !isTerminal(task.state)).length,
        profile: await profiles.get(repoRoot, 'cached'),
      });
    }
    return summaries;
  });

  /** Links between known repositories from their cached profiles. */
  app.get('/api/v1/workspace/graph', { config: TOKEN_OR_SESSION }, async () => profiles.graph(await store.knownRepositories()));

  /** The former exclusion switch: excluding removes the project, including adds it. */
  app.post('/api/v1/repositories/exclusions', { config: TOKEN_OR_SESSION }, async (request) => {
    const body = parse(repositoryExclusionRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    if (fromDashboard && body.excluded && body.confirmation !== 'exclude') {
      throw new HttpError(400, 'Excluding a repository from the dashboard needs the typed confirmation "exclude"');
    }
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    const channel = fromDashboard ? 'dashboard' : 'cli';
    if (body.excluded) {
      await store.removeProject(repoRoot, new Date(), channel);
      // Kept in the exclusion list the dashboard still shows.
      await store.setExcluded(repoRoot, true, new Date(), channel);
    } else {
      await store.addProject(checkedProjectRoot(repoRoot, options.jerryHome), new Date(), channel);
    }
    return { repoRoot, excluded: body.excluded };
  });

  // --- Projects: the repositories JERRY monitors --------------------------------------------------
  // The CLI asks in a terminal before it calls these; the dashboard's browser session must send the
  // repository root typed by the user, and the preHandler checks its CSRF token and Origin.

  const PROJECT_ROUTES = TOKEN_OR_SESSION;

  app.get('/api/v1/projects', { config: TOKEN_OR_SESSION }, async () => projectSummaries(store, store.projects()));

  /**
   * A project's own review mode (null follows the global setting). A plain setting: no typed
   * confirmation, but a browser session needs its CSRF token and Origin (preHandler).
   */
  app.post('/api/v1/projects/settings', { config: PROJECT_ROUTES }, async (request) => {
    const body = parse(projectSettingsRequestSchema, request.body);
    const target = path.resolve(body.path);
    const wanted = fs.existsSync(target) ? (findGitRoot(realPathOfNearestExisting(target)) ?? target) : target;
    const project = store.projects().find((candidate) => sameRepo(candidate.repoRoot, wanted));
    if (project === undefined) throw new HttpError(404, `${body.path} is not a JERRY project (see "jerry project list")`);
    const updated = await store.setProjectReviewMode(project.repoRoot, body.reviewMode, new Date(), request.client?.kind === 'session' ? 'dashboard' : 'cli');
    const [summary] = await projectSummaries(store, [updated]);
    return summary!;
  });

  // --- Claude usage ------------------------------------------------------------------------------
  const usageLocations = { home: options.jerryHome, claudeConfigDir: options.claudeConfigDir ?? resolveClaudeConfigDir() };
  const telemetryPort = options.telemetryPort ?? ((): number => resolveCorePort() || options.port());

  /**
   * Claude Code's OpenTelemetry metrics (OTLP/HTTP JSON). Claude Code cannot know the Core token, so
   * this route has its own credential: the telemetry key JERRY wrote into the settings env, in the
   * x-jerry-telemetry-key header. Loopback only (Host checked above), never from a browser, JSON only.
   */
  app.post(
    TELEMETRY_METRICS_PATH,
    {
      bodyLimit: MAX_BODY_BYTES,
      onRequest: async (request) => {
        if (!isLoopback(request.socket.remoteAddress)) throw new HttpError(403, 'Metrics are accepted from this machine only');
        if (request.client !== null || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined || request.headers.cookie !== undefined) {
          throw new HttpError(403, 'Metrics are not accepted from a browser or with JERRY credentials');
        }
        const presented = request.headers[TELEMETRY_KEY_HEADER];
        const expected = readTelemetryConfig(options.jerryHome)?.key ?? null;
        if (typeof presented !== 'string' || expected === null || !safeEqual(presented, expected)) throw new HttpError(401, 'Missing or invalid telemetry key');
        const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (type !== 'application/json') throw new HttpError(415, 'Only OTLP/HTTP JSON is accepted (OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json)');
      },
      // OTLP exporters may gzip the body (OTEL_EXPORTER_OTLP_COMPRESSION). The size limit applies to the unpacked JSON.
      preParsing: async (request, _reply, payload) => {
        const encoding = (request.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (encoding === 'identity') return payload;
        if (encoding !== 'gzip') throw new HttpError(415, `Unsupported Content-Encoding "${encoding}" (gzip or none)`);
        const unpacked = Object.assign(zlib.createGunzip(), { receivedEncodedLength: 0 });
        payload.on('data', (chunk: Buffer) => {
          unpacked.receivedEncodedLength += chunk.length;
        });
        payload.on('error', (error) => unpacked.destroy(error));
        return payload.pipe(unpacked);
      },
    },
    async (request) => {
      let parsed: ReturnType<typeof parseOtlpMetrics>;
      try {
        parsed = parseOtlpMetrics(request.body);
      } catch (error) {
        if (error instanceof OtlpError) throw new HttpError(400, `Not an OTLP metrics request: ${error.message}`);
        throw error;
      }
      const now = new Date();
      const recorded = await usage.recordTelemetry(parsed, now);
      // That metrics arrive, per client, is kept for "jerry usage status" (no numbers, any session),
      // with the attribute names of the request (never their values). The entrypoints are those
      // resolved per point (attribute, else the session's registered one); a request without
      // points falls back to the resources' entrypoint attributes.
      const entrypoints = recorded.entrypoints.length > 0 ? recorded.entrypoints : parsed.entrypoints;
      writeTelemetryLast(options.jerryHome, now.toISOString(), entrypoints, parsed.attributeKeys);
      return {};
    },
  );

  /** The status-line script's snapshots; limits from any session, the rest only of project sessions. */
  app.post('/api/v1/usage/snapshots', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(usageSnapshotsRequestSchema, request.body);
    const result = await usage.recordSnapshots(body.snapshots);
    return reply.code(202).send({ accepted: body.snapshots.length, ...result });
  });

  /** Characters the hook bridge or the MCP server put into Claude's context (JERRY's share). */
  app.post('/api/v1/usage/jerry-share', { config: TOKEN_ONLY }, async (request, reply) => {
    const body = parse(jerryShareRequestSchema, request.body);
    const recorded = await usage.recordJerryShare(body, await store.resolveOrigin(body.origin), new Date());
    return reply.code(202).send({ recorded });
  });

  app.get('/api/v1/usage', { config: TOKEN_OR_SESSION }, async (): Promise<UsageSummary> => usage.summary(new Date(), usageLocations, store.settings()));

  /**
   * Turns both sources on or off in the user's Claude Code settings, exactly like "jerry usage
   * enable|disable" (a backup first; only JERRY's keys). The CLI asks in a terminal; the dashboard
   * shows its own confirmation and needs its CSRF token and Origin (preHandler).
   */
  app.post('/api/v1/usage/collection', { config: TOKEN_OR_SESSION }, async (request): Promise<UsageCollectionResult> => {
    const body = parse(usageCollectionRequestSchema, request.body);
    const change = body.enabled ? enableUsageCollection({ ...usageLocations, port: telemetryPort() }) : disableUsageCollection(usageLocations);
    const problems = collectionProblems(change);
    await store.recordAudit('usage.collection', { enabled: body.enabled, channel: request.client?.kind === 'session' ? 'dashboard' : 'cli', problems }, new Date());
    const status = usageCollectionStatus(usageLocations);
    return { statusline: status.statusline, telemetry: status.telemetry, showBar: store.settings().usageShowBar, problems };
  });

  // --- Skills: Claude Code skills the user adds through JERRY (skill-routes.ts) --------------------
  const ownPluginDir = options.dashboardDir === undefined ? null : path.resolve(options.dashboardDir, '..', '..', 'plugin');
  const skills = new SkillService({
    db: store.kysely,
    home: options.jerryHome,
    claudeConfigDir: usageLocations.claudeConfigDir,
    // The installed plugin first, else the one this Core ships with.
    pluginSkillDirs: () => [path.join(jerryPaths(options.jerryHome).marketplaceDir, 'plugins', 'jerry', 'skills'), ...(ownPluginDir === null ? [] : [path.join(ownPluginDir, 'skills')])],
    ...(options.skillsGitHub === undefined ? {} : { github: options.skillsGitHub }),
  });
  skillService = skills;
  app.addHook('onReady', async () => skills.refreshTriggers());
  registerSkillRoutes(app, skills, () => store.settings().decisionConfirmation);

  // --- Settings: changed only by the user (the CLI asks in a terminal; the dashboard needs CSRF) ---
  app.get('/api/v1/settings', { config: TOKEN_OR_SESSION }, async (): Promise<Settings> => store.settings());

  app.post('/api/v1/settings', { config: TOKEN_OR_SESSION }, async (request): Promise<Settings> => {
    const body = parse(settingsUpdateRequestSchema, request.body);
    return store.updateSettings(body, new Date(), request.client?.kind === 'session' ? 'dashboard' : 'cli');
  });

  app.post('/api/v1/projects', { config: PROJECT_ROUTES }, async (request, reply) => {
    const body = parse(projectAddRequestSchema, request.body);
    const target = path.resolve(body.path);
    if (!fs.existsSync(target)) throw new HttpError(400, `${body.path} does not exist`);
    const real = realPathOfNearestExisting(target);
    const repoRoot = findGitRoot(real);
    if (repoRoot === null) throw new HttpError(400, `${body.path} is not inside a Git repository`);
    if (!sameRepo(real, repoRoot)) throw new HttpError(400, `${body.path} is inside the Git repository ${repoRoot}; add the repository root itself`);
    if (request.client?.kind === 'session' && !typedRoot(body.confirmation, repoRoot)) throw new HttpError(400, `Type the repository root (${repoRoot}) to add it`);
    const result: ProjectAddResult = await store.addProject(checkedProjectRoot(repoRoot, options.jerryHome), new Date(), request.client?.kind === 'session' ? 'dashboard' : 'cli', body.note ?? null);
    return reply.code(result.added ? 201 : 200).send(result);
  });

  app.post('/api/v1/projects/remove', { config: PROJECT_ROUTES }, async (request) => {
    const body = parse(projectRemoveRequestSchema, request.body);
    const target = path.resolve(body.path);
    // The directory may be gone already; then the path is matched as given.
    const wanted = fs.existsSync(target) ? (findGitRoot(realPathOfNearestExisting(target)) ?? target) : target;
    const project = store.projects().find((candidate) => sameRepo(candidate.repoRoot, wanted));
    if (project === undefined) throw new HttpError(404, `${body.path} is not a JERRY project (see "jerry project list")`);
    if (request.client?.kind === 'session' && !typedRoot(body.confirmation, project.repoRoot)) throw new HttpError(400, `Type the repository root (${project.repoRoot}) to remove it`);
    const key = comparablePath(project.repoRoot, project.repoRoot, process.platform);
    const openTasks = store
      .snapshot()
      .tasks.filter((task) => !isTerminal(task.state) && isComparableInside(comparablePath(task.repoRoot, task.repoRoot, process.platform), key))
      .map((task) => task.taskId);
    const removed = await store.removeProject(project.repoRoot, new Date(), request.client?.kind === 'session' ? 'dashboard' : 'cli');
    const result: ProjectRemoveResult = {
      ...removed,
      openTasks,
      warning: openTasks.length === 0 ? null : `${openTasks.join(', ')} stay open, but JERRY no longer monitors ${project.repoRoot}: edits there are not checked against their plans. Add the project again to continue them.`,
    };
    return result;
  });

  // --- Data: what JERRY stores, and deleting old data ---------------------------------------------
  // The CLI previews and asks for the typed confirmation in a terminal; the dashboard's browser
  // session must send it ("delete", or the repository root), and the preHandler checks its CSRF token
  // and Origin.

  const DATA_ROUTES = TOKEN_OR_SESSION;
  const dataContext: DataContext = { store, logsDir: path.join(options.jerryHome, 'logs'), retentionDays: options.retentionDays ?? DEFAULT_RETENTION_DAYS };

  app.get('/api/v1/data/usage', { config: TOKEN_OR_SESSION }, async () => dataUsage(dataContext, new Date()));

  app.post('/api/v1/data/prune/preview', { config: DATA_ROUTES }, async (request) => {
    const { confirmation: _ignored, ...options } = parse(pruneRequestSchema, request.body);
    return previewPrune(dataContext, options, new Date());
  });

  app.post('/api/v1/data/prune', { config: DATA_ROUTES }, async (request) => {
    const { confirmation, ...options } = parse(pruneRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    if (fromDashboard && confirmation !== 'delete') throw new HttpError(400, 'Deleting data from the dashboard needs the typed confirmation "delete"');
    return prune(dataContext, options, new Date(), fromDashboard ? 'dashboard' : 'cli');
  });

  app.post('/api/v1/data/forget/preview', { config: DATA_ROUTES }, async (request) => {
    const body = parse(forgetRequestSchema, request.body);
    return previewForget(dataContext, forgetRoot(body.path));
  });

  app.post('/api/v1/data/forget', { config: DATA_ROUTES }, async (request) => {
    const body = parse(forgetRequestSchema, request.body);
    const repoRoot = forgetRoot(body.path);
    const fromDashboard = request.client?.kind === 'session';
    if (fromDashboard && !typedRoot(body.confirmation, repoRoot)) throw new HttpError(400, `Type the repository root (${repoRoot}) to make JERRY forget it`);
    return forget(dataContext, repoRoot, new Date(), fromDashboard ? 'dashboard' : 'cli');
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
    if ((body.document?.analysis?.reports.length ?? 0) > 0) throw new HttpError(400, 'a new task has no analysis reports to cite; start it with an intake (start_task) first');
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    requireProject(store, repoRoot);
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
    requireProject(store, repoRoot);
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

  /**
   * A reversible decision from the dashboard (approve or reject a plan, accept or reject a report,
   * approve or reject a fix plan, skip review). The task ID must be typed only when the user chose
   * typed confirmations in Settings; a task ID sent anyway must match. The session, its CSRF token and
   * the Origin are checked by the preHandler in both modes; token (CLI) requests confirm in a terminal.
   * Irreversible actions (cancel, project removal, prune, forget, exclusion) check their own typed
   * confirmation and ignore this setting.
   */
  const checkDecisionConfirmation = (request: FastifyRequest, taskId: string, typed: string | undefined, message: string): void => {
    if (request.client?.kind !== 'session') return;
    const given = typed?.trim().toUpperCase() ?? '';
    const required = store.settings().decisionConfirmation === 'typed';
    if ((required || given !== '') && given !== taskId.toUpperCase()) throw new HttpError(400, message);
  };

  app.post('/api/v1/tasks/:taskId/approvals', { config: TOKEN_OR_SESSION }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const body = parse(approvalRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    checkDecisionConfirmation(request, taskId, body.confirmTaskId, `Approving from the dashboard needs the task ID typed as confirmation (${taskId})`);
    return reply.code(201).send(await store.recordApproval(taskId, body, new Date(), fromDashboard ? 'dashboard' : 'cli'));
  });

  /**
   * Claude waits here for the user's decision after a submission (MCP wait_for_decision): a long poll
   * that answers at once when the decision on that stage and version exists, else when it arrives or
   * after waitMs ('pending'). Token only and read-only: waiting never decides anything.
   */
  const decisionWaits = new DecisionWaits(store);
  // Closing Core does not wait for a long poll: open waits answer 'pending' at once.
  app.addHook('preClose', async () => decisionWaits.abortAll());
  app.get('/api/v1/tasks/:taskId/decision', { config: TOKEN_ONLY }, async (request, reply) => {
    const taskId = parse(taskIdSchema, (request.params as { taskId: string }).taskId);
    const query = parse(decisionWaitQuerySchema, request.query);
    // The client went away (Claude stopped the call): stop waiting.
    const gone = new AbortController();
    reply.raw.once('close', () => gone.abort());
    return decisionWaits.wait({ taskId, ...query, signal: gone.signal });
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
  // Skills the user added count too: Claude Code loads them in the eval sessions.
  const ownFingerprint = async (): Promise<JerryFingerprint | null> => {
    return ownPluginDir !== null && fs.existsSync(ownPluginDir) ? jerryFingerprint(ownPluginDir, await skills.fingerprints()) : null;
  };

  /** A finished eval run, recorded by the CLI runner. */
  app.post('/api/v1/evals/runs', { config: TOKEN_ONLY }, async (request, reply) => reply.code(201).send(await evals.recordRun(parse(evalRunSubmissionSchema, request.body), new Date())));
  app.get('/api/v1/evals/runs', { config: TOKEN_OR_SESSION }, async () => evals.runs());
  app.get('/api/v1/evals/runs/:runId', { config: TOKEN_OR_SESSION }, async (request) => evals.run((request.params as { runId: string }).runId));
  app.get('/api/v1/evals/status', { config: TOKEN_OR_SESSION }, async () => evals.status(await ownFingerprint()));
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

  /** The user waives the review with a reason; the dashboard needs the typed task ID only in typed mode. */
  app.post('/api/v1/tasks/:taskId/review/skip', { config: TOKEN_OR_SESSION }, async (request) => {
    const taskId = taskParam(request);
    const body = parse(reviewSkipRequestSchema, request.body);
    const fromDashboard = request.client?.kind === 'session';
    checkDecisionConfirmation(request, taskId, body.confirmTaskId, `Type ${taskId} to confirm waiving the review`);
    return store.skipReview(taskId, body.reason, new Date(), fromDashboard ? 'dashboard' : 'cli');
  });

  /**
   * The user re-runs the final checks of a task waiting in FINAL_REPORT; Core sets DONE if they pass.
   * User only: the CLI token (the terminal asked) or a dashboard session with CSRF and Origin, typed
   * task ID as Settings require. Not an MCP tool, and the hard rules block agents' direct calls.
   */
  app.post('/api/v1/tasks/:taskId/final-checks', { config: TOKEN_OR_SESSION }, async (request): Promise<FinalChecksRerun> => {
    const taskId = taskParam(request);
    const body = parse(finalChecksRerunRequestSchema, request.body ?? {});
    const fromDashboard = request.client?.kind === 'session';
    checkDecisionConfirmation(request, taskId, body.confirmTaskId, `Type ${taskId} to confirm re-running its final checks`);
    return store.rerunFinalChecks(taskId, new Date(), fromDashboard ? 'dashboard' : 'cli');
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

  /**
   * Pause, resume or cancel: user decisions, like approvals (the CLI asks in a terminal). Cancelling
   * cannot be undone, so the dashboard always needs the typed task ID for it, whatever the decision
   * confirmation setting says; pause and resume are one click.
   */
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

/**
 * Characters the hook bridge puts into Claude's context for a gate answer (apps/hook-bridge emit()):
 * a warning as systemMessage and additionalContext (with the quality feedback), or the feedback
 * alone. A block goes to Claude as the hook's error, not as context, and is not counted.
 */
export function injectedChars(decision: GateDecision): number {
  const feedback = decision.feedback;
  if (decision.verdict === 'WARN') {
    const systemMessage = decorate(EMOJI.warning, `JERRY: ${decision.reason} [${decision.ruleId}]`);
    const additionalContext = `${decorate(EMOJI.warning, `JERRY warning: ${decision.reason} [${decision.ruleId}]`)}${feedback === undefined ? '' : `\n${feedback}`}`;
    return systemMessage.length + additionalContext.length;
  }
  return decision.verdict === 'PASS' && feedback !== undefined ? feedback.length : 0;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** What could not be changed by a usage switch, in words for the dashboard and the CLI. */
export function collectionProblems(change: UsageCollectionChange): string[] {
  const problems: string[] = [];
  if (!change.statusline.ok) problems.push(`Status line: ${change.statusline.error}`);
  else if (change.statusline.result.change === 'not-jerry') problems.push("Status line: the one in Claude Code's settings is not JERRY's any more; left as it is.");
  if (!change.telemetry.ok) problems.push(`Telemetry: ${change.telemetry.error}`);
  else if (change.telemetry.result.change === 'clash') {
    problems.push(`Telemetry: you configured telemetry yourself (${change.telemetry.result.clashKeys.join(', ')}); JERRY left it as it is and does not collect tokens.`);
  } else if (change.telemetry.result.change === 'not-jerry') problems.push("Telemetry: the keys in Claude Code's settings are not JERRY's any more; left as they are.");
  return problems;
}

/** The path a tool call is about: its target file, else the working directory (resolved on disk). */
function relevantPath(toolInput: Record<string, unknown>, cwd: string): string {
  const target = toolInput['file_path'] ?? toolInput['notebook_path'];
  return realPathOfNearestExisting(typeof target === 'string' && target !== '' ? path.resolve(cwd, target) : cwd);
}

/** Work in a repository that is not a project is not recorded, so no task can be created there. */
function requireProject(store: StateStore, repoRoot: string): void {
  if (!store.isMonitored(repoRoot)) {
    throw new HttpError(409, `${repoRoot} is not added to JERRY, so JERRY does not monitor it. The user can add it with "jerry project add" (run it in that repository).`);
  }
}

/** A project root must be a Git working tree root outside JERRY's own data. */
function checkedProjectRoot(repoRoot: string, jerryHome: string): string {
  const home = comparablePath(path.resolve(jerryHome), jerryHome, process.platform);
  if (isComparableInside(comparablePath(repoRoot, repoRoot, process.platform), home)) throw new HttpError(400, `${repoRoot} is inside JERRY's data directory; it cannot be a project`);
  return repoRoot;
}

/** The repository to forget: the Git root of an existing path, or the path as given when it is gone. */
function forgetRoot(target: string): string {
  const resolved = path.resolve(target);
  return fs.existsSync(resolved) ? (findGitRoot(realPathOfNearestExisting(resolved)) ?? realPathOfNearestExisting(resolved)) : resolved;
}

/** The repository root typed as a confirmation (any case and separators on Windows). */
function typedRoot(confirmation: string | undefined, repoRoot: string): boolean {
  const typed = confirmation?.trim() ?? '';
  return typed !== '' && sameRepo(typed, repoRoot);
}

function sameRepo(a: string, b: string): boolean {
  return comparablePath(a, a, process.platform) === comparablePath(b, b, process.platform);
}

/** Projects as `jerry project list` and the dashboard show them. */
async function projectSummaries(store: StateStore, projects: readonly Project[]): Promise<ProjectSummary[]> {
  const snapshot = store.snapshot();
  const activity = await store.lastActivityByRepository();
  return projects.map((project): ProjectSummary => {
    const key = comparablePath(project.repoRoot, project.repoRoot, process.platform);
    const tasks = snapshot.tasks.filter((task) => isComparableInside(comparablePath(task.repoRoot, task.repoRoot, process.platform), key));
    return {
      ...project,
      effectiveReviewMode: store.effectiveReviewModeAt(project.repoRoot),
      tasks: tasks.length,
      openTasks: tasks.filter((task) => !isTerminal(task.state)).length,
      lastActivityAt: [...activity.entries()].filter(([root]) => isComparableInside(root, key)).map(([, at]) => at).sort().at(-1) ?? null,
      exists: fs.existsSync(project.repoRoot),
    };
  });
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
  return [decorate(EMOJI.finding, `JERRY quality: ${lines.length} new finding(s) in your changes (only changed lines are checked):`), ...lines, 'Fix them within the approved scope, or tell the user why not; list_findings lists all open ones. The user dismisses findings, not you.'].join('\n');
}

/**
 * Whether the accepted latest report went to independent review; null until it is accepted.
 * Acceptances made before review became optional carry no choice: they always went to review.
 */
function reviewRequested(decision: ApprovalRecord | null): boolean | null {
  return decision?.decision === 'APPROVED' ? (decision.review ?? true) : null;
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
    const decision = report === null ? null : store.reportDecision(report);
    summaries.push({
      ...task,
      planDecision: store.planDecision(task.taskId),
      finalCheck: checks.get(task.taskId) ?? null,
      ...(activity.get(task.taskId) ?? NO_ACTIVITY),
      lastReport: report,
      reportDecision: decision,
      analyses,
      agentRuns,
      // Informational: it never blocks an approval.
      planGrade: open ? gradePlan({ planVersion: task.plan.version, document: task.plan.document, analyses, agentRuns, caseInsensitive: process.platform === 'win32' }) : null,
      findings: findingCounts.get(task.taskId) ?? null,
      lastTestRun: testRuns.get(task.taskId) ?? null,
      reviewRequested: reviewRequested(decision),
      effectiveReviewMode: store.effectiveReviewModeAt(task.repoRoot),
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
