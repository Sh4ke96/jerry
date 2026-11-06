import path from 'node:path';
import readline from 'node:readline/promises';
import { approvalRecordSchema, taskSchema, type ApprovalRecord, type Task } from '@jerry/contracts';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';

const taskWithDecisionSchema = taskSchema.extend({ planDecision: approvalRecordSchema.nullable() });

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

export async function listTasks(): Promise<void> {
  const tasks = z.array(taskWithDecisionSchema).parse(await callCore('GET', '/api/v1/tasks'));
  if (tasks.length === 0) {
    console.log('No tasks.');
    return;
  }
  for (const task of tasks) {
    const decision = task.planDecision?.decision ?? 'WAITING_FOR_APPROVAL';
    console.log(`${task.taskId}  plan v${task.plan.version}  ${decision.padEnd(20)}  ${task.repoRoot}  ${task.title}`);
  }
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
  console.log(`  title:   ${task.title}`);
  console.log(`  repo:    ${task.repoRoot}`);
  console.log(`  plan:    v${task.plan.version}  ${task.plan.contentHash}`);
  console.log(`  scope:   ${task.plan.scope.join(', ')}`);
}
