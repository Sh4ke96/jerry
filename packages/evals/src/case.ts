import fs from 'node:fs';
import path from 'node:path';
import { WORKFLOW_STATES } from '@jerry/contracts';
import { z } from 'zod';

/**
 * Golden cases: one prompt against a fixture repository, the JERRY state it
 * starts from, and the graders that decide the result. Cases live in `evals/cases/*.json`, versioned
 * with JERRY; results and baselines live in JERRY's database, outside any project.
 */

/** The eval suite kinds. */
export const EVAL_KINDS = [
  'plugin-behavior',
  'approval-gates',
  'repo-discovery',
  'planning-quality',
  'tool-safety',
  'quality-lint',
  'code-review',
  'multi-repo-contracts',
  'final-report',
  'session-recovery',
] as const;

const relativePath = z
  .string()
  .min(1)
  .refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), 'a repo-relative path without ".."');

export const graderSchema = z.discriminatedUnion('type', [
  /** Claude's final answer matches (or must not match) a regular expression. */
  z.object({ type: z.literal('output-matches'), pattern: z.string().min(1), flags: z.string().regex(/^[imsu]*$/).default('i'), negate: z.boolean().default(false) }),
  /** A file in the fixture exists or not, and contains (or not) a text. */
  z.object({ type: z.literal('file'), path: relativePath, exists: z.boolean().default(true), contains: z.string().optional(), notContains: z.string().optional() }),
  /** HEAD did not move and nothing is staged: Git stayed with the user. */
  z.object({ type: z.literal('git-unchanged') }),
  /** Gate decisions JERRY recorded in the session: how many match tool, verdict and rule. */
  z.object({
    type: z.literal('gate'),
    tool: z.string().optional(),
    verdict: z.enum(['PASS', 'WARN', 'DENY']).optional(),
    rule: z.string().optional(),
    min: z.number().int().nonnegative().default(1),
    max: z.number().int().nonnegative().optional(),
  }),
  /** A tool (or subagent type) was used in the session, or must not be. */
  z.object({ type: z.literal('tool-used'), tool: z.string().min(1), negate: z.boolean().default(false) }),
  /** The state of the case's task at the end. */
  z.object({ type: z.literal('task-state'), state: z.enum(WORKFLOW_STATES) }),
  /** Every file the session changed lies inside these globs. */
  z.object({ type: z.literal('paths-allowlist'), allow: z.array(z.string().min(1)).min(1) }),
  /** Execution grader: a command in the fixture repository must exit with this code. */
  z.object({ type: z.literal('command'), run: z.string().min(1), expectExit: z.number().int().default(0), timeoutMs: z.number().int().positive().default(60_000) }),
  /** LLM rubric grader: a pinned model scores the output against the rubric (counts only when calibrated). */
  z.object({ type: z.literal('rubric'), id: z.string().regex(/^[a-z0-9-]+$/), rubric: z.string().min(1), threshold: z.number().min(0).max(1).default(0.7), model: z.string().default('haiku') }),
  /** The session's reported cost stays within a budget (US dollars). */
  z.object({ type: z.literal('budget'), maxCostUsd: z.number().positive() }),
]);
export type Grader = z.infer<typeof graderSchema>;

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  description: z.string().default(''),
  /** regression: must keep working; capability: should get better. */
  suite: z.enum(['regression', 'capability']),
  kind: z.enum(EVAL_KINDS),
  /** A safety case: its regression blocks a JERRY release. */
  critical: z.boolean().default(false),
  fixture: z.object({
    /** Committed in the initial commit. */
    files: z.record(relativePath, z.string()).default({}),
    /** Changed after the commit: the user's uncommitted work. */
    uncommitted: z.record(relativePath, z.string()).default({}),
  }),
  setup: z
    .object({
      /** A task created before the session; approved when asked. */
      task: z.object({ title: z.string().min(1), scope: z.array(z.string().min(1)).min(1), approve: z.boolean().default(true) }).optional(),
    })
    .default({}),
  session: z.object({
    prompt: z.string().min(1),
    allowedTools: z.array(z.string().min(1)).default([]),
    model: z.string().default('haiku'),
    timeoutMs: z.number().int().positive().max(1_800_000).default(300_000),
  }),
  graders: z.array(graderSchema).min(1),
  /** Default: 3 when an AI grader is involved, otherwise 1. */
  repeats: z.number().int().min(1).max(10).optional(),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

/** Repeats of a case: given, or 3 for cases with a rubric grader, else 1 (the model still varies, so live cases default to 1). */
export function repeatsOf(evalCase: EvalCase): number {
  return evalCase.repeats ?? (evalCase.graders.some((grader) => grader.type === 'rubric') ? 3 : 1);
}

export interface LoadedCases {
  cases: EvalCase[];
  /** Files that failed validation, with the reason; a broken case never runs silently. */
  errors: Array<{ file: string; error: string }>;
}

/** Reads every `*.json` case in a directory; ids must be unique. */
export function loadCases(directory: string): LoadedCases {
  const cases: EvalCase[] = [];
  const errors: LoadedCases['errors'] = [];
  const seen = new Map<string, string>();
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort() : [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    } catch (error) {
      errors.push({ file, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const parsed = evalCaseSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push({ file, error: z.prettifyError(parsed.error) });
      continue;
    }
    const previous = seen.get(parsed.data.id);
    if (previous !== undefined) {
      errors.push({ file, error: `case id ${parsed.data.id} is already used by ${previous}` });
      continue;
    }
    seen.set(parsed.data.id, file);
    cases.push(parsed.data);
  }
  return { cases, errors };
}
