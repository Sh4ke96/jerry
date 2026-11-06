import { describe, expect, it } from 'vitest';
import { isCoreRuntimeInfo, isGateDecision, isPreToolUseInput, isSessionRegistrationResponse, isSessionStartInput } from '../src/guards.js';
import { coreRuntimeInfoSchema, gateDecisionSchema, preToolUseInputSchema, sessionRegistrationResponseSchema, sessionStartInputSchema } from '../src/index.js';
import type { z } from 'zod';

/**
 * ADR 0010: the hook bridge validates with dependency-free guards instead of Zod. Each guard must
 * accept exactly what its schema accepts. Every fixture below is checked both ways.
 */

type Fixture = Record<string, unknown>;

/** The base object plus variants: each field removed, and each field replaced by unusual values. */
function variants(base: Fixture, replacements: Record<string, unknown[]>): unknown[] {
  const out: unknown[] = [base, { ...base, unexpected: 'extra field' }, null, 'text', [], 42];
  for (const key of Object.keys(base)) {
    const { [key]: _removed, ...rest } = base;
    out.push(rest);
  }
  for (const [key, values] of Object.entries(replacements)) {
    for (const value of values) out.push({ ...base, [key]: value });
  }
  return out;
}

const UNUSUAL = ['', ' ', 0, -1, 1.5, true, null, [], {}, 'x'];

function expectEquivalent(guard: (value: unknown) => boolean, schema: z.ZodType, fixtures: unknown[]): void {
  for (const fixture of fixtures) {
    expect(guard(fixture), JSON.stringify(fixture)).toBe(schema.safeParse(fixture).success);
  }
}

const hookCommon = { session_id: 's1', cwd: 'D:/Work', transcript_path: 'C:/t.jsonl', permission_mode: 'default', agent_id: 'a1', agent_type: 'reviewer' };
const commonReplacements = Object.fromEntries(Object.keys(hookCommon).map((key) => [key, UNUSUAL]));

describe('guards accept exactly what the Zod schemas accept', () => {
  it('PreToolUse input', () => {
    const base = { ...hookCommon, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.ts' }, tool_use_id: 'toolu_1' };
    expectEquivalent(
      isPreToolUseInput,
      preToolUseInputSchema,
      variants(base, { ...commonReplacements, hook_event_name: ['SessionStart', ...UNUSUAL], tool_name: UNUSUAL, tool_input: [...UNUSUAL, { nested: { deep: 1 } }], tool_use_id: UNUSUAL }),
    );
  });

  it('SessionStart input', () => {
    const base = { ...hookCommon, hook_event_name: 'SessionStart', source: 'startup' };
    expectEquivalent(isSessionStartInput, sessionStartInputSchema, variants(base, { ...commonReplacements, hook_event_name: ['PreToolUse', ...UNUSUAL], source: UNUSUAL }));
  });

  it('gate decision', () => {
    const base = { verdict: 'WARN', ruleId: 'monitor.out-of-scope', reason: 'outside the scope', taskId: 'JRY-0001', repoRoot: 'D:/Work' };
    expectEquivalent(isGateDecision, gateDecisionSchema, variants(base, { verdict: ['PASS', 'DENY', 'ASK', 'warn', ...UNUSUAL], ruleId: UNUSUAL, reason: UNUSUAL, taskId: UNUSUAL, repoRoot: UNUSUAL }));
  });

  it('session registration response', () => {
    const plan = { taskId: 'JRY-0001', planVersion: 2, scope: ['src/**'] };
    const base = { registered: true, repoRoot: 'D:/Work', excluded: false, approvedPlans: [plan] };
    expectEquivalent(
      isSessionRegistrationResponse,
      sessionRegistrationResponseSchema,
      variants(base, {
        registered: [false, ...UNUSUAL],
        repoRoot: UNUSUAL,
        excluded: UNUSUAL,
        approvedPlans: [
          ...UNUSUAL,
          [{ ...plan, taskId: 'JRY-1' }],
          [{ ...plan, taskId: 'JRY-00012' }],
          [{ ...plan, planVersion: 0 }],
          [{ ...plan, planVersion: 1.5 }],
          [{ ...plan, scope: [] }],
          [{ ...plan, scope: [''] }],
          [{ ...plan, scope: 'src/**' }],
          [plan, null],
        ],
      }),
    );
  });

  it('session registration response with open tasks to resume', () => {
    const checkpoint = { summary: 'Added the parser.', nextSteps: ['Write tests'], at: '2026-11-06T12:00:00.000Z' };
    const task = { taskId: 'JRY-0002', title: 'Parser', state: 'IMPLEMENTATION', planVersion: 1, scope: ['src/**'], coversEdits: true, workedInThisSession: false, lastActivityAt: '2026-11-06T12:00:00.000Z', checkpoint };
    const base = { registered: true, repoRoot: 'D:/Work', excluded: false, approvedPlans: [], openTasks: [task] };
    const taskVariants = variants(task, {
      taskId: ['JRY-1', ...UNUSUAL],
      title: UNUSUAL,
      state: ['DONE', 'PAUSED', 'implementation', 'UNKNOWN', ...UNUSUAL],
      planVersion: UNUSUAL,
      scope: [[''], ['src/**', 1], ...UNUSUAL],
      coversEdits: UNUSUAL,
      workedInThisSession: UNUSUAL,
      lastActivityAt: ['2026-11-06', '2026-11-06T12:00:00Z', ...UNUSUAL],
      checkpoint: [
        ...UNUSUAL,
        { ...checkpoint, summary: '' },
        { ...checkpoint, summary: 3 },
        { ...checkpoint, nextSteps: 'x' },
        { ...checkpoint, nextSteps: [1] },
        { ...checkpoint, at: 'yesterday' },
        { summary: 'x', nextSteps: [] },
      ],
    });
    expectEquivalent(
      isSessionRegistrationResponse,
      sessionRegistrationResponseSchema,
      [base, { ...base, openTasks: [] }, { ...base, openTasks: null }, { ...base, openTasks: task }, ...taskVariants.map((variant) => ({ ...base, openTasks: [task, variant] }))],
    );
  });

  it('Core runtime info', () => {
    const base = { pid: 1234, port: 47823, configuredPort: 47823, token: 'a'.repeat(64), startedAt: '2026-11-06T12:00:00.000Z', version: '0.0.1-m0' };
    expectEquivalent(
      isCoreRuntimeInfo,
      coreRuntimeInfoSchema,
      variants(base, {
        pid: [0, -5, 1.5, '1', null],
        port: [0, 1, 65535, 65536, 1.5, '47823'],
        configuredPort: [0, 65535, 65536, -1, 1.5, null, '0'],
        token: ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '', null],
        startedAt: ['2026-11-06T12:00:00Z', '2026-11-06T12:00:00.123456Z', '2026-11-06T12:00Z', '2026-11-06T12:00:00+01:00', '2026-11-06', 'yesterday', '', null],
        version: UNUSUAL,
      }),
    );
  });
});
