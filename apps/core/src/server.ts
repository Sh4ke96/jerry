import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import {
  approvalRequestSchema,
  gateCheckRequestSchema,
  JERRY_VERSION,
  planReviseRequestSchema,
  repositoryExclusionRequestSchema,
  sessionRegistrationSchema,
  taskCreateRequestSchema,
  taskIdSchema,
  type CoreStatus,
  type GateDecision,
  type SessionRegistrationResponse,
} from '@jerry/contracts';
import { appendJsonLine } from '@jerry/platform';
import { approvedPlansForRepo, classifyToolCall, evaluateGate, isRepoExcluded } from '@jerry/policy-engine';
import type { z } from 'zod';
import { findGitRoot, realPathOfNearestExisting } from './repo-fs.js';
import { StateError, type StateStore } from './state-store.js';

const MAX_BODY_BYTES = 1024 * 1024;

export interface CoreServerOptions {
  token: string;
  store: StateStore;
  jerryHome: string;
  gateLogFile: string;
  protectedRoots: readonly string[];
  startedAt: Date;
  onShutdownRequested: () => void;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function createCoreServer(options: CoreServerOptions): http.Server {
  const tokenBuffer = Buffer.from(options.token, 'utf8');
  const server = http.createServer((request, response) => {
    handle(request, options, tokenBuffer, server)
      .then((result) => send(response, result.status, result.body))
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          send(response, error.statusCode, { error: error.message, details: error.details });
        } else if (error instanceof StateError) {
          send(response, error.statusCode, { error: error.message });
        } else {
          send(response, 500, { error: error instanceof Error ? error.message : 'internal error' });
        }
      });
  });
  return server;
}

async function handle(
  request: http.IncomingMessage,
  options: CoreServerOptions,
  tokenBuffer: Buffer,
  server: http.Server,
): Promise<{ status: number; body: unknown }> {
  assertLoopbackRequest(request, server);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    return { status: 200, body: { status: 'ok' } };
  }

  assertAuthorized(request, tokenBuffer);
  const now = new Date();
  const { store } = options;

  if (method === 'GET' && url.pathname === '/api/v1/status') {
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
    return { status: 200, body: status };
  }

  if (method === 'POST' && url.pathname === '/api/v1/gate/check') {
    const gateRequest = parse(gateCheckRequestSchema, await readJson(request));
    const snapshot = store.snapshot();
    const decision = evaluateGate(gateRequest, {
      platform: process.platform,
      protectedRoots: options.protectedRoots,
      realPath: realPathOfNearestExisting,
      findRepoRoot: findGitRoot,
      approvedPlans: (repoRoot) => approvedPlansForRepo(snapshot, repoRoot, process.platform),
      isExcluded: (repoRoot) => isRepoExcluded(snapshot, repoRoot, process.platform),
    });
    logGateDecision(options.gateLogFile, now, gateRequest, decision);
    return { status: 200, body: decision };
  }

  if (method === 'POST' && url.pathname === '/api/v1/sessions') {
    const registration = parse(sessionRegistrationSchema, await readJson(request));
    await store.registerSession(registration, now);
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
    return { status: 200, body: response };
  }

  if (method === 'GET' && url.pathname === '/api/v1/repositories/exclusions') {
    return { status: 200, body: store.snapshot().excludedRepos };
  }

  if (method === 'POST' && url.pathname === '/api/v1/repositories/exclusions') {
    const body = parse(repositoryExclusionRequestSchema, await readJson(request));
    const repoRoot = findGitRoot(realPathOfNearestExisting(body.repoPath));
    if (repoRoot === null) {
      throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    }
    await store.setExcluded(repoRoot, body.excluded, now);
    return { status: 200, body: { repoRoot, excluded: body.excluded } };
  }

  if (method === 'GET' && url.pathname === '/api/v1/tasks') {
    const snapshot = store.snapshot();
    return {
      status: 200,
      body: snapshot.tasks.map((task) => ({ ...task, planDecision: store.planDecision(task.taskId) })),
    };
  }

  if (method === 'POST' && url.pathname === '/api/v1/tasks') {
    const body = parse(taskCreateRequestSchema, await readJson(request));
    const realRepoPath = realPathOfNearestExisting(body.repoPath);
    const repoRoot = findGitRoot(realRepoPath);
    if (repoRoot === null) {
      throw new HttpError(400, `${body.repoPath} is not inside a Git repository`);
    }
    return { status: 201, body: await store.createTask({ repoRoot, title: body.title, scope: body.scope }, now) };
  }

  const taskRoute = /^\/api\/v1\/tasks\/([^/]+)\/(plan|approvals)$/.exec(url.pathname);
  if (method === 'POST' && taskRoute !== null) {
    const taskId = parse(taskIdSchema, decodeURIComponent(taskRoute[1]!));
    if (taskRoute[2] === 'plan') {
      const body = parse(planReviseRequestSchema, await readJson(request));
      return { status: 200, body: await store.revisePlan(taskId, body.scope, now) };
    }
    const body = parse(approvalRequestSchema, await readJson(request));
    return { status: 201, body: await store.recordApproval(taskId, body, now) };
  }

  if (method === 'POST' && url.pathname === '/api/v1/database/backups') {
    return { status: 201, body: { file: await store.backup('manual') } };
  }

  if (method === 'POST' && url.pathname === '/api/v1/shutdown') {
    setImmediate(options.onShutdownRequested);
    return { status: 202, body: { stopping: true } };
  }

  throw new HttpError(404, `No route for ${method} ${url.pathname}`);
}

/** Blocks DNS-rebinding and browser-originated requests; there is no dashboard in M0. */
function assertLoopbackRequest(request: http.IncomingMessage, server: http.Server): void {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : -1;
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw new HttpError(421, 'Unexpected Host header');
  }
  if (request.headers.origin !== undefined) {
    throw new HttpError(403, 'Browser-originated requests are not accepted');
  }
}

function assertAuthorized(request: http.IncomingMessage, tokenBuffer: Buffer): void {
  const header = request.headers.authorization ?? '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '', 'utf8');
  if (presented.length !== tokenBuffer.length || !timingSafeEqual(presented, tokenBuffer)) {
    throw new HttpError(401, 'Missing or invalid JERRY token');
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'Request validation failed', result.error.issues);
  }
  return result.data;
}

function readJson(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/**
 * Audit trail of every gate decision. Data minimization: file paths are logged, but
 * never file contents, and shell commands only by their first word and length.
 */
function logGateDecision(
  logFile: string,
  now: Date,
  request: z.infer<typeof gateCheckRequestSchema>,
  decision: GateDecision,
): void {
  const action = classifyToolCall(request.toolName, request.toolInput);
  const target =
    action.kind === 'file-write'
      ? { paths: action.paths }
      : action.kind === 'shell' || action.kind === 'shell-opaque'
        ? { commandHead: action.command.trim().split(/\s+/)[0] ?? '', commandLength: action.command.length }
        : {};
  appendJsonLine(logFile, {
    at: now.toISOString(),
    sessionId: request.sessionId,
    agentId: request.agentId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    cwd: request.cwd,
    ...target,
    ...decision,
  });
}
