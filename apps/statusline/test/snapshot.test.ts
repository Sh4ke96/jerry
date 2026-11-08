import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { windowsGitBash } from '../src/chain.js';
import { formatSegment, hasRateLimits, MAX_INPUT_BYTES, parseStatusInput } from '../src/snapshot.js';

const NOW = new Date('2026-11-07T12:00:00.000Z');

/** A status-line payload as Claude Code documents it, for a Max plan after the first response. */
function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'session-1',
    transcript_path: '/never/read.jsonl',
    cwd: 'D:/Work/Repo',
    version: '2.1.90',
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    effort: { level: 'high' },
    workspace: { current_dir: 'D:/Work/Repo/src', project_dir: 'D:/Work/Repo' },
    cost: { total_cost_usd: 1.2, total_duration_ms: 1000, total_api_duration_ms: 500, total_lines_added: 3, total_lines_removed: 1 },
    context_window: { total_input_tokens: 15_234, total_output_tokens: 4_521, context_window_size: 200_000, used_percentage: 12.5, remaining_percentage: 87.5 },
    rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1_794_009_600 }, seven_day: { used_percentage: 41.2, resets_at: 1_794_441_600 } },
    ...overrides,
  });
}

describe('status-line snapshot', () => {
  it('reads every field JERRY keeps, with the windows and their reset times', () => {
    expect(parseStatusInput(payload(), 'claude-vscode', NOW)).toEqual({
      sessionId: 'session-1',
      cwd: 'D:/Work/Repo',
      model: 'Opus',
      version: '2.1.90',
      effort: 'high',
      fiveHour: { pct: 23.4, resetsAt: '2026-11-07T00:00:00.000Z' },
      sevenDay: { pct: 41.2, resetsAt: '2026-11-12T00:00:00.000Z' },
      costUsd: 1.2,
      inputTokens: 15_234,
      outputTokens: 4_521,
      contextUsedPct: 12.5,
      entrypoint: 'claude-vscode',
      at: NOW.toISOString(),
    });
  });

  it('leaves the windows out without rate_limits (no Pro/Max plan, or before the first response)', () => {
    const snapshot = parseStatusInput(payload({ rate_limits: undefined }), 'cli', NOW);
    expect(snapshot).not.toHaveProperty('fiveHour');
    expect(snapshot).not.toHaveProperty('sevenDay');
    expect(hasRateLimits(snapshot)).toBe(false);
    expect(snapshot?.costUsd).toBe(1.2);
  });

  it('keeps one window when only one is reported, and a window without a reset time', () => {
    const snapshot = parseStatusInput(payload({ rate_limits: { seven_day: { used_percentage: 80 } } }), null, NOW);
    expect(snapshot?.fiveHour).toBeUndefined();
    expect(snapshot?.sevenDay).toEqual({ pct: 80, resetsAt: null });
    expect(hasRateLimits(snapshot)).toBe(true);
  });

  it('drops fields of the wrong type instead of failing', () => {
    const snapshot = parseStatusInput(
      JSON.stringify({ session_id: 7, cwd: null, model: 'Opus', workspace: { current_dir: 'D:/Work' }, cost: { total_cost_usd: 'a lot' }, context_window: [], rate_limits: { five_hour: { used_percentage: Number.NaN }, seven_day: 'full' } }),
      null,
      NOW,
    );
    expect(snapshot).toEqual({ sessionId: null, cwd: 'D:/Work', model: null, version: null, entrypoint: null, at: NOW.toISOString() });
  });

  it('returns null for anything that is not a JSON object', () => {
    for (const raw of ['', 'not json', '[1,2]', 'null', '42', '"text"', '{"session_id":']) expect(parseStatusInput(raw, null, NOW), raw).toBeNull();
    expect(parseStatusInput(`{"pad":"${'x'.repeat(MAX_INPUT_BYTES)}"}`, null, NOW)).toBeNull();
  });
});

describe("JERRY's status-line segment", () => {
  it("shows the session's model and effort, the windows and the cost", () => {
    expect(formatSegment(parseStatusInput(payload(), null, NOW), true)).toBe('🛡️ JERRY · Opus · high · 5h 23% · week 41% · $1.20');
    expect(formatSegment(parseStatusInput(payload({ model: { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, effort: { level: 'xhigh' } }), null, NOW), false)).toBe('JERRY · Sonnet 5.5 · xhigh · 5h 23% · week 41% · $1.20');
  });

  it('leaves out what is absent or unknown, and the emoji when they are off', () => {
    const plain = { model: undefined, effort: undefined };
    expect(formatSegment(parseStatusInput(payload({ ...plain, rate_limits: undefined }), null, NOW), false)).toBe('JERRY · $1.20');
    expect(formatSegment(parseStatusInput(payload({ ...plain, rate_limits: { five_hour: { used_percentage: 99.6 } }, cost: undefined }), null, NOW), true)).toBe('🛡️ JERRY · 5h 100%');
    // A model without effort support: no effort; an unknown value is not shown.
    expect(formatSegment(parseStatusInput(payload({ effort: undefined, rate_limits: undefined, cost: undefined }), null, NOW), true)).toBe('🛡️ JERRY · Opus');
    expect(parseStatusInput(payload({ effort: { level: 'ludicrous' } }), null, NOW)).not.toHaveProperty('effort');
    expect(formatSegment(null, true)).toBe('🛡️ JERRY');
  });
});

describe('the shell for a chained status line on Windows', () => {
  it('prefers CLAUDE_CODE_GIT_BASH_PATH, then Git for Windows in Program Files', () => {
    const programFiles = path.join('C:', 'Program Files');
    const installed = path.join(programFiles, 'Git', 'bin', 'bash.exe');
    expect(windowsGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'E:/tools/bash.exe', ProgramFiles: programFiles }, () => true)).toBe('E:/tools/bash.exe');
    expect(windowsGitBash({ ProgramFiles: programFiles }, (file) => file === installed)).toBe(installed);
    expect(windowsGitBash({ ProgramFiles: programFiles }, () => false)).toBeNull();
  });
});
