import type { AgentRun, AnalysisReportRecord, PlanDocument, PlanGrade, PlanGradeCheck } from '@jerry/contracts';
import { matchesAnyGlob } from './paths.js';

/**
 * The plan completeness grader: a fixed, deterministic rubric over the plan document
 * and, when the task was analysed, over the analysts' reports. It reads only
 * what Core already stores and never blocks anything: the user decides.
 */

export interface PlanGradeInput {
  planVersion: number;
  document: PlanDocument | undefined;
  /** The task's analysis reports and subagent runs. */
  analyses: readonly Pick<AnalysisReportRecord, 'id' | 'report' | 'citations'>[];
  agentRuns: readonly Pick<AgentRun, 'agentType' | 'status'>[];
  caseInsensitive: boolean;
}

/** Globs that cover a whole repository: JERRY's scope check then guards nothing. */
const WHOLE_REPO = new Set(['*', '**', '**/*', './**', '/**']);

const list = (items: readonly string[], max = 6): string => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);

/** A change target or step file that names a path (not a description such as "the login form"). */
function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && !/\s/.test(trimmed) && (trimmed.includes('/') || trimmed.includes('.'));
}

function normalized(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export function gradePlan(input: PlanGradeInput): PlanGrade {
  const plan = input.document;
  if (plan === undefined) {
    return {
      planVersion: input.planVersion,
      level: 'scope-only',
      score: 0,
      checks: [{ id: 'plan.document', weight: 'major', passed: false, detail: 'scope only: no plan document (goal, changes, risks, tests, Definition of Done) to review' }],
    };
  }

  const checks: PlanGradeCheck[] = [];
  const add = (id: string, weight: PlanGradeCheck['weight'], passed: boolean, ok: string, missing: string): void => {
    checks.push({ id, weight, passed, detail: passed ? ok : missing });
  };
  const inScope = (target: string): boolean => {
    const path = normalized(target);
    return matchesAnyGlob(path, plan.scope.include, input.caseInsensitive) || matchesAnyGlob(path.replace(/\/$/, '') + '/x', plan.scope.include, input.caseInsensitive);
  };

  // Scope: what JERRY checks edits against.
  const broad = plan.scope.include.filter((glob) => WHOLE_REPO.has(glob.trim()));
  add('scope.narrow', 'minor', broad.length === 0, 'the scope names specific areas', `the scope covers the whole repository (${broad.join(', ')}): edits anywhere count as planned`);
  const changeTargets = plan.changes.map((change) => change.target).filter(looksLikePath);
  const changesOutside = changeTargets.filter((target) => !inScope(target));
  add('changes.in-scope', 'major', changesOutside.length === 0, 'every change target lies in the scope', `changes outside the scope (edits there will be deviations): ${list(changesOutside)}`);
  const stepFiles = plan.steps.flatMap((step) => step.files).filter(looksLikePath);
  const stepsOutside = [...new Set(stepFiles.filter((file) => !inScope(file)))];
  add('steps.files-in-scope', 'major', stepsOutside.length === 0, 'every step file lies in the scope', `step files outside the scope: ${list(stepsOutside)}`);

  // Steps: an order that can be followed.
  const badDependencies = plan.steps.flatMap((step, index) => step.dependsOn.filter((dependency) => dependency < 1 || dependency > plan.steps.length || dependency >= index + 1).map((dependency) => `step ${index + 1} → ${dependency}`));
  add('steps.order', 'major', badDependencies.length === 0, 'step dependencies point to earlier steps', `step dependencies that point to itself, a later or a missing step: ${list(badDependencies)}`);

  // Risks, rollback, compatibility.
  add('risks.listed', 'major', plan.risks.length > 0, `${plan.risks.length} risk(s) with mitigations`, 'no risks listed: every change has some (compatibility, security, data, rollback)');
  if (plan.classification.includes('security') || plan.classification.includes('database')) {
    const serious = plan.risks.filter((risk) => risk.severity !== 'low').length;
    add('risks.sensitive-area', 'minor', serious > 0, 'a security or database change names at least one medium or high risk', 'a security or database change lists only low risks');
  }
  add('rollback.described', 'minor', plan.rollback.trim() !== '', 'rollback is described', 'no rollback: how is the change undone?');

  // Repositories and contracts.
  if (plan.repositories.length > 1) {
    add('cross-repo.contracts', 'major', plan.crossRepoDependencies.trim() !== '', 'contracts between the repositories are described', `${plan.repositories.length} repositories but no contracts or order between them`);
  }

  // Tests fit the kind of change.
  const kinds = new Set(plan.tests.map((test) => test.kind));
  const needs: Array<[boolean, readonly string[], string]> = [
    [plan.classification.includes('ui-ux') || plan.classification.includes('frontend'), ['component', 'e2e', 'manual'], 'UI or frontend change without component, E2E or manual tests'],
    [plan.classification.includes('api-backend'), ['api', 'integration', 'unit'], 'API or backend change without API, integration or unit tests'],
    [plan.classification.includes('database'), ['integration', 'api', 'e2e'], 'database change without integration tests'],
  ];
  const missingTests = needs.filter(([applies, accepted]) => applies && !accepted.some((kind) => kinds.has(kind as never))).map(([, , message]) => message);
  add('tests.fit-change', 'major', missingTests.length === 0, `tests fit the change (${[...kinds].join(', ')})`, missingTests.join('; '));
  add('regression.planned', 'minor', plan.regression.trim() !== '', 'regression checks are planned', 'no regression plan: what else could break, and how is it checked?');

  // Handover.
  add('qa.scenarios', 'minor', plan.qaScenarios.length > 0, `${plan.qaScenarios.length} manual QA scenario(s)`, 'no manual QA scenarios for the tester');
  add('commits.proposed', 'minor', plan.commitSubjects.length > 0, `${plan.commitSubjects.length} proposed commit subject(s)`, 'no proposed commit subjects');

  // Unknowns must reach the user.
  const unknowns = JSON.stringify(plan).match(/\bUNKNOWN\b/g)?.length ?? 0;
  add('unknowns.raised', 'minor', unknowns === 0 || plan.openQuestions.length > 0, unknowns === 0 ? 'no UNKNOWN left in the plan' : `${unknowns} UNKNOWN(s), with open questions for the user`, `${unknowns} UNKNOWN(s) in the plan but no open questions for the user`);

  // The analysis the plan should rest on.
  const analystRuns = input.agentRuns.filter((run) => (run.agentType ?? '').includes('-analyst'));
  if (input.analyses.length > 0 || analystRuns.length > 0) {
    const cited = new Set(plan.analysis?.reports ?? []);
    const uncited = input.analyses.filter((record) => !cited.has(record.id)).map((record) => `#${record.id} (${record.report.role})`);
    add('analysis.reports-cited', 'major', plan.analysis !== undefined && uncited.length === 0, `the plan cites all ${input.analyses.length} analysis report(s)`, plan.analysis === undefined ? 'the task was analysed but the plan has no analysis section' : `analysis reports the plan does not cite: ${list(uncited)}`);

    const failedRuns = analystRuns.filter((run) => run.status === 'no-report' || run.status === 'timed-out').length;
    const unverified = input.analyses.filter((record) => record.citations.missingFiles.length + record.citations.outOfRange.length > 0).length;
    const reportGaps = input.analyses.filter((record) => record.report.gaps.length > 0).length;
    const expected = failedRuns + unverified + reportGaps;
    const carried = plan.analysis?.gaps.length ?? 0;
    add(
      'analysis.gaps-carried',
      'major',
      expected === 0 || carried > 0,
      expected === 0 ? 'the analysis left no gaps' : `${carried} gap(s) carried into the plan`,
      `the analysis left gaps (${[failedRuns > 0 ? `${failedRuns} analyst(s) without a result` : '', unverified > 0 ? `${unverified} report(s) with unverified citations` : '', reportGaps > 0 ? `${reportGaps} report(s) naming what they could not check` : ''].filter(Boolean).join(', ')}) but the plan carries none`,
    );

    const serious = new Set(input.analyses.flatMap((record) => record.report.risks.filter((risk) => risk.severity === 'high' || risk.severity === 'critical').map((risk) => risk.risk.trim().toLowerCase())));
    add('analysis.risks-addressed', 'minor', plan.risks.length >= serious.size, serious.size === 0 ? 'the analysts reported no high or critical risk' : `${serious.size} high or critical analyst risk(s), ${plan.risks.length} plan risk(s)`, `the analysts reported ${serious.size} high or critical risk(s) but the plan lists only ${plan.risks.length}`);
  }

  const weightOf = (check: PlanGradeCheck): number => (check.weight === 'major' ? 3 : 1);
  const total = checks.reduce((sum, check) => sum + weightOf(check), 0);
  const passed = checks.filter((check) => check.passed).reduce((sum, check) => sum + weightOf(check), 0);
  const score = total === 0 ? 100 : Math.round((100 * passed) / total);
  const majorsPass = checks.every((check) => check.weight !== 'major' || check.passed);
  const level = !majorsPass ? 'incomplete' : checks.every((check) => check.passed) ? 'complete' : 'mostly-complete';
  return { planVersion: input.planVersion, level, score, checks };
}
