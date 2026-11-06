import path from 'node:path';
import readline from 'node:readline/promises';
import { approvalRecordSchema, finalReportSchema, planSchema, REVIEWER_ROLES, reviewStateSchema, type ReviewState, taskDetailSchema, taskSchema, taskWithDecisionSchema, workflowTransitionSchema, type ApprovalRecord, type ImplementationReportRecord, type Task, type TaskDetail } from '@jerry/contracts';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { diffPlans, isEmptyDiff, isTerminal, STATE_LABELS } from '@jerry/workflow';
import { z } from 'zod';
import { flag, mark, resultMark, severityMark, stateMark } from './emoji.js';

async function callCore(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  return requestCore(info, { method, path: apiPath, timeoutMs: 5000, ...(body === undefined ? {} : { body }) });
}

export async function createTask(options: { repo: string; title: string; scope: string[] }): Promise<void> {
  const task = taskSchema.parse(
    await callCore('POST', '/api/v1/tasks', { repoPath: path.resolve(options.repo), title: options.title, scope: options.scope }),
  );
  console.log(mark('pass', `Created ${task.taskId} for ${task.repoRoot}`));
  printPlan(task);
  console.log(`\n${mark('next', `Approve in an interactive terminal: jerry approve ${task.taskId} --stage plan --version ${task.plan.version}`)}`);
}

export async function revisePlan(taskId: string, scope: string[]): Promise<void> {
  const task = taskSchema.parse(await callCore('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/plan`, { scope }));
  console.log(mark('plan', `${task.taskId} plan revised. Earlier approvals no longer apply.`));
  printPlan(task);
}

/** What changed between two plan versions; by default the latest against the one before. */
export async function showPlanDiff(taskId: string, options: { from?: string; to?: string }): Promise<void> {
  const id = taskId.toUpperCase();
  const versions = z.array(planSchema).parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(id)}/plans`));
  const latest = versions.at(-1);
  if (latest === undefined || versions.length < 2) {
    console.log(mark('info', `${id} has only plan v${latest?.version ?? 1}; there is nothing to compare.`));
    return;
  }
  const to = options.to === undefined ? latest.version : Number(options.to);
  const from = options.from === undefined ? to - 1 : Number(options.from);
  const older = versions.find((plan) => plan.version === from);
  const newer = versions.find((plan) => plan.version === to);
  if (older === undefined || newer === undefined || from >= to) {
    process.exitCode = 1;
    console.error(mark('fail', `Pick two versions of ${id} with --from older --to newer (it has v1..v${latest.version}).`));
    return;
  }
  const diff = diffPlans(older, newer);
  console.log(mark('plan', `${id} plan v${from} → v${to}`));
  if (isEmptyDiff(diff)) {
    console.log('  no differences in what you review (the hash still differs by version number)');
    return;
  }
  if (diff.document === 'added') console.log('  the full plan document was added (it was scope only)');
  if (diff.document === 'removed') console.log(`  ${flag('the full plan document was removed (now scope only)')}`);
  if (diff.scope.added.length + diff.scope.removed.length > 0) {
    console.log('  Scope (what JERRY checks edits against):');
    for (const glob of diff.scope.added) console.log(`    + ${glob}`);
    for (const glob of diff.scope.removed) console.log(`    - ${glob}`);
  }
  for (const section of diff.sections) {
    console.log(`  ${section.section}:`);
    if (section.before !== undefined || section.after !== undefined) {
      if (section.before !== '') console.log(`    - ${section.before}`);
      if (section.after !== '') console.log(`    + ${section.after}`);
    }
    for (const item of section.added) console.log(`    + ${item}`);
    for (const item of section.removed) console.log(`    - ${item}`);
  }
}

export async function listTasks(options: { all: boolean }): Promise<void> {
  const tasks = z.array(taskWithDecisionSchema).parse(await callCore('GET', '/api/v1/tasks'));
  const shown = options.all ? tasks : tasks.filter((task) => !isTerminal(task.state));
  if (shown.length === 0) {
    console.log(mark('info', tasks.length === 0 ? 'No tasks.' : 'No open tasks (jerry task list --all shows finished and cancelled ones).'));
    return;
  }
  for (const task of shown) {
    console.log(stateMark(task.state, `${task.taskId}  plan v${task.plan.version}  ${STATE_LABELS[task.state].padEnd(26)}  ${task.repoRoot}  ${task.title}`));
  }
  const hidden = tasks.length - shown.length;
  if (hidden > 0) console.log(`(${hidden} finished or cancelled; --all shows them)`);
}

/** The final report of a task: assembled by Core from what it recorded. */
export async function showFinalReport(taskId: string, options: { json: boolean }): Promise<void> {
  const report = finalReportSchema.parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(taskId.toUpperCase())}/final-report`));
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const out = (text = ''): void => console.log(text);
  out(mark('report', `${report.taskId}  ${report.title}  — final report${report.status === 'draft' ? ' (DRAFT: the task is not DONE yet)' : ` (DONE ${report.completedAt})`}`));
  out(`Goal: ${report.goal}`);
  out(`\n${mark('implementation', 'Changes')}`);
  for (const repository of report.repositories) {
    out(`  ${repository.repository}`);
    for (const change of repository.changes) out(`    ${change.kind.padEnd(9)} ${change.path}  ${change.description}`);
  }
  const diff = report.diffSummary;
  out(`  ${diff.files} file(s): ${diff.added} added, ${diff.modified} modified, ${diff.deleted} deleted, ${diff.renamed} renamed${diff.unreported.length === 0 ? '' : `; not in the report: ${diff.unreported.join(', ')}`}`);
  out(`\n${mark('tests', 'Tests')}`);
  for (const check of report.tests.checks) out(`  ${resultMark(check.result, check.result.padEnd(7))} ${check.kind.padEnd(9)} ${check.command}${check.details === '' ? '' : `  (${check.details})`}`);
  for (const run of report.tests.observedRuns.slice(0, 3)) out(`  seen by JERRY: ${run.result} ${run.command}${run.summary === null ? '' : `  (${run.summary})`}`);
  for (const line of report.tests.claimedVsObserved) out(`  ${flag(line)}`);
  out(`\n${mark('security', 'Security and risks')}`);
  for (const risk of report.security.risks) out(`  ${risk.severity.padEnd(8)} ${risk.risk}${risk.mitigation === '' ? '' : ` → ${risk.mitigation}`}`);
  for (const finding of report.security.openFindings) out(`  ${flag(`open ${finding}`)}`);
  if (report.review !== null) {
    out(`\n${mark('review', `Review: ${report.review.outcome} after ${report.review.rounds} round(s); ${report.review.findings.total} finding(s), ${report.review.findings.fixed} fixed`)}`);
    for (const reviewer of report.review.reviewers) out(`  ${reviewer.role}${reviewer.independent ? '' : `  (not independent: ${reviewer.note})`}`);
    for (const open of report.review.findings.open) out(`  ${flag(`open ${open}`)}`);
  }
  out(`\n${mark('jerry', `Rules: ${report.rules.deviations} deviation(s), ${report.rules.blocked} blocked`)}`);
  for (const deviation of report.rules.planDeviations) out(`  plan deviation: ${deviation}`);
  out(`\n${mark('next', 'Proposed commits (the user commits)')}`);
  for (const subject of report.commitSubjects) out(`  ${subject}`);
  out(`\n${mark('tests', `QA handover: ${report.qa.length} scenario(s)`)}`);
  out(mark('artifact', `Artifact: ${report.artifact.decision === 'created' ? `${report.artifact.title} (${report.artifact.kind}) ${report.artifact.url}` : report.artifact.decision === 'declined' ? 'declined by the user' : `not asked yet${report.artifact.planned === '' ? '' : ` (plan: ${report.artifact.planned})`}; offer it with /jerry:artifact`}`));
  out(`\n${mark('review', 'Coverage')}`);
  out(`  reviewed: ${report.coverage.reviewedFiles.length} file(s)${report.coverage.notReviewed.length === 0 ? '' : `; not reviewed: ${report.coverage.notReviewed.join(', ')}`}`);
  for (const check of report.coverage.checksNotRun) out(`  ${resultMark('NOT_RUN', `not run: ${check}`)}`);
  if (report.limitations.length > 0) {
    out(`\n${mark('warning', 'Limitations')}`);
    for (const limitation of report.limitations) out(`  - ${limitation}`);
  }
  out(`\n${mark(report.definitionOfDone.passed ? 'done' : 'fail', `Definition of Done: ${report.definitionOfDone.passed ? 'met' : 'not met'}`)}`);
  for (const item of report.definitionOfDone.items) out(`  - ${item}`);
  for (const condition of report.definitionOfDone.evidence.filter((entry) => entry.blocking)) out(`  ${resultMark(condition.passed ? 'PASS' : 'FAIL', condition.passed ? 'ok  ' : 'FAIL')} ${condition.detail}`);
}

export async function showTask(taskId: string): Promise<void> {
  const id = taskId.toUpperCase();
  const [task, history] = await Promise.all([
    callCore('GET', `/api/v1/tasks/${encodeURIComponent(id)}`).then((body) => taskDetailSchema.parse(body)),
    callCore('GET', `/api/v1/tasks/${encodeURIComponent(id)}/transitions`).then((body) => z.array(workflowTransitionSchema).parse(body)),
  ]);
  console.log(stateMark(task.state, `${task.taskId}  ${STATE_LABELS[task.state]} (${task.state})`));
  printPlan(task);
  const decision = task.planDecision;
  console.log(`  decision: ${decision === null ? mark('waiting', 'none for this plan version') : mark(decision.decision === 'APPROVED' ? 'pass' : 'fail', `${decision.decision} ${decision.approvedAt}${decision.comment === '' ? '' : ` "${decision.comment}"`}`)}`);
  const grade = task.planGrade;
  if (grade !== null) {
    // Informational: the decision stays the user's.
    console.log(`  ${mark('plan', `completeness: ${grade.level} (${grade.score}/100, informational)`)}`);
    for (const check of grade.checks.filter((candidate) => !candidate.passed)) console.log(`    - ${check.weight}: ${check.detail}`);
  }

  console.log(`\n${mark('task', 'History:')}`);
  if (history.length === 0) console.log('  (none recorded; the task predates workflow states)');
  for (const step of history) {
    console.log(`  ${stateMark(step.to, `${step.at}  ${(step.from ?? 'new').padEnd(30)} -> ${step.to.padEnd(30)} ${step.event} by ${step.actor}${step.reason === '' ? '' : `: ${step.reason}`}`)}`);
  }

  console.log(`\n${mark('session', 'Claude Code sessions:')}`);
  if (task.sessions.length === 0) console.log('  (none yet)');
  for (const session of task.sessions) {
    const ended = session.endedAt === null ? 'may still be open' : `ended ${session.endedAt}${session.endReason === null ? '' : ` (${session.endReason})`}`;
    console.log(`  ${session.sessionId}  ${session.firstAt} .. ${session.lastAt}  last: ${session.lastActivity}, ${ended}`);
  }

  if (task.lastReport !== null) {
    const decision = task.reportDecision;
    console.log(`\n${mark('report', `Implementation report (${task.reports.length} version(s); decision on the latest: ${decision === null ? 'none yet' : `${decision.decision}${decision.comment === '' ? '' : ` "${decision.comment}"`}`}):`)}`);
    printReport(task.lastReport);
  }

  printFinalCheck(task);

  if (task.findings !== null) {
    const counts = task.findings;
    const levels = (['P1', 'P2', 'P3', 'P4'] as const).map((level) => `${level} ${counts.bySeverity[level]}`).join(', ');
    console.log(`\n${mark('finding', `Quality findings: ${counts.open} open (${levels}), ${counts.fixed} fixed, ${counts.dismissed} dismissed. Details: jerry findings --task ${task.taskId}`)}`);
  }
  if (task.lastTestRun !== null) {
    const run = task.lastTestRun;
    console.log(mark('tests', `Last tests (run by Claude): ${run.result}  ${run.command}${run.summary === null ? '' : `  (${run.summary})`}  ${run.at}`));
  }

  if (task.analyses.length > 0 || task.agentRuns.length > 0) {
    console.log(`\n${mark('analysis', 'Analysis:')}`);
    for (const analysis of task.analyses) {
      const { report, citations } = analysis;
      const problems = citations.missingFiles.length + citations.outOfRange.length;
      console.log(`  #${analysis.id} ${report.role}  confidence ${report.confidence.level}  ${report.observations.length} observation(s), ${report.risks.length} risk(s), ${report.gaps.length} gap(s)  citations ${citations.checked - problems}/${citations.checked} verified`);
      for (const gap of report.gaps) console.log(`    gap: ${gap}`);
    }
    for (const run of task.agentRuns.filter((candidate) => candidate.status === 'no-report' || candidate.status === 'timed-out')) {
      console.log(`  ${flag(`${run.agentType ?? run.agentId}: ${run.status === 'no-report' ? 'stopped without a report (gap)' : 'no result after 30 minutes (gap)'}`)}`);
    }
  }

  const baseline = task.baseline;
  if (baseline !== null) {
    console.log(`\n${mark('repository', `Git baseline at plan approval (${baseline.at}):`)}`);
    if (baseline.error !== null) console.log(`  not available: ${baseline.error}`);
    else {
      console.log(`  ${baseline.branch ?? 'detached HEAD'} @ ${baseline.head?.slice(0, 12) ?? 'no commits'}${baseline.upstream === null ? '' : ` (upstream ${baseline.upstream})`}`);
      console.log(`  your uncommitted files then: ${baseline.userFiles.length === 0 ? 'none' : baseline.userFiles.join(', ')}${baseline.truncated ? ' (list truncated)' : ''}`);
    }
  }

  const [checkpoint] = task.checkpoints;
  if (checkpoint !== undefined) {
    console.log(`\n${mark('next', `Last checkpoint (${checkpoint.at}, written by Claude${task.checkpoints.length > 1 ? `; ${task.checkpoints.length - 1} earlier` : ''}):`)}`);
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
    console.log(stateMark(task.state, `${task.taskId}  ${STATE_LABELS[task.state]}  ${task.title}`));
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await prompt.question(`\nCancelling cannot be undone. Type ${task.taskId} to cancel it: `)).trim();
    prompt.close();
    if (typed !== task.taskId) {
      console.log(mark('fail', 'Confirmation did not match. Nothing was changed.'));
      process.exitCode = 1;
      return;
    }
  }
  const updated = taskSchema.parse(await callCore('POST', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/transitions`, { event, reason }));
  console.log(stateMark(updated.state, `${updated.taskId}: ${STATE_LABELS[task.state]} -> ${STATE_LABELS[updated.state]}`));
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
export async function decide(options: { taskId: string; stage: 'PLAN' | 'IMPLEMENTATION' | 'REVIEW_FIX'; version: number; decision: ApprovalRecord['decision']; comment: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Approvals require an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".');
  }

  const task = taskDetailSchema.parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(options.taskId.toUpperCase())}`));
  let label: string;
  if (options.stage === 'REVIEW_FIX') {
    // The fix plan of a review round; its round number is the version.
    const review = reviewStateSchema.parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(task.taskId)}/review`));
    const round = review.rounds.find((candidate) => candidate.round === options.version);
    if (round?.fixPlan == null) throw new Error(`${task.taskId} has no fix plan in review round ${options.version}. See "jerry review show ${task.taskId}".`);
    printReview(review);
    label = `the fix plan of review round ${round.round}`;
  } else if (options.stage === 'PLAN') {
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
      console.log(`\n${mark('done', "By accepting you confirm the plan's Definition of Done:")}`);
      definitionOfDone.forEach((item) => console.log(`  - ${item}`));
    }
  }

  const verb = options.decision === 'APPROVED' ? (options.stage === 'IMPLEMENTATION' ? 'accept' : 'approve') : options.stage === 'IMPLEMENTATION' ? 'request changes to' : 'reject';
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await prompt.question(`\nType ${task.taskId} to ${verb} ${label}: `)).trim();
  prompt.close();
  if (typed !== task.taskId) {
    console.log(mark('fail', 'Confirmation did not match. Nothing was recorded.'));
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
  console.log(mark(record.decision === 'APPROVED' ? 'pass' : 'fail', `${record.decision}: ${record.taskId} ${label} (${record.contentHash}) as ${record.approvalId}`));
  if (options.stage === 'IMPLEMENTATION' && options.decision === 'APPROVED') {
    console.log(mark('review', `${task.taskId} goes to independent code review: three JERRY reviewers check every changed file. "jerry review show ${task.taskId}" follows it; "jerry review skip ${task.taskId}" waives it.`));
  }
}

/** The independent review of a task. */
function printReview(review: ReviewState): void {
  console.log(mark('review', `${review.taskId}  review ${review.outcome ?? 'in progress'}  (${review.state}, ${review.rounds.length}/${review.maxRounds} round(s))`));
  for (const round of review.rounds) {
    const roundEmoji = round.skippedAt !== null ? 'skipped' : round.completedAt === null ? 'waiting' : 'review';
    console.log(`\n${mark(roundEmoji, `Round ${round.round} (${round.startedAt}${round.completedAt === null ? ', open' : `, closed ${round.completedAt}`})${round.skippedAt === null ? '' : ` waived by the user: ${round.skipReason}`}`)}`);
    for (const submission of round.submissions) {
      console.log(`  ${mark('agent', `${submission.role.padEnd(28)} ${submission.findings} finding(s), ${submission.filesReviewed.length} file(s) read`)}${submission.independent ? '' : `  ${flag(`not independent: ${submission.independenceNote}`)}`}`);
    }
    const missing = REVIEWER_ROLES.filter((role) => !round.submissions.some((submission) => submission.role === role));
    if (round.completedAt !== null && missing.length > 0) console.log(`  ${flag(`no report from ${missing.join(', ')}`)}`);
    if (round.uncovered.length > 0) console.log(`  ${flag(`changed files no reviewer covered: ${round.uncovered.join(', ')}`)}`);
    if (round.fixPlan !== null) {
      console.log(`  ${mark('plan', `fix plan (${round.fixPlanHash}): ${round.fixPlan.summary}`)}`);
      for (const item of round.fixPlan.items) console.log(`    - ${item.findings.join(', ')}: ${item.change} [${item.files.join(', ')}]`);
      for (const entry of round.fixPlan.notFixed) console.log(`    not fixed ${entry.finding}: ${entry.reason}`);
    }
    if (round.fixesSummary !== null) console.log(`  ${mark('implementation', `fixes: ${round.fixesSummary}`)}`);
  }
  if (review.openFindings.length > 0) {
    console.log(`\n${mark('finding', 'Open review findings:')}`);
    for (const finding of review.openFindings) console.log(`  ${severityMark(finding.severity, `${finding.findingId} ${finding.severity} ${finding.file}:${finding.lineStart} ${finding.title}`)}`);
  }
}

export async function showReview(taskId: string): Promise<void> {
  printReview(reviewStateSchema.parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(taskId.toUpperCase())}/review`)));
}

/** Waiving the review is the user's decision: an interactive terminal, the typed task ID and a reason. */
export async function skipReview(taskId: string, options: { reason?: string }): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Waiving a review requires an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".');
  }
  const id = taskId.toUpperCase();
  await showReview(id);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const reason = options.reason?.trim() || (await prompt.question('\nWhy waive the review? ')).trim();
    if (reason === '') throw new Error('A reason is required; nothing changed.');
    const typed = (await prompt.question(`Type ${id} to waive its review: `)).trim();
    if (typed !== id) {
      console.log(mark('fail', 'Confirmation did not match. Nothing was recorded.'));
      process.exitCode = 1;
      return;
    }
    await callCore('POST', `/api/v1/tasks/${encodeURIComponent(id)}/review/skip`, { reason });
    printFinalCheck(taskDetailSchema.parse(await callCore('GET', `/api/v1/tasks/${encodeURIComponent(id)}`)));
  } finally {
    prompt.close();
  }
}

/** Core's final checks: DONE, or what keeps the task from it. */
function printFinalCheck(task: TaskDetail): void {
  const check = task.finalCheck;
  if (check === null) return;
  console.log(`\n${check.passed ? mark('done', `JERRY final checks passed: ${task.taskId} is DONE.`) : mark('fail', `JERRY final checks did not pass: ${task.taskId} stays in final checks. Request changes or cancel the task.`)}`);
  for (const condition of check.conditions) {
    const label = condition.passed ? 'ok  ' : condition.blocking ? 'FAIL' : 'note';
    console.log(`  ${resultMark(condition.passed ? 'PASS' : condition.blocking ? 'FAIL' : 'WARN', label)} ${condition.detail}`);
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
  for (const check of document.checks) console.log(`    ${resultMark(check.result, check.result.padEnd(7))} ${check.kind.padEnd(9)} ${check.command}${check.details === '' ? '' : `  (${check.details})`}`);
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
  console.log(`  ${mark('jerry', `JERRY recorded since the plan approval (${evidence.since}): ${evidence.deviationCount} deviation(s), ${evidence.blockedCount} blocked, ${evidence.observedEdits.length} file(s) edited`)}`);
  if (evidence.unreportedEdits.length > 0) console.log(`  ${flag(`edited but not in the report: ${evidence.unreportedEdits.join(', ')}`)}`);
  if (evidence.failedOrNotRunChecks > 0) console.log(`  ${flag(`${evidence.failedOrNotRunChecks} check(s) failed or did not run`)}`);
  const quality = evidence.quality;
  if (quality !== undefined) {
    console.log(`  ${mark('finding', `quality at the report: ${quality.openFindings} open finding(s)${quality.lastTestRun === null ? ', no test run seen' : `, last tests seen: ${quality.lastTestRun.result} ${quality.lastTestRun.command}`}`)}`);
    for (const line of quality.serious) console.log(`  ${flag(`open finding ${line}`)}`);
    for (const line of quality.claimedVsObserved) console.log(`  ${flag(line)}`);
    if (quality.unplannedFiles.length > 0) console.log(`  ${flag(`changed but named by no plan step: ${quality.unplannedFiles.join(', ')}`)}`);
  }
}

function printPlan(task: Task): void {
  console.log(`  state:   ${stateMark(task.state, STATE_LABELS[task.state])}`);
  console.log(`  title:   ${task.title}`);
  console.log(`  repo:    ${task.repoRoot}`);
  if (task.goal !== undefined) console.log(`  goal:    ${task.goal}`);
  // An intake has no real plan yet; its scope is only the area to analyse.
  const intake = task.goal !== undefined && task.plan.version === 1 && task.plan.document === undefined;
  console.log(intake ? '  plan:    none yet (analysis first)' : `  plan:    v${task.plan.version}  ${task.plan.contentHash}`);
  console.log(`  ${intake ? 'focus:  ' : 'scope:  '} ${task.plan.scope.join(', ')}`);
  if (task.plan.document?.analysis !== undefined) {
    const { reports, gaps } = task.plan.document.analysis;
    console.log(`  based on analysis report(s): ${reports.length === 0 ? 'none' : reports.map((id) => `#${id}`).join(', ')}${gaps.length === 0 ? '' : `; gaps: ${gaps.join('; ')}`}`);
  }
}
