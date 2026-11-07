import type { ArtifactDecision, PlanDrift, TaskSummary, WorkflowTransition } from '@jerry/contracts';
import { EMOJI, STATE_EMOJI } from '@jerry/contracts/emoji';
import { availableEvents, diffPlans, STATE_LABELS, WORK_STATES, type PlanDiff } from '@jerry/workflow';
import { defineComponent, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { AnalysisReports } from '../components/AnalysisReports';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Emoji, resultEmoji } from '../components/Emoji';
import { Fact, Facts } from '../components/Facts';
import { FindingsPanel } from '../components/Findings';
import { ArtifactsList, FinalReportView } from '../components/FinalReport';
import { ImplementationReportView } from '../components/ImplementationReport';
import { PlanDiffView } from '../components/PlanDiff';
import { PlanDocumentView } from '../components/PlanDocument';
import { PlanDriftView } from '../components/PlanDrift';
import { PlanGradeView } from '../components/PlanGrade';
import { ReviewPanel } from '../components/Review';
import { Section } from '../components/Section';
import { StatusBadge } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { formatTime, isIntake, isOpen, stateTone } from '../format';
import { CHIP, LIST } from '../lib/classes';
import { cn } from '../lib/utils';
import { handleError, perform, state } from '../state';

/** States in which the task card shows the independent review. */
const REVIEW_STATES: ReadonlySet<string> = new Set(['CODE_REVIEW', 'REVIEW_REPORT', 'WAIT_REVIEW_FIX_APPROVAL', 'FIX_IMPLEMENTATION', 'REVERIFICATION', 'FINAL_REPORT']);

/** Decisions that need the task ID typed, like their CLI prompts. Pause and resume are one click. */
type ConfirmedAction = 'approve' | 'reject' | 'accept' | 'request-changes' | 'cancel';

interface PendingAction {
  task: TaskSummary;
  action: ConfirmedAction;
}

const DIALOG: Record<ConfirmedAction, { title: string; confirm: string; tone: 'primary' | 'danger'; note: string; comment?: string }> = {
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
  accept: {
    title: 'Accept',
    confirm: 'Accept implementation',
    tone: 'primary',
    note: 'You accept exactly this report. The task moves to its final checks; Claude makes no further changes for it. Committing stays with you.',
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
};

function subjectOf(pending: PendingAction): string {
  if (pending.action === 'cancel') return pending.task.taskId;
  if (pending.action === 'accept' || pending.action === 'request-changes') return `${pending.task.taskId} report v${pending.task.lastReport?.version ?? '?'}`;
  return `${pending.task.taskId} plan v${pending.task.plan.version}`;
}

/** How many Claude Code sessions worked on the task, and whether the last one has ended. */
function sessionsText(task: TaskSummary): string {
  const { sessionCount, lastActivityAt, lastSessionEndedAt } = task.activity;
  if (sessionCount === 0 || lastActivityAt === null) return 'No session has worked on it yet';
  const count = sessionCount === 1 ? '1 session' : `${sessionCount} sessions`;
  const last = lastSessionEndedAt === null ? 'last session may still be open' : `last session ended ${formatTime(lastSessionEndedAt)}`;
  return `${count} · last activity ${formatTime(lastActivityAt)} · ${last}`;
}

export const Tasks = defineComponent({
  name: 'Tasks',
  setup() {
    const pending = ref<PendingAction | null>(null);
    const busy = ref(false);
    /** Loaded on demand; null while loading. */
    const histories = reactive<Record<string, WorkflowTransition[] | null>>({});
    /** Open plan comparisons: the current version against the one before. */
    const diffs = reactive<Record<string, PlanDiff | null>>({});
    /** Open final reports and the Artifact decisions. */
    const finalReports = reactive<Record<string, boolean>>({});
    const artifacts = ref<ArtifactDecision[]>([]);
    onMounted(() => void api.artifacts().then((list) => (artifacts.value = list), handleError));
    /** Open drift views, loaded on demand: Git is read for them. */
    const drifts = reactive<Record<string, PlanDrift | null>>({});
    const toggleDrift = async (taskId: string): Promise<void> => {
      if (drifts[taskId] !== undefined) {
        delete drifts[taskId];
        return;
      }
      drifts[taskId] = null;
      try {
        drifts[taskId] = await api.drift(taskId);
      } catch (error) {
        delete drifts[taskId];
        handleError(error);
      }
    };

    const run = (task: TaskSummary, action: ConfirmedAction, typed: string, comment: string): Promise<boolean> => {
      const report = task.lastReport;
      switch (action) {
        case 'cancel':
          return perform(() => api.control(task.taskId, 'task.cancelled', typed), `Cancelled ${task.taskId}.`);
        case 'accept':
          if (report === null) return Promise.resolve(false);
          return perform(() => api.decideReport(task, report.version, 'APPROVED', typed, comment), `Accepted ${task.taskId} report v${report.version}.`).then((done) => {
            // Core ran its final checks in the same step: say how they ended.
            const after = state.tasks.find((candidate) => candidate.taskId === task.taskId);
            if (done && after !== undefined) {
              state.notice = after.state === 'DONE' ? `Accepted ${task.taskId} report v${report.version}. JERRY's final checks passed: the task is done.` : `Accepted ${task.taskId} report v${report.version}, but JERRY's final checks did not pass.`;
            }
            return done;
          });
        case 'request-changes':
          if (report === null) return Promise.resolve(false);
          return perform(() => api.decideReport(task, report.version, 'REJECTED', typed, comment), `Requested changes to ${task.taskId} report v${report.version}.`);
        default:
          return perform(() => api.decide(task, action === 'approve' ? 'APPROVED' : 'REJECTED', typed), `${action === 'approve' ? 'Approved' : 'Rejected'} ${task.taskId} plan v${task.plan.version}.`);
      }
    };

    const confirm = async (typed: string, comment: string): Promise<void> => {
      const current = pending.value;
      if (current === null) return;
      const { task, action } = current;
      busy.value = true;
      const done = await run(task, action, typed, comment);
      busy.value = false;
      if (done) {
        pending.value = null;
        if (histories[task.taskId] !== undefined) void loadHistory(task.taskId);
      }
    };

    const control = async (task: TaskSummary, event: 'task.paused' | 'task.resumed'): Promise<void> => {
      busy.value = true;
      await perform(() => api.control(task.taskId, event), `${event === 'task.paused' ? 'Paused' : 'Resumed'} ${task.taskId}.`);
      busy.value = false;
      if (histories[task.taskId] !== undefined) void loadHistory(task.taskId);
    };

    const loadHistory = async (taskId: string): Promise<void> => {
      histories[taskId] = null;
      try {
        histories[taskId] = await api.transitions(taskId);
      } catch (error) {
        delete histories[taskId];
        handleError(error);
      }
    };

    const toggleDiff = async (task: TaskSummary): Promise<void> => {
      if (diffs[task.taskId] !== undefined) {
        delete diffs[task.taskId];
        return;
      }
      diffs[task.taskId] = null;
      try {
        const versions = await api.plans(task.taskId);
        const newer = versions.find((plan) => plan.version === task.plan.version);
        const older = versions.find((plan) => plan.version === task.plan.version - 1);
        if (newer === undefined || older === undefined) delete diffs[task.taskId];
        else diffs[task.taskId] = diffPlans(older, newer);
      } catch (error) {
        delete diffs[task.taskId];
        handleError(error);
      }
    };

    const toggleHistory = (taskId: string): void => {
      if (histories[taskId] === undefined) void loadHistory(taskId);
      else delete histories[taskId];
    };

    const actions = (task: TaskSummary) => {
      const allowed = availableEvents(task.state, 'user');
      const ask = (action: ConfirmedAction) => () => (pending.value = { task, action });
      const decisions = [];
      const views = [];
      if (allowed.includes('implementation.accepted') && task.lastReport !== null) {
        decisions.push(
          <Button key="accept" size="sm" onClick={ask('accept')}>
            Accept implementation
          </Button>,
        );
      }
      if (allowed.includes('changes.requested') && task.lastReport !== null) {
        decisions.push(
          <Button key="request-changes" variant="outline" size="sm" onClick={ask('request-changes')}>
            Request changes
          </Button>,
        );
      }
      if (allowed.includes('plan.approved')) {
        decisions.push(
          <Button key="approve" size="sm" onClick={ask('approve')}>
            Approve plan v{task.plan.version}
          </Button>,
        );
      }
      if (allowed.includes('plan.rejected')) {
        decisions.push(
          <Button key="reject" variant="outline" size="sm" onClick={ask('reject')}>
            {task.state === 'IMPLEMENTATION' ? 'Withdraw approval' : 'Reject'}
          </Button>,
        );
      }
      if (allowed.includes('task.paused')) {
        decisions.push(
          <Button key="pause" variant="outline" size="sm" disabled={busy.value} onClick={() => control(task, 'task.paused')}>
            Pause
          </Button>,
        );
      }
      if (allowed.includes('task.resumed')) {
        decisions.push(
          <Button key="resume" size="sm" disabled={busy.value} onClick={() => control(task, 'task.resumed')}>
            Resume
          </Button>,
        );
      }
      if (allowed.includes('task.cancelled')) {
        decisions.push(
          <Button key="cancel" variant="ghost" size="sm" class="text-destructive hover:text-destructive" onClick={ask('cancel')}>
            Cancel task
          </Button>,
        );
      }
      if (WORK_STATES.has(task.state) && task.plan.document !== undefined) {
        views.push(
          <Button key="drift" variant="ghost" size="sm" onClick={() => void toggleDrift(task.taskId)}>
            {drifts[task.taskId] === undefined ? 'Plan drift' : 'Hide drift'}
          </Button>,
        );
      }
      if (task.plan.version > 1) {
        views.push(
          <Button key="diff" variant="ghost" size="sm" onClick={() => void toggleDiff(task)}>
            {diffs[task.taskId] === undefined ? `Changes since v${task.plan.version - 1}` : 'Hide changes'}
          </Button>,
        );
      }
      if (task.lastReport !== null) {
        views.push(
          <Button key="final-report" variant="ghost" size="sm" onClick={() => (finalReports[task.taskId] = !finalReports[task.taskId])}>
            {finalReports[task.taskId] === true ? 'Hide final report' : 'Final report'}
          </Button>,
        );
      }
      views.push(
        <Button key="history" variant="ghost" size="sm" onClick={() => toggleHistory(task.taskId)}>
          {histories[task.taskId] === undefined ? 'History' : 'Hide history'}
        </Button>,
      );
      return (
        <div class="flex flex-wrap items-center gap-2 border-t pt-4">
          {decisions}
          <div class="flex flex-wrap gap-1 sm:ml-auto">{views}</div>
        </div>
      );
    };

    const history = (taskId: string) => {
      const steps = histories[taskId];
      if (steps === undefined) return null;
      if (steps === null) return <p class="text-muted-foreground text-xs">Loading history…</p>;
      if (steps.length === 0) return <p class="text-muted-foreground text-xs">No transitions recorded; the task predates workflow states.</p>;
      return (
        <ol class="history grid gap-1.5 rounded-lg border p-4 text-sm">
          {steps.map((step, index) => (
            <li key={index}>
              <Emoji symbol={STATE_EMOJI[step.to]} />
              <span class="text-muted-foreground">{formatTime(step.at)}</span> {step.from === null ? 'created' : STATE_LABELS[step.from]} → <strong class="font-medium">{STATE_LABELS[step.to]}</strong>{' '}
              <span class="text-muted-foreground">
                {step.event} by {step.actor}
                {step.reason !== '' && ` · ${step.reason}`}
              </span>
            </li>
          ))}
        </ol>
      );
    };

    const card = (task: TaskSummary) => (
      <Card class="task" key={task.taskId} data-task-id={task.taskId}>
        <CardHeader>
          <CardTitle class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
            <span class="font-mono">{task.taskId}</span> <span class="font-normal">{task.title}</span>
          </CardTitle>
          <CardDescription class="font-mono text-xs break-all">{task.repoRoot}</CardDescription>
          <CardAction>
            <StatusBadge tone={stateTone(task.state)} emoji={STATE_EMOJI[task.state]}>
              {STATE_LABELS[task.state]}
            </StatusBadge>
          </CardAction>
        </CardHeader>
        <CardContent class="grid gap-4">
          <Facts>
            {task.goal !== undefined && <Fact label="Goal">{task.goal}</Fact>}
            <Fact label="Plan">{isIntake(task) ? `none yet: analysis first · taken in ${formatTime(task.plan.createdAt)}` : `version ${task.plan.version} · created ${formatTime(task.plan.createdAt)}`}</Fact>
            {/* An intake's scope is only the area to analyse; nothing is approved yet. */}
            <Fact label={isIntake(task) ? 'Analysis focus' : 'Scope'}>
              <div class="flex flex-wrap gap-1.5">
                {task.plan.scope.map((glob) => (
                  <code class={CHIP} key={glob}>
                    {glob}
                  </code>
                ))}
              </div>
            </Fact>
            <Fact label="Hash">
              <code class="text-muted-foreground font-mono text-xs break-all">{task.plan.contentHash}</code>
            </Fact>
            {task.planDecision !== null && (
              <Fact label="Decision">
                {task.planDecision.decision === 'APPROVED' ? 'Approved' : 'Rejected'} {formatTime(task.planDecision.approvedAt)}
                {task.planDecision.comment !== '' && <span class="text-muted-foreground"> · {task.planDecision.comment}</span>}
              </Fact>
            )}
            <Fact label="Sessions">{sessionsText(task)}</Fact>
            {task.lastTestRun !== null && (
              <Fact label="Last tests">
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge tone={task.lastTestRun.result === 'PASS' ? 'pass' : task.lastTestRun.result === 'FAIL' ? 'deny' : 'warn'} emoji={resultEmoji(task.lastTestRun.result)}>
                    {task.lastTestRun.result}
                  </StatusBadge>{' '}
                  <code class="font-mono text-xs">{task.lastTestRun.command}</code>{' '}
                  <span class="text-muted-foreground text-xs">
                    {task.lastTestRun.summary ?? (task.lastTestRun.exitCode === null ? '' : `exit ${task.lastTestRun.exitCode}`)} · {formatTime(task.lastTestRun.at)} · run by Claude, seen by JERRY
                  </span>
                </div>
              </Fact>
            )}
            {task.lastReport !== null && (
              <Fact label="Report">
                version {task.lastReport.version} · {formatTime(task.lastReport.createdAt)} ·{' '}
                {task.reportDecision === null ? 'waiting for your decision' : task.reportDecision.decision === 'APPROVED' ? `accepted ${formatTime(task.reportDecision.approvedAt)}` : `changes requested ${formatTime(task.reportDecision.approvedAt)}`}
                {task.reportDecision !== null && task.reportDecision.comment !== '' && <span class="text-muted-foreground"> · {task.reportDecision.comment}</span>}
              </Fact>
            )}
          </Facts>
          {task.lastCheckpoint !== null && (
            <section class="checkpoint bg-muted/50 grid gap-1.5 rounded-lg border-l-2 border-l-primary p-4 text-sm">
              <h3 class="flex flex-wrap items-center gap-x-2 font-medium">
                <Emoji symbol={EMOJI.next} class="mr-0" />
                Last checkpoint <span class="text-muted-foreground text-xs font-normal">{formatTime(task.lastCheckpoint.at)} · written by Claude</span>
              </h3>
              <p>{task.lastCheckpoint.summary}</p>
              {task.lastCheckpoint.nextSteps.length > 0 && (
                <ol class="grid list-decimal gap-1 pl-5">
                  {task.lastCheckpoint.nextSteps.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              )}
            </section>
          )}
          {REVIEW_STATES.has(task.state) && <ReviewPanel task={task} />}
          <div>
            <AnalysisReports analyses={task.analyses} runs={task.agentRuns} />
            <FindingsPanel task={task} />
            {task.planGrade !== null && !isIntake(task) && task.lastReport === null && <PlanGradeView grade={task.planGrade} />}
            {task.lastReport !== null && task.state !== 'WAIT_IMPLEMENTATION_ACCEPTANCE' && (
              <Section title={`Implementation report v${task.lastReport.version}`} emoji={EMOJI.report}>
                <ImplementationReportView report={task.lastReport} />
              </Section>
            )}
            {isOpen(task) && task.plan.document !== undefined && task.lastReport !== null && (
              <Section title={`Approved plan v${task.plan.version}`} emoji={EMOJI.plan}>
                <PlanDocumentView plan={task.plan.document} />
              </Section>
            )}
          </div>
          {task.lastReport !== null && task.state === 'WAIT_IMPLEMENTATION_ACCEPTANCE' && <ImplementationReportView report={task.lastReport} />}
          {isOpen(task) && task.plan.document !== undefined && task.lastReport === null && <PlanDocumentView plan={task.plan.document} />}
          {task.finalCheck !== null && (
            <section class={cn('final-check grid gap-2 rounded-lg border p-4 text-sm', task.finalCheck.passed ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5')} data-passed={task.finalCheck.passed ? 'true' : 'false'}>
              <h3 class="flex flex-wrap items-center gap-x-2 font-medium">
                <Emoji symbol={task.finalCheck.passed ? EMOJI.done : EMOJI.fail} class="mr-0" />
                {task.finalCheck.passed ? 'Completed by JERRY' : 'JERRY did not complete the task'}{' '}
                <span class="text-muted-foreground text-xs font-normal">
                  final checks {formatTime(task.finalCheck.at)}
                  {task.finalCheck.reportVersion !== null && ` · report v${task.finalCheck.reportVersion}`}
                </span>
              </h3>
              <ul class={LIST}>
                {task.finalCheck.conditions.map((condition) => (
                  <li key={condition.id}>
                    <StatusBadge tone={condition.passed ? 'pass' : condition.blocking ? 'deny' : 'warn'} emoji={resultEmoji(condition.passed ? 'PASS' : condition.blocking ? 'FAIL' : 'WARN')}>
                      {condition.passed ? 'ok' : condition.blocking ? 'blocks' : 'note'}
                    </StatusBadge>{' '}
                    {condition.detail}
                  </li>
                ))}
              </ul>
              {!task.finalCheck.passed && <p class="text-muted-foreground text-xs">Request changes to send the work back to Claude, or cancel the task.</p>}
            </section>
          )}
          {actions(task)}
          {finalReports[task.taskId] === true && <FinalReportView taskId={task.taskId} />}
          {drifts[task.taskId] === null && <p class="text-muted-foreground text-xs">Reading the repository…</p>}
          {drifts[task.taskId] != null && <PlanDriftView drift={drifts[task.taskId]!} />}
          {diffs[task.taskId] === null && <p class="text-muted-foreground text-xs">Loading plan versions…</p>}
          {diffs[task.taskId] != null && <PlanDiffView diff={diffs[task.taskId]!} />}
          {history(task.taskId)}
        </CardContent>
      </Card>
    );

    return () => {
      const newestFirst = [...state.tasks].reverse();
      const open = newestFirst.filter(isOpen);
      const closed = newestFirst.filter((task) => !isOpen(task));
      return (
        <div class="flex flex-col gap-4 md:gap-6">
          {state.tasks.length === 0 && (
            <Card>
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.task} />
                  No tasks yet
                </CardTitle>
                <CardDescription>
                  Ask Claude for a plan with <code class={CHIP}>/jerry:plan</code>, or create one with <code class={CHIP}>jerry task create --repo &lt;path&gt; --title &lt;text&gt; --scope &lt;glob&gt;</code>.
                </CardDescription>
              </CardHeader>
            </Card>
          )}
          {open.map(card)}
          <ArtifactsList decisions={artifacts.value} />
          {closed.length > 0 && (
            <Card class="closed-tasks py-2">
              <CardContent>
                <Section title={`Finished and cancelled (${closed.length})`} emoji={EMOJI.done}>
                  <div class="flex flex-col gap-4">{closed.map(card)}</div>
                </Section>
              </CardContent>
            </Card>
          )}

          {pending.value !== null && (
            <ConfirmDialog
              title={`${DIALOG[pending.value.action].title} ${subjectOf(pending.value)}`}
              expected={pending.value.task.taskId}
              confirmLabel={DIALOG[pending.value.action].confirm}
              tone={DIALOG[pending.value.action].tone}
              busy={busy.value}
              commentLabel={DIALOG[pending.value.action].comment}
              onConfirm={confirm}
              onCancel={() => (pending.value = null)}
            >
              <p class="text-foreground">{pending.value.task.title}</p>
              <p>Scope: {pending.value.task.plan.scope.join(', ')}</p>
              {pending.value.action === 'accept' && (pending.value.task.plan.document?.definitionOfDone.length ?? 0) > 0 && (
                <div class="grid gap-1">
                  <p>You confirm the plan's Definition of Done:</p>
                  <ul class="text-foreground grid list-disc gap-1 pl-5">
                    {pending.value.task.plan.document?.definitionOfDone.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p class="text-xs">{DIALOG[pending.value.action].note}</p>
            </ConfirmDialog>
          )}
        </div>
      );
    };
  },
});
