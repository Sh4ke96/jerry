import type { ArtifactRequest, TaskSummary } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { availableEvents } from '@jerry/workflow';
import { Check, ChevronDown, Copy, Ellipsis } from '@lucide/vue';
import { AccordionContent, AccordionHeader, AccordionItem, AccordionRoot, AccordionTrigger } from 'reka-ui';
import { defineComponent, ref, type PropType } from 'vue';
import { api } from '../api';
import { CHIP } from '../lib/classes';
import { canWaive, failedBlocking, rerunCanHelp } from '../lib/final-checks';
import { REVIEW_STATES, REVIEWER_STATES, projectOf } from '../lib/tasks';
import { classProp, cn } from '../lib/utils';
import { decisionConfirmation, projectReviewMode, taskReviewMode, type ReviewMode } from '../settings';
import { handleError, perform, state } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';

/**
 * Decisions confirmed in a dialog, like their CLI prompts: one click, or the typed task ID when the
 * user chose typed confirmations in Settings; cancelling too (its dialog says it cannot be undone).
 * Pause and resume are one click without a dialog.
 */
type ConfirmedAction = 'approve' | 'reject' | 'withdraw' | 'accept' | 'request-changes' | 'cancel' | 'skip-review' | 'approve-fixes' | 'reject-fixes' | 'recheck' | 'complete-anyway';

/** The kinds of Artifact (kept here: a value import from the contracts would bundle Zod). */
export const ARTIFACT_KIND_LABEL: Record<ArtifactRequest['kind'], string> = {
  'stakeholder-presentation': 'Stakeholder presentation',
  'architecture-before-after': 'Architecture before and after',
  'ui-flows': 'UI flows and screens',
  'endpoint-contract-map': 'Endpoint and contract map',
  other: 'Other (as the plan describes)',
};

/** The Artifact switch and its kind: in the plan-approval dialog and on the task page. */
export function artifactChoice(id: string, wanted: boolean, kind: ArtifactRequest['kind'], change: (next: ArtifactRequest) => void, disabled = false) {
  return (
    <div class="artifact-choice bg-muted/50 grid gap-2 rounded-lg border p-3" data-artifact-choice={wanted ? kind : 'off'}>
      <div class="flex items-center justify-between gap-3">
        <Label for={`${id}-switch`} class="flex items-center">
          <Emoji symbol={EMOJI.artifact} />
          Create an Artifact when the task is done
        </Label>
        <Switch id={`${id}-switch`} modelValue={wanted} disabled={disabled} onUpdate:modelValue={(value: boolean) => change({ wanted: value, kind })} />
      </div>
      {wanted && (
        <div class="flex flex-wrap items-center gap-2">
          <Label for={`${id}-kind`} class="text-muted-foreground text-xs">
            Kind
          </Label>
          <Select modelValue={kind} disabled={disabled} onUpdate:modelValue={(value: string) => change({ wanted, kind: value as ArtifactRequest['kind'] })}>
            <SelectTrigger id={`${id}-kind`} size="sm" data-artifact-kind>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(ARTIFACT_KIND_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <p class="text-muted-foreground text-xs">
        {wanted
          ? 'When the task is done, Claude creates it in your claude.ai account (a private page you can share or delete) without asking again. Nothing goes into the repository.'
          : 'No Artifact. You can switch it on later on the task page, until the task is done.'}
      </p>
    </div>
  );
}

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
  'complete-anyway': {
    title: 'Complete',
    confirm: 'Complete despite failed checks',
    tone: 'danger',
    note: 'JERRY runs the final checks once more: if they pass, the task is done as usual; if they changed, nothing happens and you look again. Otherwise the task is DONE by your decision. This cannot be undone; your reason and the waived blockers are recorded in the history and the final report, and the checks stay marked as failed.',
    comment: 'Why is it fine to complete the task anyway? (required)',
    commentRequired: true,
  },
};


/** shadcn's accordion (new-york-v4) on reka-ui, compact for a dialog. */
const ACCORDION_TRIGGER =
  'focus-visible:border-ring focus-visible:ring-ring/50 text-foreground flex flex-1 cursor-pointer items-center justify-between gap-4 rounded-md py-2 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] [&[data-state=open]>svg]:rotate-180';
const ACCORDION_CONTENT = 'data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm';

/**
 * The scope and, when accepting, the Definition of Done, as an accordion folded by default: long
 * lists of paths stay out of the way until the user opens them. Several sections may be open at once.
 */
function decisionDetails(pending: Pending) {
  const { task, action } = pending;
  const definitionOfDone = action === 'accept' ? (task.plan.document?.definitionOfDone ?? []) : [];
  const section = (value: string, title: string, body: () => unknown) => (
    <AccordionItem key={value} value={value} class="border-b last:border-b-0" data-details={value}>
      <AccordionHeader class="flex">
        <AccordionTrigger class={ACCORDION_TRIGGER}>
          {title}
          <ChevronDown class="text-muted-foreground pointer-events-none size-4 shrink-0 transition-transform duration-200" />
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionContent class={ACCORDION_CONTENT}>
        <div class="pb-3">{body()}</div>
      </AccordionContent>
    </AccordionItem>
  );
  return (
    <AccordionRoot type="multiple" defaultValue={[]} class="decision-details min-w-0 rounded-md border px-3">
      {section('scope', `Scope (${task.plan.scope.length})`, () => (
        <div class="flex flex-wrap gap-1">
          {task.plan.scope.map((glob) => (
            <code key={glob} class={CHIP}>
              {glob}
            </code>
          ))}
        </div>
      ))}
      {definitionOfDone.length > 0 &&
        section('definition-of-done', `Definition of Done you confirm (${definitionOfDone.length})`, () => (
          <ul class="text-foreground grid list-disc gap-1 pl-5">
            {definitionOfDone.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        ))}
    </AccordionRoot>
  );
}

function subjectOf(pending: Pending): string {
  const { task, action } = pending;
  if (action === 'complete-anyway') return `${task.taskId} despite its failed final checks`;
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
  if (after.state === 'DONE' && after.finalCheck?.waiver) return `${done} The task is done by your decision; JERRY's final checks did not pass.`;
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
  /**
   * The Claude Code instruction shown: starting the review (Claude runs the reviewers), or continuing
   * the work of a task in implementation (Claude implements and reports; the dashboard cannot).
   */
  const instructionShown = ref<'review' | 'continue' | null>(null);
  const copied = ref(false);

  /** The Artifact switch of the approve dialog, prefilled from the user's earlier choice or the plan's answer. */
  const artifact = ref<ArtifactRequest>({ wanted: false, kind: 'stakeholder-presentation' });

  const ask = (action: ConfirmedAction): void => {
    if (action === 'accept') sendToReview.value = effectiveReviewMode(task()) !== 'optional';
    if (action === 'approve') {
      const request = task().artifact?.request ?? null;
      artifact.value = request === null ? { wanted: false, kind: 'stakeholder-presentation' } : { wanted: request.wanted, kind: request.kind };
    }
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
      case 'complete-anyway': {
        // The blockers the user was shown: Core refuses when the checks now fail differently.
        const seen = failedBlocking(subject).map((condition) => condition.id);
        const done = await perform(() => api.waiveFinalChecks(id, comment, seen, typed), `Completed ${id}.`);
        if (done) state.notice = outcomeNotice(id, `Completed ${id}.`);
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
        // The switch is sent only when it says something: on, or off against the plan's answer.
        const sendArtifact = approved && (artifact.value.wanted || subject.artifact?.request?.wanted === true) ? artifact.value : undefined;
        return perform(() => api.decide(subject, approved ? 'APPROVED' : 'REJECTED', typed, sendArtifact), `${approved ? 'Approved' : 'Rejected'} ${id} plan v${subject.plan.version}.`);
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
              ? 'Review is required for this project: the read-only reviewers this change needs (up to three) check every changed file before the final checks.'
              : sendToReview.value
                ? 'The read-only reviewers this change needs (up to three) check every changed file; you then run /jerry:review in Claude Code.'
                : 'No review: JERRY runs the final checks right away, and the task is done when they pass.'}
        </p>
      </div>
    );
  };

  const dialogs = () => {
    const current = pending.value;
    const guide = instructionShown.value === null ? null : instructionFor(task(), instructionShown.value);
    return [
      current !== null && (
        <ConfirmDialog
          key="decision"
          title={`${DIALOG[current.action].title} ${subjectOf(current)}`}
          expected={current.task.taskId}
          mode={current.action === 'complete-anyway' ? 'typed' : decisionConfirmation(state.settings)}
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
              decisionDetails(current),
              <p class="text-xs">{DIALOG[current.action].note}</p>,
              current.action === 'complete-anyway' && (
                <div class="text-foreground grid gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs" data-waived-blockers>
                  <p class="font-medium">You waive what JERRY's final checks found:</p>
                  <ul class="grid list-disc gap-0.5 pl-4 [overflow-wrap:anywhere]">
                    {failedBlocking(current.task).map((condition) => (
                      <li key={condition.id} data-condition={condition.id}>
                        {condition.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
              current.action === 'recheck' && !rerunCanHelp(current.task) && (
                <p class="text-foreground rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs" data-rerun-warning>
                  A re-run cannot pass: everything that blocks this task is in its report or plan, which a re-run checks unchanged. Request changes instead, so Claude submits a corrected report.
                </p>
              ),
            ],
            controls:
              current.action === 'accept'
                ? () => reviewSwitch(current.task)
                : current.action === 'approve'
                  ? () => artifactChoice('approve-artifact', artifact.value.wanted, artifact.value.kind, (next) => (artifact.value = next))
                  : undefined,
          }}
        </ConfirmDialog>
      ),
      <Dialog key="instruction" open={guide !== null} onUpdate:open={(open: boolean) => !open && (instructionShown.value = null)}>
        {guide !== null && (
          <DialogContent class={guide.class}>
            <DialogHeader>
              <DialogTitle>{guide.title}</DialogTitle>
              <DialogDescription>{guide.description} In Claude Code, in this repository, run:</DialogDescription>
            </DialogHeader>
            <div class="bg-muted flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2">
              <code class="font-mono text-sm break-all" data-instruction>
                {guide.instruction}
              </code>
              <Button variant="outline" size="sm" onClick={() => void copyInstruction(guide.instruction)}>
                {copied.value ? <Check /> : <Copy />}
                {copied.value ? 'Copied' : 'Copy'}
              </Button>
            </div>
            {guide.request !== null && (
              <div class="grid gap-1 text-sm" data-sent-back>
                <p class="font-medium">Your request to Claude</p>
                <blockquote class="text-muted-foreground border-l-2 pl-3 [overflow-wrap:anywhere] whitespace-pre-line">{guide.request === '' ? 'No comment: Claude will ask you what to change.' : guide.request}</blockquote>
              </div>
            )}
            <p class="text-muted-foreground text-sm">{guide.footnote}</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => (instructionShown.value = null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>,
    ];
  };

  const showInstruction = (which: 'review' | 'continue'): void => {
    copied.value = false;
    instructionShown.value = which;
  };

  return { ask, askFixPlan, control, busy, pending, dialogs, startReview: () => showInstruction('review'), continueInClaude: () => showInstruction('continue') };
}

/** The user's comment when they sent the latest report back; null when the report was not sent back. */
export function sentBackComment(task: TaskSummary): string | null {
  return task.state === 'IMPLEMENTATION' && task.reportDecision?.decision === 'REJECTED' ? task.reportDecision.comment : null;
}

/** States in which Claude works and the dashboard can only say how to continue in Claude Code. */
export const CLAUDE_WORK_STATES: ReadonlySet<TaskSummary['state']> = new Set(['IMPLEMENTATION', 'FIX_IMPLEMENTATION']);

interface Instruction {
  class: string;
  title: string;
  description: string;
  instruction: string;
  request: string | null;
  footnote: string;
}

function instructionFor(task: TaskSummary, which: 'review' | 'continue'): Instruction {
  const id = task.taskId;
  if (which === 'review') {
    return {
      class: 'start-review',
      title: `Start the review of ${id}`,
      description: 'Claude runs the read-only reviewers this change needs; the dashboard cannot start them.',
      instruction: `/jerry:review ${id}`,
      request: null,
      footnote: 'Only you approve their fix plan or skip the review.',
    };
  }
  if (task.state === 'FIX_IMPLEMENTATION') {
    return {
      class: 'continue-in-claude',
      title: `Continue ${id} in Claude Code`,
      description: 'Claude makes the fixes you approved and the same reviewers re-check them; the dashboard cannot start that.',
      instruction: `/jerry:review ${id}`,
      request: null,
      footnote: 'The task comes back to you if the re-check finds something.',
    };
  }
  return {
    class: 'continue-in-claude',
    title: `Continue ${id} in Claude Code`,
    description: 'Claude implements the approved plan and submits a report for your acceptance; the dashboard cannot start that.',
    instruction: `/jerry:implement ${id}`,
    request: sentBackComment(task),
    footnote: 'Claude sees your request in JERRY; if only the report needs a change, it submits a corrected report.',
  };
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
      // The user's override of failed final checks: offered only when every blocker may be waived.
      if (allowed.includes('final-checks.waived') && canWaive(task)) {
        buttons.push(
          <Button key="complete-anyway" variant="outline" size="sm" onClick={() => decisions.ask('complete-anyway')} data-complete-anyway>
            Complete anyway
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
      // Claude works now: say how to continue it (e.g. after the user sent the report back).
      if (CLAUDE_WORK_STATES.has(task.state)) {
        buttons.push(
          <Button key="continue" size="sm" variant={sentBackComment(task) !== null ? 'default' : 'outline'} onClick={decisions.continueInClaude} data-continue>
            Continue in Claude Code
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
