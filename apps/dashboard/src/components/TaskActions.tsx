import type { TaskSummary } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { availableEvents } from '@jerry/workflow';
import { Check, Copy, Ellipsis } from '@lucide/vue';
import { defineComponent, ref, type PropType } from 'vue';
import { api } from '../api';
import { REVIEW_STATES, REVIEWER_STATES, projectOf } from '../lib/tasks';
import { classProp, cn } from '../lib/utils';
import { decisionConfirmation, projectReviewMode, taskReviewMode, type DecisionConfirmation, type ReviewMode } from '../settings';
import { handleError, perform, state } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Label } from './ui/label';
import { Switch } from './ui/switch';

/**
 * Decisions confirmed in a dialog, like their CLI prompts. Reversible ones are one click unless the
 * user chose typed confirmations in Settings; cancelling cannot be undone and always needs the typed
 * task ID. Pause and resume are one click without a dialog.
 */
type ConfirmedAction = 'approve' | 'reject' | 'withdraw' | 'accept' | 'request-changes' | 'cancel' | 'skip-review' | 'approve-fixes' | 'reject-fixes' | 'recheck';

interface Pending {
  task: TaskSummary;
  action: ConfirmedAction;
  /** The review round a fix-plan decision is about. */
  round?: number;
}

const DIALOG: Record<ConfirmedAction, { title: string; confirm: string; tone: 'primary' | 'danger'; note: string; comment?: string; commentRequired?: boolean }> = {
  approve: {
    title: 'Approve',
    confirm: 'Approve plan',
    tone: 'primary',
    note: 'The task moves to implementation: edits inside this scope pass silently; edits outside it are recorded as deviations. Hard rules stay in force.',
  },
  reject: {
    title: 'Reject',
    confirm: 'Reject plan',
    tone: 'danger',
    note: 'The plan goes back to Claude for changes. Until a plan is approved, edits in this repository are recorded as deviations.',
  },
  withdraw: {
    title: 'Reject',
    confirm: 'Reject plan',
    tone: 'danger',
    note: 'You withdraw the approval: the plan goes back to Claude for changes. Until a plan is approved again, edits in this repository are recorded as deviations.',
  },
  accept: {
    title: 'Accept',
    confirm: 'Accept implementation',
    tone: 'primary',
    note: 'You accept exactly this report. Claude makes no further changes for it unless the review finds something; committing stays with you.',
  },
  'request-changes': {
    title: 'Request changes to',
    confirm: 'Request changes',
    tone: 'danger',
    note: 'The task goes back to implementation under the same approved plan; Claude sees your comment and submits a new report.',
    comment: 'What should change (Claude sees this)',
  },
  cancel: {
    title: 'Cancel',
    confirm: 'Cancel task',
    tone: 'danger',
    note: 'Cancelling cannot be undone. The task and its history stay on record; its plan no longer covers any edits.',
  },
  'skip-review': {
    title: 'Skip the review of',
    confirm: 'Skip review',
    tone: 'danger',
    note: 'The final checks run next; open review findings and gaps are recorded as limitations in the final report.',
    comment: 'Reason (required)',
    commentRequired: true,
  },
  'approve-fixes': {
    title: 'Approve the fix plan of',
    confirm: 'Approve fix plan',
    tone: 'primary',
    note: 'Claude makes exactly these fixes; the same reviewers then re-check them.',
    comment: 'Comment (optional)',
  },
  'reject-fixes': {
    title: 'Reject the fix plan of',
    confirm: 'Reject fix plan',
    tone: 'danger',
    note: 'Claude revises the fix plan and submits it again.',
    comment: 'What should change in the plan',
  },
  recheck: {
    title: 'Re-run the final checks of',
    confirm: 'Re-run final checks',
    tone: 'primary',
    note: 'JERRY runs the same final checks again; the task is done if they pass. Files later approved tasks changed are listed, not held against it.',
  },
};

/** Actions that cannot be undone: always confirmed by typing the task ID, whatever the setting says. */
const IRREVERSIBLE: ReadonlySet<ConfirmedAction> = new Set(['cancel']);

/** How an action's dialog is confirmed: typed for irreversible actions, else as the user chose in Settings. */
function confirmationMode(action: ConfirmedAction): DecisionConfirmation {
  return IRREVERSIBLE.has(action) ? 'typed' : decisionConfirmation(state.settings);
}

function subjectOf(pending: Pending): string {
  const { task, action } = pending;
  if (action === 'cancel' || action === 'skip-review' || action === 'recheck') return task.taskId;
  if (action === 'approve-fixes' || action === 'reject-fixes') return `${task.taskId} (round ${pending.round ?? '?'})`;
  if (action === 'accept' || action === 'request-changes') return `${task.taskId} report v${task.lastReport?.version ?? '?'}`;
  return `${task.taskId} plan v${task.plan.version}`;
}

/** The review mode that applies to the task; null when this Core does not know review modes (it always reviews). */
export function effectiveReviewMode(task: TaskSummary): ReviewMode | null {
  const own = taskReviewMode(task);
  if (own !== null) return own;
  const project = projectOf(task, state.projects);
  const fromProject = project === undefined ? null : projectReviewMode(project);
  return fromProject ?? state.settings?.reviewMode ?? null;
}

/** The notice after a decision, once Core has answered and the task was reloaded. */
function outcomeNotice(taskId: string, done: string): string {
  const after = state.tasks.find((candidate) => candidate.taskId === taskId);
  if (after === undefined) return done;
  if (after.state === 'DONE') return `${done} JERRY's final checks passed: the task is done.`;
  if (after.state === 'FINAL_REPORT') return `${done} JERRY's final checks did not pass.`;
  if (REVIEWER_STATES.has(after.state)) return `${done} The task is in independent review: run /jerry:review ${taskId} in Claude Code.`;
  return done;
}

/**
 * Every decision about one task, with its confirmation dialog. The tile, the task page and the
 * '⋯' menu each hold their own instance; the dialogs are the same everywhere.
 */
function useTaskDecisions(task: () => TaskSummary, changed: () => void) {
  const pending = ref<Pending | null>(null);
  const busy = ref(false);
  /** Whether an accepted report goes to independent review (the switch in the accept dialog). */
  const sendToReview = ref(true);
  /** The review instruction is shown (Claude runs the reviewers, not the dashboard). */
  const startingReview = ref(false);
  const copied = ref(false);

  const ask = (action: ConfirmedAction): void => {
    if (action === 'accept') sendToReview.value = effectiveReviewMode(task()) !== 'optional';
    pending.value = { task: task(), action };
  };

  /** A fix-plan decision is about the latest review round, read when the user asks. */
  const askFixPlan = async (action: 'approve-fixes' | 'reject-fixes'): Promise<void> => {
    const current = task();
    try {
      const review = await api.review(current.taskId);
      const round = review.rounds.at(-1);
      if (round === undefined || round.fixPlan === null) {
        state.notice = `${current.taskId} has no fix plan to decide on.`;
        return;
      }
      pending.value = { task: current, action, round: round.round };
    } catch (error) {
      handleError(error);
    }
  };

  const run = async (current: Pending, typed: string, comment: string): Promise<boolean> => {
    const { task: subject, action } = current;
    const id = subject.taskId;
    const report = subject.lastReport;
    switch (action) {
      case 'cancel':
        return perform(() => api.control(id, 'task.cancelled', typed), `Cancelled ${id}.`);
      case 'accept': {
        if (report === null) return false;
        const mode = effectiveReviewMode(subject);
        // An older Core always reviews and knows no choice: nothing is sent then.
        const review = mode === null ? undefined : mode === 'required' ? true : sendToReview.value;
        const done = await perform(() => api.decideReport(subject, report.version, 'APPROVED', typed, comment, review), `Accepted ${id} report v${report.version}.`);
        // Core ran its final checks in the same step, unless the task went to review: say how it ended.
        if (done) state.notice = outcomeNotice(id, `Accepted ${id} report v${report.version}.`);
        return done;
      }
      case 'request-changes':
        if (report === null) return false;
        return perform(() => api.decideReport(subject, report.version, 'REJECTED', typed, comment), `Requested changes to ${id} report v${report.version}.`);
      case 'skip-review': {
        const done = await perform(() => api.skipReview(id, comment, typed), `Skipped the review of ${id}.`);
        if (done) state.notice = outcomeNotice(id, `Skipped the review of ${id}.`);
        return done;
      }
      case 'recheck': {
        const done = await perform(() => api.rerunFinalChecks(id, typed), `Re-ran the final checks of ${id}.`);
        if (done) state.notice = outcomeNotice(id, `Re-ran the final checks of ${id}.`);
        return done;
      }
      case 'approve-fixes':
      case 'reject-fixes': {
        const round = current.round ?? 0;
        const approved = action === 'approve-fixes';
        return perform(() => api.decideFixPlan(id, round, approved ? 'APPROVED' : 'REJECTED', typed, comment), `${approved ? 'Approved' : 'Rejected'} the fix plan of ${id} (round ${round}).`);
      }
      default: {
        const approved = action === 'approve';
        return perform(() => api.decide(subject, approved ? 'APPROVED' : 'REJECTED', typed), `${approved ? 'Approved' : 'Rejected'} ${id} plan v${subject.plan.version}.`);
      }
    }
  };

  const confirm = async (typed: string, comment: string): Promise<void> => {
    const current = pending.value;
    if (current === null) return;
    busy.value = true;
    const done = await run(current, typed, comment);
    busy.value = false;
    if (done) {
      pending.value = null;
      changed();
    }
  };

  const control = async (event: 'task.paused' | 'task.resumed'): Promise<void> => {
    const id = task().taskId;
    busy.value = true;
    const done = await perform(() => api.control(id, event), `${event === 'task.paused' ? 'Paused' : 'Resumed'} ${id}.`);
    busy.value = false;
    if (done) changed();
  };

  const copyInstruction = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
    } catch {
      state.notice = `Copy it by hand: ${text}`;
    }
  };

  const reviewSwitch = (subject: TaskSummary) => {
    const mode = effectiveReviewMode(subject);
    const locked = mode === null || mode === 'required';
    return (
      <div class="review-choice bg-muted/50 grid gap-1.5 rounded-lg border p-3" data-review-mode={mode ?? 'unknown'}>
        <div class="flex items-center justify-between gap-3">
          <Label for="send-to-review" class="flex items-center">
            <Emoji symbol={EMOJI.review} />
            Send to independent review
          </Label>
          <Switch id="send-to-review" modelValue={locked ? true : sendToReview.value} disabled={locked} onUpdate:modelValue={(value: boolean) => (sendToReview.value = value)} />
        </div>
        <p class="text-muted-foreground text-xs">
          {mode === null
            ? 'This JERRY Core always runs the independent review after acceptance.'
            : mode === 'required'
              ? 'Review is required for this project: three read-only reviewers check every changed file before the final checks.'
              : sendToReview.value
                ? 'Three read-only reviewers check every changed file; you then run /jerry:review in Claude Code.'
                : 'No review: JERRY runs the final checks right away, and the task is done when they pass.'}
        </p>
      </div>
    );
  };

  const dialogs = () => {
    const current = pending.value;
    const instruction = `/jerry:review ${task().taskId}`;
    return [
      current !== null && (
        <ConfirmDialog
          key="decision"
          title={`${DIALOG[current.action].title} ${subjectOf(current)}`}
          expected={current.task.taskId}
          mode={confirmationMode(current.action)}
          confirmLabel={DIALOG[current.action].confirm}
          tone={DIALOG[current.action].tone}
          busy={busy.value}
          commentLabel={DIALOG[current.action].comment}
          commentRequired={DIALOG[current.action].commentRequired === true}
          onConfirm={confirm}
          onCancel={() => (pending.value = null)}
        >
          {{
            default: () => [
              <p class="text-foreground">{current.task.title}</p>,
              <p>Scope: {current.task.plan.scope.join(', ')}</p>,
              current.action === 'accept' && (current.task.plan.document?.definitionOfDone.length ?? 0) > 0 && (
                <div class="grid gap-1">
                  <p>You confirm the plan's Definition of Done:</p>
                  <ul class="text-foreground grid list-disc gap-1 pl-5">
                    {current.task.plan.document?.definitionOfDone.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              ),
              <p class="text-xs">{DIALOG[current.action].note}</p>,
            ],
            controls: current.action === 'accept' ? () => reviewSwitch(current.task) : undefined,
          }}
        </ConfirmDialog>
      ),
      <Dialog key="start-review" open={startingReview.value} onUpdate:open={(open: boolean) => (startingReview.value = open)}>
        <DialogContent class="start-review">
          <DialogHeader>
            <DialogTitle>Start the review of {task().taskId}</DialogTitle>
            <DialogDescription>Claude runs the three read-only reviewers; the dashboard cannot start them. In Claude Code, in this repository, run:</DialogDescription>
          </DialogHeader>
          <div class="bg-muted flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <code class="font-mono text-sm break-all" data-instruction>
              {instruction}
            </code>
            <Button variant="outline" size="sm" onClick={() => void copyInstruction(instruction)}>
              {copied.value ? <Check /> : <Copy />}
              {copied.value ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p class="text-muted-foreground text-sm">Only you approve their fix plan or skip the review.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => (startingReview.value = false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    ];
  };

  const startReview = (): void => {
    copied.value = false;
    startingReview.value = true;
  };

  return { ask, askFixPlan, control, busy, pending, dialogs, startReview };
}

/** The decisions the task's state allows, as buttons. Pause, withdrawing and cancelling are in the '⋯' menu. */
export const TaskActions = defineComponent({
  name: 'TaskActions',
  props: {
    task: { type: Object as PropType<TaskSummary>, required: true },
    class: classProp,
  },
  emits: { changed: () => true },
  setup(props, { emit }) {
    const decisions = useTaskDecisions(
      () => props.task,
      () => emit('changed'),
    );
    return () => {
      const task = props.task;
      const allowed = availableEvents(task.state, 'user');
      const buttons = [];
      if (allowed.includes('implementation.accepted') && task.lastReport !== null) {
        buttons.push(
          <Button key="accept" size="sm" onClick={() => decisions.ask('accept')}>
            Accept implementation
          </Button>,
        );
      }
      // Core held the task in its final checks: the user may run them again (for example after a later
      // task that changed the same files reported).
      if (task.state === 'FINAL_REPORT') {
        buttons.push(
          <Button key="recheck" size="sm" onClick={() => decisions.ask('recheck')}>
            Re-run final checks
          </Button>,
        );
      }
      if (allowed.includes('changes.requested') && task.lastReport !== null) {
        buttons.push(
          <Button key="request-changes" variant="outline" size="sm" onClick={() => decisions.ask('request-changes')}>
            Request changes
          </Button>,
        );
      }
      if (allowed.includes('plan.approved')) {
        buttons.push(
          <Button key="approve" size="sm" onClick={() => decisions.ask('approve')}>
            Approve plan v{task.plan.version}
          </Button>,
        );
      }
      if (allowed.includes('plan.rejected') && task.state !== 'IMPLEMENTATION') {
        buttons.push(
          <Button key="reject" variant="outline" size="sm" onClick={() => decisions.ask('reject')}>
            Reject
          </Button>,
        );
      }
      if (allowed.includes('fixes.approved')) {
        buttons.push(
          <Button key="approve-fixes" size="sm" onClick={() => void decisions.askFixPlan('approve-fixes')}>
            Approve fix plan
          </Button>,
        );
      }
      if (allowed.includes('fixes.rejected')) {
        buttons.push(
          <Button key="reject-fixes" variant="outline" size="sm" onClick={() => void decisions.askFixPlan('reject-fixes')}>
            Reject fix plan
          </Button>,
        );
      }
      if (REVIEWER_STATES.has(task.state)) {
        buttons.push(
          <Button key="start-review" size="sm" variant={REVIEW_STATES.has(task.state) && buttons.length === 0 ? 'default' : 'outline'} onClick={decisions.startReview}>
            Start review
          </Button>,
        );
      }
      if (allowed.includes('review.skipped')) {
        buttons.push(
          <Button key="skip-review" variant="outline" size="sm" onClick={() => decisions.ask('skip-review')}>
            Skip review
          </Button>,
        );
      }
      if (allowed.includes('task.resumed')) {
        buttons.push(
          <Button key="resume" size="sm" disabled={decisions.busy.value} onClick={() => void decisions.control('task.resumed')}>
            Resume
          </Button>,
        );
      }
      return (
        <div class={cn('task-actions flex flex-wrap items-center gap-2', props.class)}>
          {buttons}
          {decisions.dialogs()}
        </div>
      );
    };
  },
});

/** Pause, withdrawing an approval and cancelling: rarer, so behind '⋯'. Renders nothing when none applies. */
export const TaskMenu = defineComponent({
  name: 'TaskMenu',
  props: { task: { type: Object as PropType<TaskSummary>, required: true } },
  emits: { changed: () => true },
  setup(props, { emit }) {
    const decisions = useTaskDecisions(
      () => props.task,
      () => emit('changed'),
    );
    return () => {
      const allowed = availableEvents(props.task.state, 'user');
      const pause = allowed.includes('task.paused');
      const withdraw = allowed.includes('plan.rejected') && props.task.state === 'IMPLEMENTATION';
      const cancel = allowed.includes('task.cancelled');
      if (!pause && !withdraw && !cancel) return null;
      const keepFocus = (event: Event): void => {
        if (decisions.pending.value !== null) event.preventDefault();
      };
      return (
        <span class="task-menu inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${props.task.taskId}`} data-task-menu>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            {/* The trigger does not take the focus back when a dialog opens from the menu. */}
            <DropdownMenuContent align="end" class="w-48" {...{ onCloseAutoFocus: keepFocus }}>
              {pause && (
                <DropdownMenuItem disabled={decisions.busy.value} onSelect={() => void decisions.control('task.paused')}>
                  Pause
                </DropdownMenuItem>
              )}
              {withdraw && <DropdownMenuItem onSelect={() => decisions.ask('withdraw')}>Withdraw approval</DropdownMenuItem>}
              {cancel && (pause || withdraw) && <DropdownMenuSeparator />}
              {cancel && (
                <DropdownMenuItem variant="destructive" onSelect={() => decisions.ask('cancel')}>
                  Cancel task
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {decisions.dialogs()}
        </span>
      );
    };
  },
});
