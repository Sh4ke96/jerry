import {
  coreStatusSchema,
  gatePreviewResponseSchema,
  planDocumentSchema,
  repositoryStateSchema,
  storedEventSchema,
  taskSchema,
  type RepositoryState,
  type Task,
  type TaskWithDecision,
} from '@jerry/contracts';
import { autostartCore, CoreUnavailableError, readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from './protocol.js';

/**
 * JERRY tools for Claude (spec §4.2 E). They read state, preview gate decisions and submit plans.
 * There is deliberately no tool that approves, rejects, excludes or completes anything: those are
 * user actions in the CLI or dashboard. Submitting a plan only ever creates a version waiting for
 * the user.
 */

const DEFAULT_DEVIATION_WINDOW_MINUTES = 480;

/** The plan document's JSON Schema, generated from the Zod schema Core validates with. */
const PLAN_JSON_SCHEMA = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(planDocumentSchema, { io: 'input' }) as Record<string, unknown>;
  return { ...schema, description: 'The plan (spec §7.2). scope.include lists the repo-relative globs JERRY checks edits against.' };
})();

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
  properties: { path: { type: 'string', description: 'Path inside the repository (default: project directory).' } },
  additionalProperties: false,
} as const;

/**
 * Three tools instead of one per question: every tool definition stays in the context of every
 * session, so the state questions (status, approvals, current task, next action) share one tool.
 */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'jerry_get_state',
    title: 'JERRY state',
    description: 'Live JERRY state for a repository: approved and pending plans with scope, current task, and the next expected action.',
    inputSchema: pathArgument,
    readOnly: true,
    handler: (args) =>
      withCore(async () => {
        const status = coreStatusSchema.parse(await core('GET', '/api/v1/status'));
        const state = await repositoryState(args['path']);
        const latest = [...state.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return ok({
          guard: 'GUARDED',
          jerryVersion: status.version,
          repository: state.repoRoot,
          monitored: state.repoRoot !== null && !state.excluded,
          approved: state.tasks.filter((task) => taskStatus(task) === 'APPROVED').map(summarizeTask),
          notApproved: state.tasks.filter((task) => taskStatus(task) !== 'APPROVED').map(summarizeTask),
          currentTask: latest === undefined ? null : { ...summarizeTask(latest), contentHash: latest.plan.contentHash, createdAt: latest.createdAt },
          next: nextAction(state),
          hardRules: 'No Git command or Git-server MCP tool that changes anything; no writes inside .git; no changes to JERRY data or the settings that enable it; no user-only jerry commands.',
        });
      }),
  },
  {
    name: 'jerry_check_paths',
    title: 'Check paths against the plan',
    description: 'How edits to these paths would be treated: PASS (in scope), WARN (deviation) or DENY (hard rule). Not recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
        cwd: { type: 'string', description: 'Base for relative paths (default: project directory).' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    readOnly: true,
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
    description: 'Recorded deviations (WARN) and blocked actions (DENY) in a repository, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathArgument.properties.path,
        sinceMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    readOnly: true,
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
  {
    name: 'jerry_submit_plan',
    title: 'Submit a plan for approval',
    description:
      "Submit a plan to JERRY for the user's approval (use the /jerry:plan skill to draft it). Without taskId it creates a task; with taskId it creates the next plan version, which voids that task's earlier approval. It never approves anything.",
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: "Revise this task's plan (only when the user asked for plan changes)." },
        title: { type: 'string', description: 'Short task title (required for a new task).' },
        repoPath: { type: 'string', description: 'Repository of a new task (default: project directory).' },
        plan: PLAN_JSON_SCHEMA,
      },
      required: ['plan'],
      additionalProperties: false,
    },
    readOnly: false,
    handler: (args) =>
      withCore(async () => {
        const plan = planDocumentSchema.safeParse(args['plan']);
        if (!plan.success) return { content: [{ type: 'text', text: `The plan is incomplete or malformed; fix it and submit again:\n${z.prettifyError(plan.error)}` }], isError: true };
        const document = plan.data;
        const taskId = typeof args['taskId'] === 'string' && args['taskId'] !== '' ? args['taskId'] : null;
        let task: Task;
        if (taskId !== null) {
          task = taskSchema.parse(await core('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/plan`, { scope: document.scope.include, document, submittedBy: 'claude' }));
        } else {
          const title = typeof args['title'] === 'string' ? args['title'].trim() : '';
          if (title === '') return { content: [{ type: 'text', text: 'A new task needs a short title.' }], isError: true };
          const repoPath = typeof args['repoPath'] === 'string' && args['repoPath'] !== '' ? args['repoPath'] : projectDir();
          task = taskSchema.parse(await core('POST', '/api/v1/tasks', { repoPath, title, scope: document.scope.include, document, submittedBy: 'claude' }));
        }
        return ok({
          taskId: task.taskId,
          planVersion: task.plan.version,
          contentHash: task.plan.contentHash,
          status: 'WAITING_FOR_APPROVAL',
          nextStep: `Tell the user that ${task.taskId} plan v${task.plan.version} waits for their decision in the JERRY dashboard (Plans) or with "jerry approve ${task.taskId} --stage plan --version ${task.plan.version}". Do not approve it yourself. Edits before approval are recorded as deviations.`,
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
