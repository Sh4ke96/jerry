import {
  coreStatusSchema,
  gatePreviewResponseSchema,
  repositoryStateSchema,
  storedEventSchema,
  type RepositoryState,
  type TaskWithDecision,
} from '@jerry/contracts';
import { autostartCore, CoreUnavailableError, readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './protocol.js';

/**
 * Read-only JERRY tools for Claude (spec §4.2 E). There is deliberately no tool that approves,
 * rejects, excludes or completes anything: those are user actions in the CLI or dashboard.
 */

const DEFAULT_DEVIATION_WINDOW_MINUTES = 480;

function projectDir(): string {
  return process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
}

async function core(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  return requestCore(info, { method, path, timeoutMs: 3000, ...(body === undefined ? {} : { body }) });
}

function ok(result: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

/** Core down: say so plainly (and start it if installed) instead of guessing the state. */
function unavailable(error: unknown): ToolResult {
  let started = 'unavailable';
  try {
    started = autostartCore(resolveJerryHome());
  } catch {
    // nothing more to do
  }
  const cause = error instanceof Error ? error.message : String(error);
  const hint = started === 'unavailable' ? 'Ask the user to run "jerry core start".' : 'JERRY is starting Core; try again in a few seconds.';
  return { content: [{ type: 'text', text: `JERRY Core is not reachable (${cause}). The plan state is unknown. ${hint} Hard rules (no Git changes) still apply.` }], isError: true };
}

async function withCore(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CoreUnavailableError) return unavailable(error);
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `JERRY could not answer: ${message}` }], isError: true };
  }
}

async function repositoryState(path: unknown): Promise<RepositoryState> {
  const target = typeof path === 'string' && path !== '' ? path : projectDir();
  return repositoryStateSchema.parse(await core('GET', `/api/v1/repositories/state?path=${encodeURIComponent(target)}`));
}

function taskStatus(task: TaskWithDecision): 'APPROVED' | 'REJECTED' | 'WAITING_FOR_APPROVAL' {
  return task.planDecision?.decision ?? 'WAITING_FOR_APPROVAL';
}

function summarizeTask(task: TaskWithDecision): Record<string, unknown> {
  return { taskId: task.taskId, title: task.title, planVersion: task.plan.version, scope: task.plan.scope, status: taskStatus(task) };
}

const pathArgument = {
  type: 'object',
  properties: { path: { type: 'string', description: 'A file or directory inside the repository. Defaults to the project directory of this session.' } },
  additionalProperties: false,
} as const;

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'jerry_get_status',
    title: 'JERRY status',
    description: 'Whether JERRY Core is running and how it treats the current project (monitored, excluded, approved plans).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () =>
      withCore(async () => {
        const status = coreStatusSchema.parse(await core('GET', '/api/v1/status'));
        const state = await repositoryState(undefined);
        return ok({
          guard: 'GUARDED',
          jerryVersion: status.version,
          project: projectDir(),
          repository: state.repoRoot,
          monitored: state.repoRoot !== null && !state.excluded,
          approvedPlans: state.tasks.filter((task) => taskStatus(task) === 'APPROVED').length,
          hardRules: 'No Git command or Git-server MCP tool that changes anything; no writes inside .git; no changes to JERRY data or the settings that enable it.',
        });
      }),
  },
  {
    name: 'jerry_get_approval_status',
    title: 'Plan approval status',
    description: 'Current, live approval state of JERRY plans for a repository: approved plans with their scope, and plans waiting for the user. Approvals can change during a session, so check this instead of relying on the session start message.',
    inputSchema: pathArgument,
    handler: (args) =>
      withCore(async () => {
        const state = await repositoryState(args['path']);
        return ok({
          repository: state.repoRoot,
          excludedFromMonitoring: state.excluded,
          approved: state.tasks.filter((task) => taskStatus(task) === 'APPROVED').map(summarizeTask),
          notApproved: state.tasks.filter((task) => taskStatus(task) !== 'APPROVED').map(summarizeTask),
        });
      }),
  },
  {
    name: 'jerry_get_current_task',
    title: 'Current JERRY task',
    description: 'The most recently created JERRY task for a repository, with its current plan version, scope and approval status.',
    inputSchema: pathArgument,
    handler: (args) =>
      withCore(async () => {
        const state = await repositoryState(args['path']);
        const latest = [...state.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return ok({ repository: state.repoRoot, task: latest === undefined ? null : { ...summarizeTask(latest), contentHash: latest.plan.contentHash, createdAt: latest.createdAt } });
      }),
  },
  {
    name: 'jerry_get_next_required_action',
    title: 'Next required action',
    description: 'What JERRY expects next in this repository, based on the live plan state.',
    inputSchema: pathArgument,
    handler: (args) =>
      withCore(async () => {
        const state = await repositoryState(args['path']);
        return ok({ repository: state.repoRoot, ...nextAction(state) });
      }),
  },
  {
    name: 'jerry_check_paths',
    title: 'Check paths against the plan',
    description: 'Before editing, ask JERRY how edits to these paths would be treated: inside the approved scope (PASS), a recorded deviation (WARN), or blocked by a hard rule (DENY). Nothing is recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: 'File paths, absolute or relative to cwd.' },
        cwd: { type: 'string', description: 'Directory for relative paths. Defaults to the project directory.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    handler: (args) =>
      withCore(async () => {
        const paths = z.array(z.string().min(1)).min(1).max(50).safeParse(args['paths']);
        if (!paths.success) return { content: [{ type: 'text', text: 'paths must be a list of 1 to 50 file paths' }], isError: true };
        const cwd = typeof args['cwd'] === 'string' && args['cwd'] !== '' ? args['cwd'] : projectDir();
        const preview = gatePreviewResponseSchema.parse(await core('POST', '/api/v1/gate/preview', { cwd, paths: paths.data }));
        return ok({ decisions: preview.decisions.map((decision) => ({ path: decision.path, verdict: decision.verdict, rule: decision.ruleId, reason: decision.reason, taskId: decision.taskId })) });
      }),
  },
  {
    name: 'jerry_list_deviations',
    title: 'Recorded deviations',
    description: 'Edits and commands JERRY recorded as deviations from the approved plan (WARN) or blocked (DENY) in a repository, newest first. Use it before summarizing work so the user hears about every deviation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathArgument.properties.path,
        sinceMinutes: { type: 'integer', minimum: 1, maximum: 10080, description: `Look back this many minutes (default ${DEFAULT_DEVIATION_WINDOW_MINUTES}).` },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum number of entries (default 50).' },
      },
      additionalProperties: false,
    },
    handler: (args) =>
      withCore(async () => {
        const minutes = Math.min(Math.max(Number(args['sinceMinutes'] ?? DEFAULT_DEVIATION_WINDOW_MINUTES) || DEFAULT_DEVIATION_WINDOW_MINUTES, 1), 10080);
        const limit = Math.min(Math.max(Number(args['limit'] ?? 50) || 50, 1), 200);
        const since = new Date(Date.now() - minutes * 60_000).toISOString();
        const repoPath = typeof args['path'] === 'string' && args['path'] !== '' ? args['path'] : projectDir();
        const params = new URLSearchParams({ verdict: 'WARN,DENY', repoPath, since, limit: String(limit) });
        const events = z.array(storedEventSchema).parse(await core('GET', `/api/v1/events?${params.toString()}`));
        return ok({
          since,
          deviations: events.map((event) => {
            const input = (event.payload['input'] ?? {}) as Record<string, unknown>;
            return {
              at: event.timestamp,
              tool: event.toolName,
              verdict: event.verdict,
              rule: event.ruleId,
              target: input['path'] ?? input['command'] ?? null,
              reason: event.payload['reason'] ?? null,
              evaluatedLate: event.payload['evaluatedLate'] === true,
            };
          }),
        });
      }),
  },
];

export function nextAction(state: RepositoryState): { action: string; details: string } {
  if (state.repoRoot === null) {
    return { action: 'none', details: 'Not inside a Git repository: JERRY does not monitor edits here. Hard rules (no Git changes) still apply.' };
  }
  if (state.excluded) {
    return { action: 'none', details: 'The user excluded this repository from JERRY monitoring. Hard rules (no Git changes) still apply.' };
  }
  const approved = state.tasks.filter((task) => taskStatus(task) === 'APPROVED');
  if (approved.length > 0) {
    const plans = approved.map((task) => `${task.taskId} v${task.plan.version} (${task.plan.scope.join(', ')})`).join('; ');
    return { action: 'work-within-approved-scope', details: `Work within the approved scope of ${plans}. Edits outside it are recorded as deviations. Leave all Git operations to the user.` };
  }
  const waiting = state.tasks.filter((task) => taskStatus(task) === 'WAITING_FOR_APPROVAL');
  if (waiting.length > 0) {
    const plans = waiting.map((task) => `${task.taskId} v${task.plan.version}`).join(', ');
    return { action: 'wait-for-approval', details: `Plan ${plans} is waiting for the user's approval (jerry approve or the dashboard). Do not treat it as approved; edits now are recorded as deviations.` };
  }
  if (state.tasks.length > 0) {
    return { action: 'revise-plan', details: 'The latest plan was rejected. Revise it with the user before changing code; edits now are recorded as deviations.' };
  }
  return { action: 'propose-plan', details: 'No JERRY plan exists for this repository. For code changes, describe a plan and ask the user to create and approve it in JERRY; edits without one are recorded as deviations.' };
}
