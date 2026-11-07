import { setTimeout as delay } from 'node:timers/promises';
import { DECISION_WAIT_MAX_MS, type ApprovalRecord, type DecisionWaitResult, type DecisionWaitStage } from '@jerry/contracts';
import { isTerminal } from '@jerry/workflow';
import type { StateStore } from './state-store.js';

/**
 * Claude waiting for the user's decision after it submitted a plan, a report or a fix plan (the MCP
 * tool wait_for_decision). A long poll over the store's in-memory state: Core has no event emitter for
 * approvals, and a decision reloads that state in the same process, so a check per second costs next
 * to nothing. Strictly read-only: waiting never records, approves or changes anything.
 */

const STAGES: Readonly<Record<DecisionWaitStage, ApprovalRecord['stage']>> = { plan: 'PLAN', implementation: 'IMPLEMENTATION', 'review-fix': 'REVIEW_FIX' };

export const DECISION_POLL_MS = 1000;

export interface DecisionWaitRequest {
  taskId: string;
  stage: DecisionWaitStage;
  version: number;
  waitMs: number;
  /** Aborted when the client goes away; the wait then ends at once. */
  signal: AbortSignal;
}

export class DecisionWaits {
  /** Waits in flight, ended together when Core closes so shutdown is not held by a long poll. */
  private readonly running = new Set<AbortController>();

  constructor(
    private readonly store: StateStore,
    private readonly pollMs: number = DECISION_POLL_MS,
  ) {}

  async wait(request: DecisionWaitRequest): Promise<DecisionWaitResult> {
    const own = new AbortController();
    const stop = (): void => own.abort();
    request.signal.addEventListener('abort', stop, { once: true });
    if (request.signal.aborted) own.abort();
    this.running.add(own);
    try {
      return await this.poll(request, own.signal);
    } finally {
      this.running.delete(own);
      request.signal.removeEventListener('abort', stop);
    }
  }

  /** Ends every wait in flight; each answers 'pending'. */
  abortAll(): void {
    for (const controller of this.running) controller.abort();
  }

  private async poll(request: DecisionWaitRequest, signal: AbortSignal): Promise<DecisionWaitResult> {
    const { taskId, stage, version } = request;
    const deadline = Date.now() + Math.min(Math.max(request.waitMs, 0), DECISION_WAIT_MAX_MS);
    for (;;) {
      const { decision, state } = await this.store.decisionOn(taskId, STAGES[stage], version);
      if (decision !== null) {
        return {
          taskId,
          stage,
          version,
          status: decision.decision === 'APPROVED' ? 'approved' : 'rejected',
          ...(decision.comment === '' ? {} : { comment: decision.comment }),
          decidedAt: decision.approvedAt,
          ...(decision.review === undefined ? {} : { review: decision.review }),
          state,
        };
      }
      // No decision will come for a finished or cancelled task; the client left, Core closes, or time is up.
      const left = deadline - Date.now();
      if (isTerminal(state) || signal.aborted || left <= 0) return { taskId, stage, version, status: 'pending', state };
      try {
        await delay(Math.min(this.pollMs, left), undefined, { signal });
      } catch {
        // aborted: the next pass answers with what is there now
      }
    }
  }
}
