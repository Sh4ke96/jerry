import path from 'node:path';
import readline from 'node:readline/promises';
import { approvalRecordSchema, taskDetailSchema, taskSchema, taskWithDecisionSchema, workflowTransitionSchema, type ApprovalRecord, type ImplementationReportRecord, type Task, type TaskDetail } from '@jerry/contracts';
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

  if (task.lastReport !== null) {
    const decision = task.reportDecision;
    console.log(`\nImplementation report (${task.reports.length} version(s); decision on the latest: ${decision === null ? 'none yet' : `${decision.decision}${decision.comment === '' ? '' : ` "${decision.comment}"`}`}):`);
    printReport(task.lastReport);
  }

  printFinalCheck(task);

  if (task.analyses.length > 0 || task.agentRuns.length > 0) {
    console.log('\nAnalysis:');
    for (const analysis of task.analyses) {
      const { report, citations } = analysis;
      const problems = citations.missingFiles.length + citations.outOfRange.length;
      console.log(`  ${report.role}  confidence ${report.confidence.level}  ${report.observations.length} observation(s), ${report.risks.length} risk(s), ${report.gaps.length} gap(s)  citations ${citations.checked - problems}/${citations.checked} verified`);
      for (const gap of report.gaps) console.log(`    gap: ${gap}`);
    }
    for (const run of task.agentRuns.filter((candidate) => candidate.status === 'no-report' || candidate.status === 'timed-out')) {
      console.log(`  ! ${run.agentType ?? run.agentId}: ${run.status === 'no-report' ? 'stopped without a report (gap)' : 'no result after 30 minutes (gap)'}`);
    }
  }

  const baseline = task.baseline;
  if (baseline !== null) {
    console.log(`\nGit baseline at plan approval (${baseline.at}):`);
    if (baseline.error !== null) console.log(`  not available: ${baseline.error}`);
    else {
      console.log(`  ${baseline.branch ?? 'detached HEAD'} @ ${baseline.head?.slice(0, 12) ?? 'no commits'}${baseline.upstream === null ? '' : ` (upstream ${baseline.upstream})`}`);
      console.log(`  your uncommitted files then: ${baseline.userFiles.length === 0 ? 'none' : baseline.userFiles.join(', ')}${baseline.truncated ? ' (list truncated)' : ''}`);
    }
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
 * Approving a plan and accepting an implementation are deliberate user gestures: they require an
 * interactive terminal and typing the task ID. Claude Code's shell tools have no TTY, so an agent
 * cannot complete this command (and the hard rules block it before it starts).
 */
export async function decide(options: { taskId: string; stage: 'PLAN' | 'IMPLEMENTATION'; version: number; decision: ApprovalRecord['decision']; comment: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Approvals require an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".');
  }

  const task = taskDetailSchema.parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(options.taskId.toUpperCase())}`));
  let label: string;
  if (options.stage === 'PLAN') {
    if (task.plan.version !== options.version) {
      throw new Error(`${task.taskId} plan is at version ${task.plan.version}, not ${options.version}. Review the current version before deciding.`);
    }
    printPlan(task);
    label = `plan v${task.plan.version}`;
  } else {
    const report = task.lastReport;
    if (report === null) throw new Error(`${task.taskId} has no implementation report yet.`);
    if (report.version !== options.version) {
      throw new Error(`${task.taskId} implementation report is at version ${report.version}, not ${options.version}. Review the current version before deciding.`);
    }
    printReport(report);
    label = `implementation report v${report.version}`;
    const definitionOfDone = task.plan.document?.definitionOfDone ?? [];
    if (options.decision === 'APPROVED' && definitionOfDone.length > 0) {
      console.log("\nBy accepting you confirm the plan's Definition of Done:");
      definitionOfDone.forEach((item) => console.log(`  - ${item}`));
    }
  }

  const verb = options.decision === 'APPROVED' ? (options.stage === 'PLAN' ? 'approve' : 'accept') : options.stage === 'PLAN' ? 'reject' : 'request changes to';
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await prompt.question(`\nType ${task.taskId} to ${verb} ${label}: `)).trim();
  prompt.close();
  if (typed !== task.taskId) {
    console.log('Confirmation did not match. Nothing was recorded.');
    process.exitCode = 1;
    return;
  }

  const record = approvalRecordSchema.parse(
    await callCore('POST', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/approvals`, {
      stage: options.stage,
      version: options.version,
      decision: options.decision,
      comment: options.comment,
    }),
  );
  console.log(`${record.decision}: ${record.taskId} ${label} (${record.contentHash}) as ${record.approvalId}`);
  if (options.stage === 'IMPLEMENTATION' && options.decision === 'APPROVED') {
    const after = taskDetailSchema.parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(task.taskId)}`));
    printFinalCheck(after);
  }
}

/** Core's final checks: DONE, or what keeps the task from it. */
function printFinalCheck(task: TaskDetail): void {
  const check = task.finalCheck;
  if (check === null) return;
  console.log(check.passed ? `\nJERRY final checks passed: ${task.taskId} is DONE.` : `\nJERRY final checks did not pass: ${task.taskId} stays in final checks. Request changes or cancel the task.`);
  for (const condition of check.conditions) {
    const mark = condition.passed ? 'ok  ' : condition.blocking ? 'FAIL' : 'note';
    console.log(`  ${mark} ${condition.detail}`);
  }
}

/** The report as the user reviews it in a terminal: claims next to what JERRY recorded. */
function printReport(report: ImplementationReportRecord): void {
  const { document, evidence } = report;
  console.log(`  report:  v${report.version} for plan v${report.planVersion}  ${report.contentHash}  (${report.createdAt})`);
  console.log(`  summary: ${document.summary}`);
  console.log(`  changes: ${document.changes.length} file(s)`);
  for (const change of document.changes) console.log(`    ${change.kind.padEnd(8)} ${change.repository === '' ? '' : `${change.repository}: `}${change.path}  ${change.description}`);
  console.log('  checks:');
  for (const check of document.checks) console.log(`    ${check.result.padEnd(7)} ${check.kind.padEnd(9)} ${check.command}${check.details === '' ? '' : `  (${check.details})`}`);
  if (document.planDeviations.length > 0) {
    console.log('  differences from the plan:');
    for (const deviation of document.planDeviations) console.log(`    - ${deviation.description} (${deviation.reason})`);
  }
  if (document.risks.length > 0) {
    console.log('  risks:');
    for (const risk of document.risks) console.log(`    - [${risk.severity}] ${risk.risk}${risk.mitigation === '' ? '' : ` → ${risk.mitigation}`}`);
  }
  console.log(`  QA scenarios: ${document.qaScenarios.map((scenario) => `${scenario.id} ${scenario.title}`).join('; ')}`);
  console.log(`  commit subjects: ${document.commitSubjects.join(' | ')}`);
  console.log(`  JERRY recorded since the plan approval (${evidence.since}): ${evidence.deviationCount} deviation(s), ${evidence.blockedCount} blocked, ${evidence.observedEdits.length} file(s) edited`);
  if (evidence.unreportedEdits.length > 0) console.log(`  ! edited but not in the report: ${evidence.unreportedEdits.join(', ')}`);
  if (evidence.failedOrNotRunChecks > 0) console.log(`  ! ${evidence.failedOrNotRunChecks} check(s) failed or did not run`);
}

function printPlan(task: Task): void {
  console.log(`  state:   ${STATE_LABELS[task.state]}`);
  console.log(`  title:   ${task.title}`);
  console.log(`  repo:    ${task.repoRoot}`);
  console.log(`  plan:    v${task.plan.version}  ${task.plan.contentHash}`);
  console.log(`  scope:   ${task.plan.scope.join(', ')}`);
}
