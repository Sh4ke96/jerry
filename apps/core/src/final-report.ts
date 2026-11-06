import type { FinalReport, Task } from '@jerry/contracts';
import type { StateStore } from './state-store.js';

/**
 * The final report of a task. Assembled only from what JERRY recorded:
 * the plan, the accepted implementation report and its evidence, the review, findings, observed
 * test runs, the final checks and the artifact decision. A draft until the task is DONE.
 */
export async function buildFinalReport(store: StateStore, task: Task, now: Date = new Date()): Promise<FinalReport> {
  const [reports, transitions, checks, review, findings, testRuns, artifact] = await Promise.all([
    store.reportsOf(task.taskId),
    store.listTransitions(task.taskId),
    store.latestCompletionChecks(),
    store.reviewState(task.taskId),
    store.findings({ taskId: task.taskId }),
    store.testRunsOf(task.taskId, 10),
    store.artifactDecision(task.taskId),
  ]);
  const report = reports[0] ?? null;
  const document = report?.document ?? null;
  const evidence = report?.evidence ?? null;
  const plan = task.plan.document;
  const finalCheck = checks.get(task.taskId) ?? null;
  const done = transitions.findLast((step) => step.to === 'DONE');

  // Changes per repository ('' is the task's own repository).
  const byRepository = new Map<string, Array<{ path: string; kind: string; description: string }>>();
  for (const change of document?.changes ?? []) {
    const repository = change.repository.trim() === '' ? task.repoRoot : change.repository;
    byRepository.set(repository, [...(byRepository.get(repository) ?? []), { path: change.path, kind: change.kind, description: change.description }]);
  }
  const changes = document?.changes ?? [];
  const count = (kind: string): number => changes.filter((change) => change.kind === kind).length;

  const openFindings = findings.filter((finding) => finding.status === 'OPEN' || finding.status === 'ACCEPTED');
  const line = (finding: (typeof findings)[number]): string => `${finding.findingId} ${finding.severity} ${finding.file}:${finding.lineStart} ${finding.title}`;
  const lastRound = review.rounds.at(-1);
  const reviewed = [...new Set(review.rounds.flatMap((round) => round.submissions.flatMap((submission) => submission.filesReviewed)))].sort();
  const limitations = (finalCheck?.conditions ?? []).filter((condition) => !condition.blocking && !condition.passed).map((condition) => condition.detail);

  return {
    taskId: task.taskId,
    title: task.title,
    state: task.state,
    status: task.state === 'DONE' ? 'final' : 'draft',
    completedAt: done?.at ?? null,
    generatedAt: now.toISOString(),
    goal: plan?.goal ?? task.goal ?? task.title,
    repositories: [...byRepository].map(([repository, entries]) => ({ repository, changes: entries })),
    diffSummary: {
      files: changes.length,
      added: count('added'),
      modified: count('modified'),
      deleted: count('deleted'),
      renamed: count('renamed'),
      seenByGit: evidence?.git?.changed ?? [],
      unreported: evidence?.unreportedEdits ?? [],
    },
    tests: {
      checks: (document?.checks ?? []).map((check) => ({ kind: check.kind, command: check.command, result: check.result, details: check.details })),
      observedRuns: testRuns.map((run) => ({ command: run.command, result: run.result, summary: run.summary, at: run.at })),
      claimedVsObserved: evidence?.quality?.claimedVsObserved ?? [],
    },
    qa: (document?.qaScenarios ?? []) as unknown as Array<Record<string, unknown>>,
    security: {
      risks: (document?.risks ?? []).map((risk) => ({ risk: risk.risk, severity: risk.severity, mitigation: risk.mitigation })),
      openFindings: openFindings.filter((finding) => finding.severity === 'P1' || finding.severity === 'P2').map(line),
      securityFindings: findings.filter((finding) => finding.category === 'security').map((finding) => `${line(finding)} [${finding.status}]`),
    },
    review:
      review.rounds.length === 0
        ? null
        : {
            outcome: review.outcome ?? 'not finished',
            rounds: review.rounds.length,
            reviewers: (lastRound?.submissions ?? []).map((submission) => ({ role: submission.role, independent: submission.independent, note: submission.independenceNote })),
            findings: {
              total: findings.filter((finding) => finding.source === 'review').length,
              fixed: findings.filter((finding) => finding.source === 'review' && finding.status === 'FIXED').length,
              open: review.openFindings.map(line),
            },
            uncovered: lastRound?.uncovered ?? [],
          },
    rules: {
      skills: (document?.skills ?? []).map((skill) => ({ name: skill.name, used: skill.used, note: skill.note })),
      deviations: evidence?.deviationCount ?? 0,
      blocked: evidence?.blockedCount ?? 0,
      planDeviations: (document?.planDeviations ?? []).map((deviation) => `${deviation.description}: ${deviation.reason}`),
    },
    commitSubjects: document?.commitSubjects ?? plan?.commitSubjects ?? [],
    artifact: {
      planned: plan?.artifact ?? '',
      decision: artifact?.decision ?? 'not-asked',
      kind: artifact?.kind ?? null,
      title: artifact?.title ?? null,
      url: artifact?.url ?? null,
    },
    coverage: {
      reviewedFiles: reviewed,
      notReviewed: lastRound?.uncovered ?? [],
      checksNotRun: (document?.checks ?? []).filter((check) => check.result === 'NOT_RUN').map((check) => `${check.command}: ${check.details}`),
    },
    limitations,
    decisions: [
      ...transitions.filter((step) => step.actor === 'user').map((step) => `${step.at} ${step.event}${step.reason === '' ? '' : `: ${step.reason}`}`),
      ...(plan?.openQuestions ?? []).map((question) => `open question in the plan: ${question}`),
    ],
    definitionOfDone: {
      items: finalCheck?.definitionOfDone ?? plan?.definitionOfDone ?? [],
      passed: finalCheck?.passed ?? false,
      evidence: (finalCheck?.conditions ?? []).map((condition) => ({ id: condition.id, blocking: condition.blocking, passed: condition.passed, detail: condition.detail })),
    },
  };
}
