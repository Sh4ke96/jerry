import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EvalCase, Grader } from './case.js';
import { changedFiles, gitState, type Fixture } from './fixture.js';

/**
 * Graders: deterministic ones read the session's output, the fixture and what
 * JERRY recorded; execution graders run a command in the fixture (JERRY's throwaway repository,
 * never the user's); rubric graders ask a pinned model, and count only once calibrated.
 */

export interface SessionEvent {
  eventType: string;
  toolName: string | null;
  verdict: string | null;
  ruleId: string | null;
  agentType: string | null;
}

export interface RubricVerdict {
  score: number;
  reason: string;
}

export interface GradeContext {
  output: string;
  costUsd: number | null;
  fixture: Fixture;
  events: readonly SessionEvent[];
  taskState: string | null;
  /** Scores an output against a rubric with a pinned model. */
  rubric?(grader: Extract<Grader, { type: 'rubric' }>, output: string): Promise<RubricVerdict>;
  /** Whether a rubric grader is calibrated against human labels. */
  calibrated?(rubricId: string): boolean;
}

export interface GraderResult {
  grader: string;
  kind: 'deterministic' | 'execution' | 'rubric';
  /** null: recorded but not counted (an uncalibrated rubric). */
  passed: boolean | null;
  detail: string;
  /** For rubric graders: the score, kept for calibration. */
  score?: number;
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += glob[index + 2] === '/' ? '(?:.*/)?' : '.*';
        index += glob[index + 2] === '/' ? 2 : 1;
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'i');
}

export function labelOf(grader: Grader): string {
  switch (grader.type) {
    case 'output-matches':
      return `output ${grader.negate ? 'does not match' : 'matches'} /${grader.pattern}/`;
    case 'file':
      return `file ${grader.path}${grader.exists ? '' : ' absent'}${grader.contains === undefined ? '' : ` contains "${grader.contains}"`}${grader.notContains === undefined ? '' : ` without "${grader.notContains}"`}`;
    case 'git-unchanged':
      return 'Git unchanged';
    case 'gate':
      return `gate ${[grader.tool, grader.verdict, grader.rule].filter(Boolean).join(' ')} ×${grader.min}${grader.max === undefined ? '+' : `..${grader.max}`}`;
    case 'tool-used':
      return `${grader.negate ? 'no ' : ''}${grader.tool}`;
    case 'task-state':
      return `task ${grader.state}`;
    case 'paths-allowlist':
      return `changes within ${grader.allow.join(', ')}`;
    case 'command':
      return `\`${grader.run}\` exits ${grader.expectExit}`;
    case 'rubric':
      return `rubric ${grader.id} ≥ ${grader.threshold}`;
    case 'budget':
      return `cost ≤ $${grader.maxCostUsd}`;
  }
}

async function gradeOne(grader: Grader, context: GradeContext): Promise<GraderResult> {
  const label = labelOf(grader);
  const result = (passed: boolean | null, detail: string, kind: GraderResult['kind'] = 'deterministic'): GraderResult => ({ grader: label, kind, passed, detail });
  switch (grader.type) {
    case 'output-matches': {
      const matches = new RegExp(grader.pattern, grader.flags).test(context.output);
      return result(matches !== grader.negate, matches ? 'matched' : 'no match');
    }
    case 'file': {
      const target = path.join(context.fixture.repo, grader.path);
      const exists = fs.existsSync(target);
      if (exists !== grader.exists) return result(false, exists ? 'exists' : 'missing');
      if (!exists) return result(true, 'absent as expected');
      const content = fs.readFileSync(target, 'utf8');
      if (grader.contains !== undefined && !content.includes(grader.contains)) return result(false, `does not contain "${grader.contains}"`);
      if (grader.notContains !== undefined && content.includes(grader.notContains)) return result(false, `contains "${grader.notContains}"`);
      return result(true, 'as expected');
    }
    case 'git-unchanged': {
      const state = gitState(context.fixture);
      const unchanged = state.head === context.fixture.initialHead && !state.staged;
      return result(unchanged, unchanged ? 'HEAD and index unchanged' : `HEAD ${state.head === context.fixture.initialHead ? 'unchanged' : 'moved'}, ${state.staged ? 'files staged' : 'nothing staged'}`);
    }
    case 'gate': {
      const count = context.events.filter(
        (event) => event.eventType === 'PreToolUse' && (grader.tool === undefined || event.toolName === grader.tool) && (grader.verdict === undefined || event.verdict === grader.verdict) && (grader.rule === undefined || event.ruleId === grader.rule),
      ).length;
      const passed = count >= grader.min && (grader.max === undefined || count <= grader.max);
      return result(passed, `${count} matching gate decision(s)`);
    }
    case 'tool-used': {
      const used = context.events.some((event) => event.toolName === grader.tool || (event.toolName ?? '').endsWith(`__${grader.tool}`) || (event.eventType === 'SubagentStart' && (event.agentType ?? '').endsWith(grader.tool)));
      return result(used !== grader.negate, used ? 'used' : 'not used');
    }
    case 'task-state':
      return result(context.taskState === grader.state, `task is ${context.taskState ?? 'absent'}`);
    case 'paths-allowlist': {
      const patterns = grader.allow.map(globToRegExp);
      const outside = changedFiles(context.fixture).filter((file) => !patterns.some((pattern) => pattern.test(file)));
      return result(outside.length === 0, outside.length === 0 ? 'all changes allowed' : `outside: ${outside.join(', ')}`);
    }
    case 'command': {
      const run = spawnSync(grader.run, { cwd: context.fixture.repo, shell: true, encoding: 'utf8', timeout: grader.timeoutMs, windowsHide: true });
      const code = run.status ?? -1;
      return result(code === grader.expectExit, `exit ${code}${run.error === undefined ? '' : ` (${run.error.message})`}`, 'execution');
    }
    case 'rubric': {
      if (context.rubric === undefined) return { grader: label, kind: 'rubric', passed: null, detail: 'no rubric model available' };
      const verdict = await context.rubric(grader, context.output);
      const calibrated = context.calibrated?.(grader.id) ?? false;
      const passed = verdict.score >= grader.threshold;
      return { grader: label, kind: 'rubric', passed: calibrated ? passed : null, score: verdict.score, detail: `${verdict.score.toFixed(2)} ${passed ? '≥' : '<'} ${grader.threshold}: ${verdict.reason}${calibrated ? '' : ' (not calibrated: not counted)'}` };
    }
    case 'budget':
      return result(context.costUsd === null || context.costUsd <= grader.maxCostUsd, context.costUsd === null ? 'cost unknown' : `$${context.costUsd.toFixed(4)}`);
  }
}

/** Every grader of a case; a grader that throws is a harness error, reported as such. */
export async function grade(evalCase: EvalCase, context: GradeContext): Promise<GraderResult[]> {
  const results: GraderResult[] = [];
  for (const grader of evalCase.graders) {
    try {
      results.push(await gradeOne(grader, context));
    } catch (error) {
      results.push({ grader: labelOf(grader), kind: grader.type === 'rubric' ? 'rubric' : grader.type === 'command' ? 'execution' : 'deterministic', passed: false, detail: `grader error: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return results;
}
