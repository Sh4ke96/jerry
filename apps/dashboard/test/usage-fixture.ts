import type { UsageSummary, UsageTotals } from '@jerry/contracts';

const MINUTE = 60_000;

/** An ISO time `minutes` from now (negative: in the past). */
export const minutesFromNow = (minutes: number): string => new Date(Date.now() + minutes * MINUTE).toISOString();

const totals = (tokens: number, costUsd: number): UsageTotals => ({ input: tokens * 0.1, output: tokens * 0.05, cacheRead: tokens * 0.8, cacheCreation: tokens * 0.05, tokens, costUsd });

/** Local YYYY-MM-DD of `days` ago. */
function day(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A usage summary as Core answers it: the 5-hour window at 23 % resetting in 2 h 14 min, the week
 * at 41 %, both read 10 minutes ago in a terminal session; tokens from VS Code and the terminal.
 */
export function sampleUsage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  const readAt = minutesFromNow(-10);
  return {
    collection: { statusline: 'on', telemetry: 'on', showBar: true },
    sources: {
      statusline: { lastAt: readAt, byEntrypoint: { cli: readAt } },
      telemetry: { lastAt: minutesFromNow(-2), byEntrypoint: { 'claude-vscode': minutesFromNow(-2), cli: minutesFromNow(-30) } },
    },
    limits: {
      // 2 h 14 min minus a few seconds, so the minutes round up to exactly 134.
      fiveHour: { pct: 23, resetsAt: new Date(Date.now() + 134 * MINUTE - 20_000).toISOString(), readAt, entrypoint: 'cli' },
      sevenDay: { pct: 41, resetsAt: minutesFromNow(3 * 24 * 60), readAt, entrypoint: 'cli' },
    },
    totals: { today: totals(120_000, 0.42), last7d: totals(2_400_000, 7.5), last30d: totals(9_800_000, 31.25) },
    byModel: [
      { model: 'claude-opus-4-5', tokens: 7_000_000, costUsd: 25 },
      { model: 'claude-haiku-4-5', tokens: 2_800_000, costUsd: 6.25 },
    ],
    byProject: [{ repoRoot: 'D:\\Work\\shop', name: 'shop', tokens: 9_800_000, costUsd: 31.25 }],
    byEntrypoint: [
      { entrypoint: 'claude-vscode', tokens: 6_000_000, costUsd: 20 },
      { entrypoint: 'cli', tokens: 3_800_000, costUsd: 11.25 },
    ],
    daily: Array.from({ length: 30 }, (_, index) => ({ date: day(29 - index), tokens: index % 3 === 0 ? 0 : (index + 1) * 10_000, costUsd: index % 3 === 0 ? 0 : index * 0.1 })),
    jerryShare: { chars30d: 49_200, estimatedTokens30d: 12_300, sessionStart: 30_000, warnings: 9_200, mcp: 10_000 },
    ...overrides,
  };
}

/** Nothing collected yet. */
export function emptyUsage(overrides: Partial<UsageSummary> = {}): UsageSummary {
  const zero = totals(0, 0);
  return sampleUsage({
    sources: { statusline: { lastAt: null, byEntrypoint: {} }, telemetry: { lastAt: null, byEntrypoint: {} } },
    limits: { fiveHour: null, sevenDay: null },
    totals: { today: zero, last7d: zero, last30d: zero },
    byModel: [],
    byProject: [],
    byEntrypoint: [],
    daily: sampleUsage().daily.map((entry) => ({ ...entry, tokens: 0, costUsd: 0 })),
    jerryShare: { chars30d: 0, estimatedTokens30d: 0, sessionStart: 0, warnings: 0, mcp: 0 },
    ...overrides,
  });
}
