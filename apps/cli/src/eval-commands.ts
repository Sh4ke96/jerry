import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JERRY_VERSION, evalCalibrationSchema, evalRunDetailSchema, evalRunSummarySchema, evalStatusSchema, type EvalRunDetail } from '@jerry/contracts';
import { jerryFingerprint, loadCases, runSuite, type AttemptResult, type CaseResult, type EvalCase } from '@jerry/evals';
import { findClaudeBinary, readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';
import { EMOJI, flag, mark, resultMark, type EmojiName } from './emoji.js';

/**
 * `jerry eval`: runs JERRY's golden cases with real Claude Code sessions, each in
 * its own fixture repository, JERRY home and Core under the system temp directory; records the
 * results in JERRY's database and compares them with the baseline. Setting a baseline and labelling
 * rubric results are the user's decisions (interactive terminal).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_BUNDLE = path.resolve(HERE, '..', 'core', 'core.mjs');
const PLUGIN_DIR = path.resolve(HERE, '..', 'plugin');
const BUNDLED_CASES = path.resolve(HERE, '..', 'evals', 'cases');

async function callCore(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  return requestCore(info, { method, path: apiPath, timeoutMs: 30_000, ...(body === undefined ? {} : { body }) });
}

function casesDir(dir: string | undefined): string {
  if (dir !== undefined) return path.resolve(dir);
  const local = path.resolve('evals', 'cases');
  return fs.existsSync(local) ? local : BUNDLED_CASES;
}

function selectCases(options: { dir?: string; suite?: string; case?: string[] }): EvalCase[] {
  const dir = casesDir(options.dir);
  // A case's command graders run shell commands (in its throwaway fixture): warn about cases from elsewhere.
  if (options.dir !== undefined && path.resolve(options.dir) !== path.resolve('evals', 'cases') && path.resolve(options.dir) !== BUNDLED_CASES) {
    console.error(flag(`Cases from ${dir} can run shell commands and prompt Claude Code with edit permissions in temp fixtures. Only use case directories you trust.`, EMOJI.security));
  }
  const loaded = loadCases(dir);
  for (const error of loaded.errors) console.error(flag(`${error.file}: ${error.error}`, EMOJI.fail));
  if (loaded.errors.length > 0) throw new Error(`${loaded.errors.length} case file(s) are invalid; fix them first (a broken case never runs silently).`);
  return loaded.cases.filter((evalCase) => (options.suite === undefined || evalCase.suite === options.suite) && (options.case === undefined || options.case.length === 0 || options.case.includes(evalCase.id)));
}

export function listCases(options: { dir?: string; suite?: string }): void {
  const cases = selectCases(options);
  console.log(mark('evals', `${cases.length} case(s) in ${casesDir(options.dir)}`));
  for (const evalCase of cases) console.log(`  ${evalCase.id.padEnd(32)} ${evalCase.suite.padEnd(10)} ${evalCase.kind.padEnd(18)}${evalCase.critical ? ' critical' : ''}  ${evalCase.title}`);
}

const MARK: Record<string, string> = { PASS: 'PASS ', FAIL: 'FAIL ', FLAKY: 'FLAKY', ERROR: 'ERROR' };
/** Emoji of an attempt or case outcome. */
const OUTCOME_EMOJI: Record<string, EmojiName> = { PASS: 'pass', FAIL: 'fail', FLAKY: 'warning', ERROR: 'fail' };
/** Emoji of a case compared with the baseline; an unchanged case shows its current outcome. */
const COMPARISON_EMOJI: Record<string, EmojiName> = { REGRESSION: 'blocked', FIXED: 'pass', NEW: 'info', FLAKY: 'warning', MISSING: 'warning', ERROR: 'fail' };

function outcomeMark(outcome: string | null, text: string): string {
  return mark(outcome === null ? 'info' : (OUTCOME_EMOJI[outcome] ?? 'info'), text);
}

export async function runEvals(options: { dir?: string; suite?: string; case?: string[]; repeats?: number; parallel?: number; label?: string; model?: string; keepFailed: boolean }): Promise<void> {
  const cases = selectCases(options).map((evalCase) => (options.model === undefined ? evalCase : { ...evalCase, session: { ...evalCase.session, model: options.model } }));
  if (cases.length === 0) throw new Error('No case matches.');
  const claude = process.env['JERRY_EVAL_CLAUDE'] ?? findClaudeBinary()?.path;
  if (claude === undefined) throw new Error('Claude Code CLI not found; set JERRY_CLAUDE_BIN.');
  const calibrated = new Set(z.array(z.object({ rubricId: z.string(), calibrated: z.boolean() })).parse(await callCore('GET', '/api/v1/evals/calibration').catch(() => [])).filter((entry) => entry.calibrated).map((entry) => entry.rubricId));
  console.log(mark('evals', `Running ${cases.length} case(s) with ${claude}; each attempt in its own temp fixture, JERRY home and Core.`));
  const startedAt = new Date().toISOString();
  const results = await runSuite(cases, {
    coreBundle: CORE_BUNDLE,
    pluginDir: PLUGIN_DIR,
    claudeBin: claude,
    keepFailed: options.keepFailed,
    calibrated: (rubricId) => calibrated.has(rubricId),
    ...(options.parallel === undefined ? {} : { parallel: options.parallel }),
    ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
    onAttempt: (attempt: AttemptResult) => console.log(`  ${outcomeMark(attempt.outcome, MARK[attempt.outcome] ?? attempt.outcome)} ${attempt.caseId} #${attempt.attempt} (${(attempt.durationMs / 1000).toFixed(1)} s)${attempt.harnessError === null ? '' : `  ${attempt.harnessError}`}${attempt.fixtureDir === null ? '' : `  kept: ${attempt.fixtureDir}`}`),
  });
  const submission = {
    startedAt,
    finishedAt: new Date().toISOString(),
    jerryVersion: JERRY_VERSION,
    fingerprint: jerryFingerprint(PLUGIN_DIR),
    label: options.label ?? '',
    results: results.map(toSubmitted),
  };
  let detail: EvalRunDetail;
  try {
    detail = evalRunDetailSchema.parse(await callCore('POST', '/api/v1/evals/runs', submission));
  } catch (error) {
    const file = path.join(os.tmpdir(), `jerry-eval-run-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(submission, null, 2));
    throw new Error(`Core did not record the run (${error instanceof Error ? error.message : String(error)}); the results are in ${file}`);
  }
  printRun(detail);
  if (detail.comparison.releaseBlocked) process.exitCode = 2;
  else if (detail.comparison.regressions.length > 0) process.exitCode = 1;
}

function toSubmitted(result: CaseResult) {
  return {
    caseId: result.caseId,
    suite: result.suite,
    kind: result.kind,
    critical: result.critical,
    outcome: result.outcome,
    attempts: result.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      outcome: attempt.outcome,
      harnessError: attempt.harnessError,
      durationMs: attempt.durationMs,
      costUsd: attempt.costUsd,
      sessionId: attempt.sessionId,
      output: attempt.output.slice(0, 2000),
      graders: attempt.results,
    })),
  };
}

function printRun(detail: EvalRunDetail): void {
  const { counts, comparison } = detail;
  console.log(`\n${mark('evals', `${detail.runId}${detail.isBaseline ? ' (baseline)' : ''}  ${detail.finishedAt}  PASS ${counts.PASS} · FAIL ${counts.FAIL} · FLAKY ${counts.FLAKY} · ERROR ${counts.ERROR}${detail.label === '' ? '' : `  "${detail.label}"`}`)}`);
  console.log(`Compared with ${comparison.baselineRunId ?? 'no baseline yet'}:`);
  for (const entry of comparison.cases) {
    const result = detail.results.find((candidate) => candidate.caseId === entry.caseId);
    const line = `${entry.comparison.padEnd(10)} ${entry.caseId.padEnd(32)} ${entry.baseline ?? '-'} → ${entry.current ?? '-'}${entry.critical ? '  critical' : ''}`;
    const emoji = COMPARISON_EMOJI[entry.comparison];
    console.log(`  ${emoji === undefined ? outcomeMark(entry.current, line) : mark(emoji, line)}`);
    if (result !== undefined && result.outcome !== 'PASS') {
      for (const attempt of result.attempts.filter((candidate) => candidate.outcome !== 'PASS')) {
        const failed = attempt.harnessError ?? attempt.graders.filter((grader) => grader.passed === false).map((grader) => `${grader.grader}: ${grader.detail}`).join('; ');
        console.log(`      #${attempt.attempt} ${failed}`);
      }
    }
  }
  if (comparison.releaseBlocked) console.log(`\n${flag('A critical safety case regressed: the JERRY release is blocked.', EMOJI.blocked)}`);
  else if (comparison.regressions.length > 0) console.log(`\n${flag(`Regressions: ${comparison.regressions.join(', ')}`, EMOJI.blocked)}`);
}

export async function listRuns(): Promise<void> {
  const runs = z.array(evalRunSummarySchema).parse(await callCore('GET', '/api/v1/evals/runs'));
  if (runs.length === 0) console.log(mark('info', 'No eval runs yet: jerry eval run'));
  for (const run of runs) {
    const outcome = run.counts.FAIL + run.counts.ERROR > 0 ? 'FAIL' : run.counts.FLAKY > 0 ? 'FLAKY' : 'PASS';
    console.log(outcomeMark(outcome, `${run.runId.padEnd(8)} ${run.finishedAt}  PASS ${run.counts.PASS} FAIL ${run.counts.FAIL} FLAKY ${run.counts.FLAKY} ERROR ${run.counts.ERROR}${run.isBaseline ? '  baseline' : ''}  ${run.label}`));
  }
}

export async function showRun(runId: string): Promise<void> {
  printRun(evalRunDetailSchema.parse(await callCore('GET', `/api/v1/evals/runs/${encodeURIComponent(runId.toUpperCase())}`)));
}

export async function evalStatus(): Promise<void> {
  const status = evalStatusSchema.parse(await callCore('GET', '/api/v1/evals/status'));
  const calibration = evalCalibrationSchema.parse(await callCore('GET', '/api/v1/evals/calibration'));
  console.log(mark('evals', `Baseline: ${status.baselineRunId ?? 'none (set one with jerry eval baseline <runId>)'} · latest run: ${status.latestRunId ?? 'none'}`));
  console.log(status.changedSinceBaseline.length === 0 ? mark('pass', 'Nothing JERRY ships changed since the baseline.') : mark('warning', `Changed since the baseline: ${status.changedSinceBaseline.join(', ')}: run the evals again (jerry eval run).`));
  if (status.releaseBlocked) console.log(flag('The latest run has a critical safety regression: the release is blocked.', EMOJI.blocked));
  for (const entry of calibration) console.log(mark(entry.calibrated ? 'pass' : 'waiting', `Rubric ${entry.rubricId}: ${entry.labels} label(s), ${(entry.agreement * 100).toFixed(0)}% agreement, ${entry.calibrated ? 'calibrated' : 'not calibrated yet (needs 80% over 10 labels)'}`));
}

function requireTerminal(what: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${what} requires an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".`);
}

/** The user's decision: a new baseline hides nothing only when someone looked. */
export async function setBaseline(runId: string, options: { note?: string }): Promise<void> {
  requireTerminal('Setting the eval baseline');
  const id = runId.toUpperCase();
  await showRun(id);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const note = options.note?.trim() || (await prompt.question('\nWhy is this the new baseline? ')).trim();
    if (note === '') throw new Error('A reason is required; nothing changed.');
    if ((await prompt.question(`Type ${id} to make it the baseline: `)).trim().toUpperCase() !== id) {
      console.log(mark('fail', 'Confirmation did not match. Nothing was recorded.'));
      process.exitCode = 1;
      return;
    }
    await callCore('POST', '/api/v1/evals/baseline', { runId: id, note });
    console.log(mark('pass', `${id} is the eval baseline.`));
  } finally {
    prompt.close();
  }
}

/** A human verdict on a rubric grader's result, for calibration. */
export async function labelRun(runId: string, caseId: string, attempt: string, rubricId: string, verdict: string): Promise<void> {
  requireTerminal('Labelling an eval result');
  if (verdict !== 'pass' && verdict !== 'fail') throw new Error('The verdict is "pass" or "fail".');
  const calibration = evalCalibrationSchema.parse(await callCore('POST', '/api/v1/evals/labels', { runId: runId.toUpperCase(), caseId, attempt: Number(attempt), rubricId, humanPassed: verdict === 'pass' }));
  const entry = calibration.find((candidate) => candidate.rubricId === rubricId);
  console.log(mark('pass', `Labelled. Rubric ${rubricId}: ${entry?.labels ?? 0} label(s), ${((entry?.agreement ?? 0) * 100).toFixed(0)}% agreement, ${entry?.calibrated ? 'calibrated' : 'not calibrated yet'}.`));
}

/**
 * Claude Code's own plugin evals for JERRY's plugin, in an isolated JERRY home so the
 * plugin's hooks never reach the user's JERRY data, and never published (--no-publish).
 */
export function runPluginEval(options: { runs?: number; trust: boolean }): void {
  const claude = findClaudeBinary();
  if (claude === null) throw new Error('Claude Code CLI not found; set JERRY_CLAUDE_BIN.');
  const help = spawnSync(claude.path, ['plugin', 'eval', '--help'], { encoding: 'utf8', windowsHide: true });
  if (help.status !== 0) {
    console.log(resultMark('NOT_RUN', 'NOT_AVAILABLE: this Claude Code version has no "claude plugin eval"; JERRY\'s own evals still run (jerry eval run).'));
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-plugin-eval-'));
  const output = path.join(home, 'results');
  const args = ['plugin', 'eval', PLUGIN_DIR, '--no-publish', '--output-dir', output, '--report', path.join(output, 'report.html'), ...(options.runs === undefined ? [] : ['--runs', String(options.runs)]), ...(options.trust ? ['--trust-plugin'] : [])];
  console.log(mark('evals', `claude ${args.join(' ')}  (JERRY_HOME=${home})`));
  const run = spawnSync(claude.path, args, { stdio: 'inherit', env: { ...process.env, JERRY_HOME: home }, windowsHide: true });
  console.log(`\n${mark('report', `Results and the HTML report are in ${output} (not published).`)}`);
  process.exitCode = run.status ?? 1;
}
