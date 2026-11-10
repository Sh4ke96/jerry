import { WORKFLOW_EVENTS, WORKFLOW_STATES, type WorkflowActor, type WorkflowEvent, type WorkflowState } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { applyEvent, availableEvents, effectiveReviewMode, isTerminal, resolveReviewChoice } from '../src/index.js';

const go = (current: WorkflowState | null, event: WorkflowEvent, actor: WorkflowActor = 'user', pausedFrom: WorkflowState | null = null, review?: boolean) =>
  applyEvent(current, event, actor, { pausedFrom, ...(review === undefined ? {} : { review }) });

describe('workflow transitions', () => {
  it('walks the happy path from plan to done', () => {
    expect(go(null, 'plan.submitted', 'claude')).toEqual({ ok: true, to: 'WAIT_PLAN_APPROVAL' });
    expect(go('WAIT_PLAN_APPROVAL', 'plan.approved')).toEqual({ ok: true, to: 'IMPLEMENTATION' });
    expect(go('IMPLEMENTATION', 'report.submitted', 'claude')).toEqual({ ok: true, to: 'WAIT_IMPLEMENTATION_ACCEPTANCE' });
    expect(go('WAIT_IMPLEMENTATION_ACCEPTANCE', 'implementation.accepted', 'user', null, false)).toEqual({ ok: true, to: 'FINAL_REPORT' });
    expect(go('FINAL_REPORT', 'task.completed', 'core')).toEqual({ ok: true, to: 'DONE' });
  });

  it('walks the path with review when the user asks for it at acceptance', () => {
    expect(go('WAIT_IMPLEMENTATION_ACCEPTANCE', 'implementation.accepted', 'user', null, true)).toEqual({ ok: true, to: 'CODE_REVIEW' });
    expect(go('CODE_REVIEW', 'review.reported', 'core')).toEqual({ ok: true, to: 'REVIEW_REPORT' });
    expect(go('REVIEW_REPORT', 'review.passed', 'core')).toEqual({ ok: true, to: 'FINAL_REPORT' });
    expect(go('FINAL_REPORT', 'task.completed', 'core')).toEqual({ ok: true, to: 'DONE' });
  });

  it('refuses an acceptance that does not say whether it goes to review', () => {
    expect(go('WAIT_IMPLEMENTATION_ACCEPTANCE', 'implementation.accepted')).toMatchObject({ ok: false, reason: expect.stringMatching(/independent review/) });
  });

  it('decides review from the choice and the effective review mode', () => {
    // Optional by default: no review unless the user asks for it.
    expect(resolveReviewChoice('optional', undefined)).toEqual({ ok: true, review: false });
    expect(resolveReviewChoice('optional', true)).toEqual({ ok: true, review: true });
    expect(resolveReviewChoice('optional', false)).toEqual({ ok: true, review: false });
    // Required forces review; declining it is refused with a reason.
    expect(resolveReviewChoice('required', undefined)).toEqual({ ok: true, review: true });
    expect(resolveReviewChoice('required', true)).toEqual({ ok: true, review: true });
    expect(resolveReviewChoice('required', false)).toMatchObject({ ok: false, reason: expect.stringMatching(/required/) });
    // A project's own mode wins over the global one; null follows the global one.
    expect(effectiveReviewMode('optional', 'required')).toBe('required');
    expect(effectiveReviewMode('required', 'optional')).toBe('optional');
    expect(effectiveReviewMode('required', null)).toBe('required');
    expect(effectiveReviewMode('optional', undefined)).toBe('optional');
  });

  it('lets a task that is already in review finish through the user waiver', () => {
    expect(go('CODE_REVIEW', 'review.skipped')).toEqual({ ok: true, to: 'FINAL_REPORT' });
    expect(go('FINAL_REPORT', 'task.completed', 'core')).toEqual({ ok: true, to: 'DONE' });
  });

  it('walks the analysis-first path: discovery, analysis, plan draft, approval', () => {
    expect(go(null, 'task.started', 'claude')).toEqual({ ok: true, to: 'DISCOVERY' });
    expect(go('DISCOVERY', 'analysis.started', 'core')).toEqual({ ok: true, to: 'PARALLEL_ANALYSIS' });
    expect(go('PARALLEL_ANALYSIS', 'analysis.completed', 'core')).toEqual({ ok: true, to: 'PLAN_DRAFT' });
    expect(go('PLAN_DRAFT', 'plan.revised', 'claude')).toEqual({ ok: true, to: 'WAIT_PLAN_APPROVAL' });
    // A small change may skip the analysts: the plan goes straight from discovery to approval.
    expect(go('DISCOVERY', 'plan.revised', 'claude')).toEqual({ ok: true, to: 'WAIT_PLAN_APPROVAL' });
    expect(go('IMPLEMENTATION', 'analysis.started', 'core')).toMatchObject({ ok: false });
  });

  it('loops back on rejection, revision and requested changes', () => {
    expect(go('WAIT_PLAN_APPROVAL', 'plan.rejected')).toEqual({ ok: true, to: 'PLAN_DRAFT' });
    expect(go('PLAN_DRAFT', 'plan.revised', 'claude')).toEqual({ ok: true, to: 'WAIT_PLAN_APPROVAL' });
    expect(go('IMPLEMENTATION', 'plan.revised', 'claude')).toEqual({ ok: true, to: 'WAIT_PLAN_APPROVAL' });
    expect(go('WAIT_IMPLEMENTATION_ACCEPTANCE', 'changes.requested')).toEqual({ ok: true, to: 'IMPLEMENTATION' });
    expect(go('PLAN_DRAFT', 'plan.approved')).toEqual({ ok: true, to: 'IMPLEMENTATION' });
    expect(go('IMPLEMENTATION', 'plan.rejected')).toEqual({ ok: true, to: 'PLAN_DRAFT' });
    expect(go('IMPLEMENTATION', 'plan.approved')).toMatchObject({ ok: false });
    // When Core refuses DONE, the user sends the work back from the final checks.
    expect(go('FINAL_REPORT', 'changes.requested')).toEqual({ ok: true, to: 'IMPLEMENTATION' });
    expect(go('FINAL_REPORT', 'implementation.accepted', 'user', null, false)).toMatchObject({ ok: false });
  });

  it('keeps every user decision with the user', () => {
    for (const event of ['plan.approved', 'plan.rejected', 'changes.requested', 'implementation.accepted', 'task.paused', 'task.resumed', 'task.cancelled'] as const) {
      const from: WorkflowState = event === 'task.resumed' ? 'PAUSED' : event === 'plan.rejected' || event === 'plan.approved' ? 'WAIT_PLAN_APPROVAL' : event === 'changes.requested' || event === 'implementation.accepted' ? 'WAIT_IMPLEMENTATION_ACCEPTANCE' : 'IMPLEMENTATION';
      for (const review of [true, false]) {
        expect(go(from, event, 'claude', 'IMPLEMENTATION', review).ok, event).toBe(false);
        expect(go(from, event, 'core', 'IMPLEMENTATION', review).ok, event).toBe(false);
      }
    }
  });

  it('lets only Core mark a task DONE', () => {
    expect(go('FINAL_REPORT', 'task.completed', 'user')).toMatchObject({ ok: false });
    expect(go('FINAL_REPORT', 'task.completed', 'claude')).toMatchObject({ ok: false });
    expect(go('IMPLEMENTATION', 'task.completed', 'core')).toMatchObject({ ok: false });
  });

  it('lets only the user complete a task the final checks refused, and only from the final checks', () => {
    expect(go('FINAL_REPORT', 'final-checks.waived', 'user')).toEqual({ ok: true, to: 'DONE' });
    expect(go('FINAL_REPORT', 'final-checks.waived', 'claude')).toMatchObject({ ok: false });
    expect(go('FINAL_REPORT', 'final-checks.waived', 'core')).toMatchObject({ ok: false });
    for (const state of ['IMPLEMENTATION', 'WAIT_IMPLEMENTATION_ACCEPTANCE', 'CODE_REVIEW', 'DONE', 'PAUSED'] as const) {
      expect(go(state, 'final-checks.waived', 'user'), state).toMatchObject({ ok: false });
    }
    // It is offered to the user in the final checks, never to Claude.
    expect(availableEvents('FINAL_REPORT', 'user')).toContain('final-checks.waived');
    expect(availableEvents('FINAL_REPORT', 'claude')).not.toContain('final-checks.waived');
  });

  it('pauses and resumes to the state the task was in', () => {
    expect(go('IMPLEMENTATION', 'task.paused')).toEqual({ ok: true, to: 'PAUSED' });
    expect(go('PAUSED', 'task.resumed', 'user', 'IMPLEMENTATION')).toEqual({ ok: true, to: 'IMPLEMENTATION' });
    expect(go('PAUSED', 'task.resumed', 'user', null)).toMatchObject({ ok: false });
    expect(go('PAUSED', 'task.paused')).toMatchObject({ ok: false });
  });

  it('never leaves a terminal state', () => {
    for (const state of ['DONE', 'CANCELLED'] as const) {
      expect(isTerminal(state)).toBe(true);
      for (const event of WORKFLOW_EVENTS) {
        for (const actor of ['user', 'claude', 'core'] as const) {
          expect(go(state, event, actor, 'IMPLEMENTATION', true).ok, `${state} ${event} ${actor}`).toBe(false);
        }
      }
    }
  });

  it('cancels from any non-terminal state, including paused', () => {
    for (const state of WORKFLOW_STATES.filter((candidate) => !isTerminal(candidate))) {
      expect(go(state, 'task.cancelled').ok, state).toBe(true);
    }
  });

  it('creates tasks only through a first plan or a task intake', () => {
    for (const event of WORKFLOW_EVENTS.filter((candidate) => candidate !== 'plan.submitted' && candidate !== 'task.started')) {
      expect(go(null, event, 'user').ok, event).toBe(false);
    }
    expect(go('IMPLEMENTATION', 'plan.submitted', 'claude').ok).toBe(false);
  });

  it('runs the independent review loop between acceptance and the final checks', () => {
    expect(go('WAIT_IMPLEMENTATION_ACCEPTANCE', 'implementation.accepted', 'user', null, true)).toEqual({ ok: true, to: 'CODE_REVIEW' });
    expect(go('CODE_REVIEW', 'review.reported', 'core')).toEqual({ ok: true, to: 'REVIEW_REPORT' });
    expect(go('REVIEW_REPORT', 'review.passed', 'core')).toEqual({ ok: true, to: 'FINAL_REPORT' });
    expect(go('REVIEW_REPORT', 'fixes.proposed', 'claude')).toEqual({ ok: true, to: 'WAIT_REVIEW_FIX_APPROVAL' });
    expect(go('WAIT_REVIEW_FIX_APPROVAL', 'fixes.proposed', 'claude')).toEqual({ ok: true, to: 'WAIT_REVIEW_FIX_APPROVAL' });
    expect(go('WAIT_REVIEW_FIX_APPROVAL', 'fixes.approved')).toEqual({ ok: true, to: 'FIX_IMPLEMENTATION' });
    expect(go('WAIT_REVIEW_FIX_APPROVAL', 'fixes.rejected')).toEqual({ ok: true, to: 'REVIEW_REPORT' });
    expect(go('FIX_IMPLEMENTATION', 'fixes.reported', 'claude')).toEqual({ ok: true, to: 'REVERIFICATION' });
    expect(go('REVERIFICATION', 'review.reported', 'core')).toEqual({ ok: true, to: 'REVIEW_REPORT' });
    expect(go('REVIEW_REPORT', 'review.skipped')).toEqual({ ok: true, to: 'FINAL_REPORT' });
    expect(go('REVIEW_REPORT', 'changes.requested')).toEqual({ ok: true, to: 'IMPLEMENTATION' });
    // Only the user approves fixes, waives the review, or sends the work back; only Core passes a review.
    for (const actor of ['claude', 'core'] as const) {
      expect(go('WAIT_REVIEW_FIX_APPROVAL', 'fixes.approved', actor).ok).toBe(false);
      expect(go('REVIEW_REPORT', 'review.skipped', actor).ok).toBe(false);
    }
    expect(go('REVIEW_REPORT', 'review.passed', 'claude').ok).toBe(false);
    expect(go('REVIEW_REPORT', 'review.passed', 'user').ok).toBe(false);
  });

  it('lists what each actor can do next', () => {
    expect(availableEvents('WAIT_PLAN_APPROVAL', 'user').sort()).toEqual(['plan.approved', 'plan.rejected', 'plan.revised', 'task.cancelled', 'task.paused']);
    expect(availableEvents('IMPLEMENTATION', 'claude').sort()).toEqual(['plan.revised', 'report.submitted']);
    expect(availableEvents('DONE', 'user')).toEqual([]);
  });
});
