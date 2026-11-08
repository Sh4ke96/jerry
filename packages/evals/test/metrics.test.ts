import { describe, expect, it } from 'vitest';
import { evalCaseSchema, sessionArgs, variantsOf } from '../src/index.js';
import { metricDeltas, variantMetrics, type AttemptMetricsInput } from '../src/results.js';
import { parseTranscript, searchCalls, totalTokens } from '../src/transcript.js';

const line = (value: unknown): string => JSON.stringify(value);

describe('session transcript (stream-json)', () => {
  it('reads tokens of every model, turns, cost, tool calls and the loaded plugins', () => {
    const stdout = [
      line({ type: 'system', subtype: 'init', session_id: 's1', plugins: [{ name: 'jerry', path: '/p' }], mcp_servers: [{ name: 'plugin:jerry:guardian', status: 'connected' }] }),
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'Grep' }, { type: 'tool_use', id: 't2', name: 'Read' }] } }),
      // Parallel calls share the message id and arrive again: each block counts once.
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't2', name: 'Read' }] } }),
      line({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't3', name: 'mcp__plugin_jerry_guardian__get_history' }] } }),
      'not json',
      line({
        type: 'result',
        result: 'done',
        session_id: 's1',
        total_cost_usd: 0.42,
        num_turns: 4,
        duration_ms: 9000,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
        modelUsage: { opus: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10 }, haiku: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      }),
    ].join('\n');
    const transcript = parseTranscript(stdout);
    expect(transcript).toMatchObject({ finished: true, output: 'done', sessionId: 's1', costUsd: 0.42, turns: 4, durationMs: 9000, plugins: ['jerry'], mcpServers: ['plugin:jerry:guardian'] });
    // modelUsage covers subagents: preferred over the main loop's usage.
    expect(transcript.tokens).toEqual({ input: 120, output: 55, cacheRead: 1000, cacheCreation: 10 });
    expect(totalTokens(transcript.tokens)).toBe(1185);
    expect(transcript.toolCalls).toEqual({ Grep: 1, Read: 1, mcp__plugin_jerry_guardian__get_history: 1 });
    expect(searchCalls(transcript.toolCalls)).toBe(2);
  });

  it('falls back to usage, reads a plain json result, and says when there is none', () => {
    expect(parseTranscript(line({ type: 'result', result: 'x', usage: { input_tokens: 3, output_tokens: 2 } })).tokens).toEqual({ input: 3, output: 2, cacheRead: 0, cacheCreation: 0 });
    expect(parseTranscript(line({ result: 'plain', session_id: 's', total_cost_usd: 0.1 }))).toMatchObject({ finished: true, output: 'plain', costUsd: 0.1, tokens: null, turns: null, plugins: null });
    expect(parseTranscript('').finished).toBe(false);
    expect(parseTranscript(line({ type: 'assistant', message: { content: [] } })).finished).toBe(false);
  });
});

describe('cost and work per variant', () => {
  const attempt = (variant: string, outcome: AttemptMetricsInput['outcome'], cost: number | null, tokens: number, calls: Record<string, number>): AttemptMetricsInput => ({
    variant,
    outcome,
    costUsd: cost,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheCreation: 0 },
    turns: 3,
    toolCalls: calls,
    sessionMs: 1000,
  });

  it('gives pass rate and mean/min/max per variant; errors do not count for the pass rate', () => {
    const metrics = variantMetrics([
      attempt('jerry', 'PASS', 0.1, 1000, { Read: 1, mcp__plugin_jerry_guardian__get_history: 1 }),
      attempt('jerry', 'FAIL', 0.3, 3000, { Read: 3, Grep: 1 }),
      attempt('no-plugin', 'PASS', 0.5, 5000, { Read: 6, Grep: 4 }),
      attempt('no-plugin', 'ERROR', null, 0, {}),
    ]);
    expect(metrics.map((entry) => entry.variant)).toEqual(['jerry', 'no-plugin']);
    expect(metrics[0]).toMatchObject({ attempts: 2, passRate: 0.5, costUsd: { mean: 0.2, min: 0.1, max: 0.3, n: 2 }, tokens: { mean: 2000 }, searchCalls: { mean: 2.5, min: 1, max: 4 }, jerryCalls: { mean: 0.5 } });
    expect(metrics[1]).toMatchObject({ attempts: 2, passRate: 1, costUsd: { mean: 0.5, n: 1 }, searchCalls: { mean: 10, n: 1 } });
    // Older attempts without metrics give nulls, not zeros.
    expect(variantMetrics([{ outcome: 'PASS', costUsd: null }])[0]).toMatchObject({ variant: 'jerry', passRate: 1, costUsd: null, tokens: null, toolCalls: null });
  });

  it('compares mean cost and tokens with the baseline per case and variant', () => {
    const before = new Map([['case-a', variantMetrics([attempt('jerry', 'PASS', 0.2, 2000, {})])]]);
    const now = new Map([
      ['case-a', variantMetrics([attempt('jerry', 'PASS', 0.1, 1500, {}), attempt('no-plugin', 'PASS', 0.4, 4000, {})])],
      ['case-new', variantMetrics([attempt('jerry', 'PASS', 0.1, 100, {})])],
    ]);
    expect(metricDeltas(before, now)).toEqual([{ caseId: 'case-a', variant: 'jerry', costUsd: expect.closeTo(-0.1, 6), tokens: -500, costRatio: expect.closeTo(-0.5, 6) }]);
  });
});

describe('variants of a case', () => {
  const base = { id: 'x', title: 'x', suite: 'capability', kind: 'repo-discovery', fixture: {}, session: { prompt: 'p' } };

  it('defaults to one variant with the plugin, and checks the variants graders name', () => {
    const plain = evalCaseSchema.parse({ ...base, graders: [{ type: 'git-unchanged' }] });
    expect(variantsOf(plain, true)).toEqual([{ id: 'jerry', description: '', plugin: true, disallowedTools: [] }]);
    expect(evalCaseSchema.safeParse({ ...base, graders: [{ type: 'git-unchanged', variants: ['nope'] }] }).success).toBe(false);
    expect(evalCaseSchema.safeParse({ ...base, variants: [{ id: 'a' }, { id: 'a' }], graders: [{ type: 'git-unchanged' }] }).success).toBe(false);
  });

  it('builds the session arguments per variant: plugin or not, tools turned off, model, isolation', () => {
    const evalCase = evalCaseSchema.parse({ ...base, session: { prompt: 'p', model: 'sonnet', maxTurns: 12 }, variants: [{ id: 'jerry' }, { id: 'bare', plugin: false, disallowedTools: ['mcp__x'], model: 'opus' }], graders: [{ type: 'budget', maxCostUsd: 1 }] });
    const [jerry, bare] = variantsOf(evalCase, true);
    const withPlugin = sessionArgs(evalCase, jerry!, { pluginDir: '/plugin' });
    expect(withPlugin).toEqual(expect.arrayContaining(['--plugin-dir', '/plugin', '--setting-sources', 'project,local', '--model', 'sonnet', '--max-budget-usd', '1', '--max-turns', '12', '--output-format', 'stream-json', '--verbose']));
    const without = sessionArgs(evalCase, bare!, { pluginDir: '/plugin' });
    expect(without).not.toContain('--plugin-dir');
    expect(without).toEqual(expect.arrayContaining(['--model', 'opus', '--disallowedTools', 'mcp__x']));
    expect(without).not.toContain('--bare');
    // --model on the command line overrides every variant.
    expect(sessionArgs(evalCase, bare!, { pluginDir: '/plugin', model: 'haiku' })).toEqual(expect.arrayContaining(['--model', 'haiku']));
  });
});
