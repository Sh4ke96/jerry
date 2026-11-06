import path from 'node:path';
import readline from 'node:readline/promises';
import { approvalRecordSchema, taskDetailSchema, taskSchema, taskWithDecisionSchema, workflowTransitionSchema, type ApprovalRecord, type Task } from '@jerry/contracts';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { isTerminal, STATE_LABELS } from '@jerry/workflow';
import { z } from 'zod';

async function callCore(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  return requestCore(info, { method, path: apiPath, timeoutMs: 5000, ...(body === undefined ? {} : { body }) });
}

export async function createTask(options: { repo: string; title: string; scope: string[] }): Promise<void> {
  const task = taskSchema.parse(
    await callCore('POST', '/api/v1/tasks', { repoPath: path.resolve(options.repo), title: options.title, scope: options.scope }),
  );
  console.log(`Created ${task.taskId} for ${task.repoRoot}`);
  printPlan(task);
  console.log(`\nApprove in an interactive terminal: jerry approve ${task.taskId} --stage plan --version ${task.plan.version}`);
}

export async function revisePlan(taskId: string, scope: string[]): Promise<void> {
  const task = taskSchema.parse(await callCore('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/plan`, { scope }));
  console.log(`${task.taskId} plan revised. Earlier approvals no longer apply.`);
  printPlan(task);
}

export async function listTasks(options: { all: boolean }): Promise<void> {
  const tasks = z.array(taskWithDecisionSchema).parse(await callCore('GET', '/api/v1/tasks'));
  const shown = options.all ? tasks : tasks.filter((task) => !isTerminal(task.state));
  if (shown.length === 0) {
    console.log(tasks.length === 0 ? 'No tasks.' : 'No open tasks (jerry task list --all shows finished and cancelled ones).');
    return;
  }
  for (const task of shown) {
    console.log(`${task.taskId}  plan v${task.plan.version}  ${STATE_LABELS[task.state].padEnd(26)}  ${task.repoRoot}  ${task.title}`);
  }
  const hidden = tasks.length - shown.length;
  if (hidden > 0) console.log(`(${hidden} finished or cancelled; --all shows them)`);
}

export async function showTask(taskId: string): Promise<void> {
  const id = taskId.toUpperCase();
  const [task, history] = await Promise.all([
    callCore('GET', `/api/v1/tasks/${encodeURIComponent(id)}`).then((body) => taskDetailSchema.parse(body)),
    callCore('GET', `/api/v1/tasks/${encodeURIComponent(id)}/transitions`).then((body) => z.array(workflowTransitionSchema).parse(body)),
  ]);
  console.log(`${task.taskId}  ${STATE_LABELS[task.state]} (${task.state})`);
  printPlan(task);
  const decision = task.planDecision;
  console.log(`  decision: ${decision === null ? 'none for this plan version' : `${decision.decision} ${decision.approvedAt}${decision.comment === '' ? '' : ` "${decision.comment}"`}`}`);

  console.log('\nHistory:');
  if (history.length === 0) console.log('  (none recorded; the task predates workflow states)');
  for (const step of history) {
    console.log(`  ${step.at}  ${(step.from ?? 'new').padEnd(30)} -> ${step.to.padEnd(30)} ${step.event} by ${step.actor}${step.reason === '' ? '' : `: ${step.reason}`}`);
  }

  console.log('\nClaude Code sessions:');
  if (task.sessions.length === 0) console.log('  (none yet)');
  for (const session of task.sessions) {
    const ended = session.endedAt === null ? 'may still be open' : `ended ${session.endedAt}${session.endReason === null ? '' : ` (${session.endReason})`}`;
    console.log(`  ${session.sessionId}  ${session.firstAt} .. ${session.lastAt}  last: ${session.lastActivity}, ${ended}`);
  }

  const [checkpoint] = task.checkpoints;
  if (checkpoint !== undefined) {
    console.log(`\nLast checkpoint (${checkpoint.at}, written by Claude${task.checkpoints.length > 1 ? `; ${task.checkpoints.length - 1} earlier` : ''}):`);
    console.log(`  ${checkpoint.summary}`);
    checkpoint.nextSteps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  }
}

const CONTROL_VERBS = { 'task.paused': 'pause', 'task.resumed': 'resume', 'task.cancelled': 'cancel' } as const;

/**
 * Pause, resume and cancel are user decisions: they need an interactive terminal (agents' shell
 * tools have none), and cancelling, which cannot be undone, needs the task ID typed.
 */
export async function controlTask(taskId: string, event: keyof typeof CONTROL_VERBS, reason: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`"jerry task ${CONTROL_VERBS[event]}" requires an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".`);
  }
  const task = await fetchTask(taskId);
  if (event === 'task.cancelled') {
    console.log(`${task.taskId}  ${STATE_LABELS[task.state]}  ${task.title}`);
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await prompt.question(`\nCancelling cannot be undone. Type ${task.taskId} to cancel it: `)).trim();
    prompt.close();
    if (typed !== task.taskId) {
      console.log('Confirmation did not match. Nothing was changed.');
      process.exitCode = 1;
      return;
    }
  }
  const updated = taskSchema.parse(await callCore('POST', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/transitions`, { event, reason }));
  console.log(`${updated.taskId}: ${STATE_LABELS[task.state]} -> ${STATE_LABELS[updated.state]}`);
}

async function fetchTask(taskId: string): Promise<z.infer<typeof taskWithDecisionSchema>> {
  const tasks = z.array(taskWithDecisionSchema).parse(await callCore('GET', '/api/v1/tasks'));
  const task = tasks.find((candidate) => candidate.taskId === taskId.toUpperCase());
  if (task === undefined) throw new Error(`Unknown task ${taskId}`);
  return task;
}

/**
 * Approval is a deliberate user gesture: it requires an interactive terminal and typing the
 * task ID. Claude Code's shell tools have no TTY, so an agent cannot complete this command.
 */
export async function decidePlan(options: { taskId: string; stage: string; version: number; decision: ApprovalRecord['decision']; comment: string }): Promise<void> {
  if (options.stage.toLowerCase() !== 'plan') {
    throw new Error(`Unsupported stage "${options.stage}". M0 supports only --stage plan.`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Approvals require an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".');
  }

  const tasks = z.array(taskWithDecisionSchema).parse(await callCore('GET', '/api/v1/tasks'));
  const task = tasks.find((candidate) => candidate.taskId === options.taskId);
  if (task === undefined) throw new Error(`Unknown task ${options.taskId}`);
  if (task.plan.version !== options.version) {
    throw new Error(`${task.taskId} plan is at version ${task.plan.version}, not ${options.version}. Review the current version before deciding.`);
  }
  printPlan(task);

  const verb = options.decision === 'APPROVED' ? 'approve' : 'reject';
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await prompt.question(`\nType ${task.taskId} to ${verb} plan v${task.plan.version}: `)).trim();
  prompt.close();
  if (typed !== task.taskId) {
    console.log('Confirmation did not match. Nothing was recorded.');
    process.exitCode = 1;
    return;
  }

  const record = approvalRecordSchema.parse(
    await callCore('POST', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/approvals`, {
      stage: 'PLAN',
      version: options.version,
      decision: options.decision,
      comment: options.comment,
    }),
  );
  console.log(`${record.decision}: ${record.taskId} plan v${record.version} (${record.contentHash}) as ${record.approvalId}`);
}

function printPlan(task: Task): void {
  console.log(`  state:   ${STATE_LABELS[task.state]}`);
  console.log(`  title:   ${task.title}`);
  console.log(`  repo:    ${task.repoRoot}`);
  console.log(`  plan:    v${task.plan.version}  ${task.plan.contentHash}`);
  console.log(`  scope:   ${task.plan.scope.join(', ')}`);
}
