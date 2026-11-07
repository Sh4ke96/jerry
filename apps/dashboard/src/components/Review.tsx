import type { ReviewState, TaskSummary } from '@jerry/contracts';
import { EMOJI, SEVERITY_EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref, watch, type PropType } from 'vue';
import { api } from '../api';
import { formatTime } from '../format';
import { ATTENTION, LIST } from '../lib/classes';
import { handleError, perform } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { StatusBadge } from './StatusBadge';
import { Button } from './ui/button';

/** The three reviewers (kept here: a value import from the contracts would bundle Zod). */
const REVIEWER_ROLES = ['jerry-correctness-reviewer', 'jerry-security-reviewer', 'jerry-design-reviewer'] as const;
const ROLE_LABEL: Record<string, string> = {
  'jerry-correctness-reviewer': 'Correctness and tests',
  'jerry-security-reviewer': 'Security and contracts',
  'jerry-design-reviewer': 'Architecture, quality, UX',
};

type Decision = 'approve-fixes' | 'reject-fixes' | 'waive';

/**
 * The independent review of a task: rounds, the three reviewers, coverage of the
 * changed files, independence, the fix plan and the user's decisions on it.
 */
export const ReviewPanel = defineComponent({
  name: 'ReviewPanel',
  props: { task: { type: Object as PropType<TaskSummary>, required: true } },
  setup(props) {
    const review = ref<ReviewState | null>(null);
    const pending = ref<Decision | null>(null);
    const busy = ref(false);
    const load = async (): Promise<void> => {
      try {
        review.value = await api.review(props.task.taskId);
      } catch (error) {
        handleError(error);
      }
    };
    onMounted(() => void load());
    watch(
      () => `${props.task.state}|${JSON.stringify(props.task.findings)}`,
      () => void load(),
    );

    const decide = async (typed: string, comment: string): Promise<void> => {
      const action = pending.value;
      const round = review.value?.rounds.at(-1);
      if (action === null || round === undefined) return;
      busy.value = true;
      const id = props.task.taskId;
      const done =
        action === 'waive'
          ? await perform(() => api.skipReview(id, comment, typed), `Waived the review of ${id}.`)
          : await perform(() => api.decideFixPlan(id, round.round, action === 'approve-fixes' ? 'APPROVED' : 'REJECTED', typed, comment), `${action === 'approve-fixes' ? 'Approved' : 'Rejected'} the fix plan of ${id} (round ${round.round}).`);
      busy.value = false;
      if (done) {
        pending.value = null;
        await load();
      }
    };

    return () => {
      const state = review.value;
      if (state === null || state.rounds.length === 0) return null;
      const round = state.rounds.at(-1)!;
      const waiting = props.task.state === 'WAIT_REVIEW_FIX_APPROVAL' && round.fixPlan !== null;
      const canWaive = ['CODE_REVIEW', 'REVIEW_REPORT', 'WAIT_REVIEW_FIX_APPROVAL', 'REVERIFICATION'].includes(props.task.state);
      return (
        <section class="review grid gap-3 rounded-lg border p-4 text-sm">
          <h3 class="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
            <Emoji symbol={EMOJI.review} class="mr-0" />
            Independent review{' '}
            <StatusBadge
              tone={state.outcome === 'passed' ? 'pass' : state.outcome === 'skipped' ? 'warn' : state.openFindings.length > 0 ? 'deny' : 'neutral'}
              emoji={state.outcome === 'passed' ? EMOJI.pass : state.outcome === 'skipped' ? EMOJI.skipped : state.openFindings.length > 0 ? EMOJI.finding : EMOJI.waiting}
            >
              {state.outcome ?? (state.openFindings.length > 0 ? `${state.openFindings.length} open finding(s)` : 'in progress')}
            </StatusBadge>{' '}
            <span class="text-muted-foreground text-xs font-normal">
              round {round.round} of at most {state.maxRounds}
            </span>
          </h3>
          <ul class={LIST}>
            {REVIEWER_ROLES.map((role) => {
              const submission = round.submissions.find((entry) => entry.role === role);
              return (
                <li key={role}>
                  <Emoji symbol={EMOJI.agent} />
                  <strong class="font-medium">{ROLE_LABEL[role]}</strong>:{' '}
                  {submission === undefined ? (
                    <span class="text-muted-foreground">{round.completedAt === null ? 'not reported yet' : 'no report (gap)'}</span>
                  ) : (
                    <span>
                      {submission.findings} finding(s), {submission.filesReviewed.length} file(s) read <span class="text-muted-foreground text-xs">{formatTime(submission.at)}</span>
                      {!submission.independent && <span class={[ATTENTION, 'text-xs']}> · not independent: {submission.independenceNote}</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {round.uncovered.length > 0 && (
            <p class={ATTENTION}>
              <Emoji symbol={EMOJI.warning} />
              Changed files no reviewer covered: {round.uncovered.join(', ')}
            </p>
          )}
          {state.openFindings.length > 0 && (
            <ul class={LIST}>
              {state.openFindings.map((finding) => (
                <li key={finding.findingId} class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge tone={finding.severity === 'P1' || finding.severity === 'P2' ? 'deny' : 'warn'} emoji={SEVERITY_EMOJI[finding.severity]}>
                    {finding.severity}
                  </StatusBadge>{' '}
                  {finding.title}{' '}
                  <code class="font-mono text-xs">
                    {finding.file}:{finding.lineStart}
                  </code>{' '}
                  <span class="text-muted-foreground text-xs">{finding.findingId}</span>
                </li>
              ))}
            </ul>
          )}
          {round.fixPlan !== null && (
            <div class="bg-muted/50 grid gap-2 rounded-md p-3">
              <h4 class="flex items-center font-medium">
                <Emoji symbol={EMOJI.plan} />
                Fix plan (round {round.round})
              </h4>
              <p>{round.fixPlan.summary}</p>
              <ul class={LIST}>
                {round.fixPlan.items.map((item, index) => (
                  <li key={index}>
                    {item.findings.join(', ')}: {item.change} <span class="text-muted-foreground font-mono text-xs">{item.files.join(', ')}</span>
                  </li>
                ))}
                {round.fixPlan.notFixed.map((entry) => (
                  <li key={entry.finding} class="text-muted-foreground">
                    not fixed {entry.finding}: {entry.reason}
                  </li>
                ))}
              </ul>
              {round.fixesSummary !== null && <p class="text-muted-foreground">Fixes reported: {round.fixesSummary}</p>}
            </div>
          )}
          {round.skippedAt !== null && (
            <p class="text-muted-foreground">
              <Emoji symbol={EMOJI.skipped} />
              Waived by the user: {round.skipReason}
            </p>
          )}
          {(waiting || canWaive) && (
            <div class="flex flex-wrap gap-2">
              {waiting && (
                <Button type="button" size="sm" onClick={() => (pending.value = 'approve-fixes')}>
                  Approve fix plan
                </Button>
              )}
              {waiting && (
                <Button type="button" variant="outline" size="sm" onClick={() => (pending.value = 'reject-fixes')}>
                  Reject fix plan
                </Button>
              )}
              {canWaive && (
                <Button type="button" variant="ghost" size="sm" onClick={() => (pending.value = 'waive')}>
                  Waive review
                </Button>
              )}
            </div>
          )}
          {pending.value !== null && (
            <ConfirmDialog
              title={pending.value === 'waive' ? `Waive the review of ${props.task.taskId}` : `${pending.value === 'approve-fixes' ? 'Approve' : 'Reject'} the fix plan of ${props.task.taskId}`}
              expected={props.task.taskId}
              confirmLabel={pending.value === 'waive' ? 'Waive review' : pending.value === 'approve-fixes' ? 'Approve fix plan' : 'Reject fix plan'}
              tone={pending.value === 'approve-fixes' ? 'primary' : 'danger'}
              busy={busy.value}
              commentLabel={pending.value === 'waive' ? 'Reason (required)' : pending.value === 'reject-fixes' ? 'What should change in the plan' : 'Comment (optional)'}
              commentRequired={pending.value === 'waive'}
              onConfirm={decide}
              onCancel={() => (pending.value = null)}
            >
              {pending.value === 'waive' ? (
                <p>The final checks run next; open review findings and gaps are recorded as limitations.</p>
              ) : (
                <p>The fixes may only change: {round.fixPlan?.items.flatMap((item) => item.files).join(', ')}</p>
              )}
            </ConfirmDialog>
          )}
        </section>
      );
    };
  },
});
