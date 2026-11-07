import type { ApprovalRecord } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { DecisionWaits } from '../src/decision-wait.js';
import type { StateStore } from '../src/state-store.js';

type Lookup = { decision: ApprovalRecord | null; state: string };

/** A store that answers decisionOn from a mutable value and counts the lookups. */
function fakeStore(initial: Lookup): { store: StateStore; set(next: Lookup): void; lookups(): number; asked: Array<[string, string, number]> } {
  let current = initial;
  const asked: Array<[string, string, number]> = [];
  const store = {
    decisionOn: async (taskId: string, stage: string, version: number) => {
      asked.push([taskId, stage, version]);
      return current;
    },
  } as unknown as StateStore;
  return { store, set: (next) => (current = next), lookups: () => asked.length, asked };
}

const decision = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approvalId: 'apr_1',
  taskId: 'JRY-0001',
  stage: 'PLAN',
  version: 2,
  contentHash: `sha256:${'a'.repeat(64)}`,
  decision: 'APPROVED',
  approvedBy: 'local-user',
  approvedAt: '2026-11-07T10:00:00.000Z',
  comment: '',
  ...overrides,
});

const never = new AbortController().signal;

describe('DecisionWaits', () => {
  it('answers at once with an existing decision, mapping the stage to the approval stage', async () => {
    const fake = fakeStore({ decision: decision({ stage: 'IMPLEMENTATION', review: false }), state: 'DONE' });
    const result = await new DecisionWaits(fake.store, 10).wait({ taskId: 'JRY-0001', stage: 'implementation', version: 2, waitMs: 60_000, signal: never });
    expect(result).toEqual({ taskId: 'JRY-0001', stage: 'implementation', version: 2, status: 'approved', decidedAt: '2026-11-07T10:00:00.000Z', review: false, state: 'DONE' });
    expect(fake.asked).toEqual([['JRY-0001', 'IMPLEMENTATION', 2]]);
  });

  it('keeps polling until the decision arrives, with the comment of a rejection', async () => {
    const fake = fakeStore({ decision: null, state: 'WAIT_REVIEW_FIX_APPROVAL' });
    const waiting = new DecisionWaits(fake.store, 10).wait({ taskId: 'JRY-0001', stage: 'review-fix', version: 1, waitMs: 5_000, signal: never });
    setTimeout(() => fake.set({ decision: decision({ stage: 'REVIEW_FIX', version: 1, decision: 'REJECTED', comment: 'Keep the old API' }), state: 'REVIEW_REPORT' }), 50);
    expect(await waiting).toMatchObject({ status: 'rejected', comment: 'Keep the old API', state: 'REVIEW_REPORT' });
    expect(fake.asked.every(([, stage]) => stage === 'REVIEW_FIX')).toBe(true);
  });

  it("answers 'pending' after the bound", async () => {
    const fake = fakeStore({ decision: null, state: 'WAIT_PLAN_APPROVAL' });
    const started = Date.now();
    const result = await new DecisionWaits(fake.store, 10).wait({ taskId: 'JRY-0001', stage: 'plan', version: 2, waitMs: 120, signal: never });
    expect(result).toEqual({ taskId: 'JRY-0001', stage: 'plan', version: 2, status: 'pending', state: 'WAIT_PLAN_APPROVAL' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('stops at once for a cancelled task: no decision will come', async () => {
    const fake = fakeStore({ decision: null, state: 'CANCELLED' });
    const result = await new DecisionWaits(fake.store, 10).wait({ taskId: 'JRY-0001', stage: 'plan', version: 2, waitMs: 60_000, signal: never });
    expect(result).toMatchObject({ status: 'pending', state: 'CANCELLED' });
    expect(fake.lookups()).toBe(1);
  });

  it('stops polling when the client goes away', async () => {
    const fake = fakeStore({ decision: null, state: 'WAIT_PLAN_APPROVAL' });
    const gone = new AbortController();
    const waiting = new DecisionWaits(fake.store, 10).wait({ taskId: 'JRY-0001', stage: 'plan', version: 2, waitMs: 60_000, signal: gone.signal });
    setTimeout(() => gone.abort(), 50);
    expect(await waiting).toMatchObject({ status: 'pending' });
    const after = fake.lookups();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.lookups()).toBe(after);
  });

  it('ends every open wait when Core closes', async () => {
    const fake = fakeStore({ decision: null, state: 'WAIT_PLAN_APPROVAL' });
    const waits = new DecisionWaits(fake.store, 10);
    const first = waits.wait({ taskId: 'JRY-0001', stage: 'plan', version: 2, waitMs: 60_000, signal: never });
    const second = waits.wait({ taskId: 'JRY-0002', stage: 'plan', version: 1, waitMs: 60_000, signal: never });
    await new Promise((resolve) => setTimeout(resolve, 30));
    waits.abortAll();
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual(['pending', 'pending']);
  });

  it('treats a negative wait as none: one look, then the answer', async () => {
    const fake = fakeStore({ decision: null, state: 'WAIT_PLAN_APPROVAL' });
    expect(await new DecisionWaits(fake.store, 10).wait({ taskId: 'JRY-0001', stage: 'plan', version: 2, waitMs: -5, signal: never })).toMatchObject({ status: 'pending' });
    expect(fake.lookups()).toBe(1);
  });
});
