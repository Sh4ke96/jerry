import type { TaskSummary, WorkflowTransition } from '@jerry/contracts';
import { availableEvents, STATE_LABELS } from '@jerry/workflow';
import { defineComponent, reactive, ref } from 'vue';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AnalysisReports } from '../components/AnalysisReports';
import { ImplementationReportView } from '../components/ImplementationReport';
import { PlanDocumentView } from '../components/PlanDocument';
import { formatTime, isOpen, stateTone } from '../format';
import { handleError, perform, state } from '../state';

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

    const toggleHistory = (taskId: string): void => {
      if (histories[taskId] === undefined) void loadHistory(taskId);
      else delete histories[taskId];
    };

    const actions = (task: TaskSummary) => {
      const allowed = availableEvents(task.state, 'user');
      const ask = (action: ConfirmedAction) => () => (pending.value = { task, action });
      const buttons = [];
      if (allowed.includes('implementation.accepted') && task.lastReport !== null) {
        buttons.push(
          <button key="accept" class="button button--primary" onClick={ask('accept')}>
            Accept implementation
          </button>,
        );
      }
      if (allowed.includes('changes.requested') && task.lastReport !== null) {
        buttons.push(
          <button key="request-changes" class="button" onClick={ask('request-changes')}>
            Request changes
          </button>,
        );
      }
      if (allowed.includes('plan.approved')) {
        buttons.push(
          <button key="approve" class="button button--primary" onClick={ask('approve')}>
            Approve plan v{task.plan.version}
          </button>,
        );
      }
      if (allowed.includes('plan.rejected')) {
        buttons.push(
          <button key="reject" class="button" onClick={ask('reject')}>
            {task.state === 'IMPLEMENTATION' ? 'Withdraw approval' : 'Reject'}
          </button>,
        );
      }
      if (allowed.includes('task.paused')) {
        buttons.push(
          <button key="pause" class="button" disabled={busy.value} onClick={() => control(task, 'task.paused')}>
            Pause
          </button>,
        );
      }
      if (allowed.includes('task.resumed')) {
        buttons.push(
          <button key="resume" class="button button--primary" disabled={busy.value} onClick={() => control(task, 'task.resumed')}>
            Resume
          </button>,
        );
      }
      if (allowed.includes('task.cancelled')) {
        buttons.push(
          <button key="cancel" class="button button--quiet" onClick={ask('cancel')}>
            Cancel task
          </button>,
        );
      }
      buttons.push(
        <button key="history" class="button button--quiet" onClick={() => toggleHistory(task.taskId)}>
          {histories[task.taskId] === undefined ? 'History' : 'Hide history'}
        </button>,
      );
      return <div class="actions">{buttons}</div>;
    };

    const history = (taskId: string) => {
      const steps = histories[taskId];
      if (steps === undefined) return null;
      if (steps === null) return <p class="muted small">Loading history…</p>;
      if (steps.length === 0) return <p class="muted small">No transitions recorded; the task predates workflow states.</p>;
      return (
        <ol class="history">
          {steps.map((step, index) => (
            <li key={index}>
              <span class="muted">{formatTime(step.at)}</span> {step.from === null ? 'created' : STATE_LABELS[step.from]} → <strong>{STATE_LABELS[step.to]}</strong>{' '}
              <span class="muted">
                {step.event} by {step.actor}
                {step.reason !== '' && ` · ${step.reason}`}
              </span>
            </li>
          ))}
        </ol>
      );
    };

    const card = (task: TaskSummary) => (
      <article class="panel task" key={task.taskId}>
        <header class="task__header">
          <div>
            <h2>
              {task.taskId} <span class="task__title">{task.title}</span>
            </h2>
            <p class="muted">{task.repoRoot}</p>
          </div>
          <Badge tone={stateTone(task.state)}>{STATE_LABELS[task.state]}</Badge>
        </header>
        <dl class="facts">
          <dt>Plan</dt>
          <dd>
            version {task.plan.version} · created {formatTime(task.plan.createdAt)}
          </dd>
          <dt>Scope</dt>
          <dd class="chips">
            {task.plan.scope.map((glob) => (
              <code class="chip" key={glob}>
                {glob}
              </code>
            ))}
          </dd>
          <dt>Hash</dt>
          <dd>
            <code class="hash">{task.plan.contentHash}</code>
          </dd>
          {task.planDecision !== null && [
            <dt key="decision-label">Decision</dt>,
            <dd key="decision-value">
              {task.planDecision.decision === 'APPROVED' ? 'Approved' : 'Rejected'} {formatTime(task.planDecision.approvedAt)}
              {task.planDecision.comment !== '' && <span class="muted"> · {task.planDecision.comment}</span>}
            </dd>,
          ]}
          <dt>Sessions</dt>
          <dd>{sessionsText(task)}</dd>
          {task.lastReport !== null && [
            <dt key="report-label">Report</dt>,
            <dd key="report-value">
              version {task.lastReport.version} · {formatTime(task.lastReport.createdAt)} ·{' '}
              {task.reportDecision === null ? 'waiting for your decision' : task.reportDecision.decision === 'APPROVED' ? `accepted ${formatTime(task.reportDecision.approvedAt)}` : `changes requested ${formatTime(task.reportDecision.approvedAt)}`}
              {task.reportDecision !== null && task.reportDecision.comment !== '' && <span class="muted"> · {task.reportDecision.comment}</span>}
            </dd>,
          ]}
        </dl>
        {task.lastCheckpoint !== null && (
          <section class="checkpoint">
            <h3>
              Last checkpoint <span class="muted small">{formatTime(task.lastCheckpoint.at)} · written by Claude</span>
            </h3>
            <p>{task.lastCheckpoint.summary}</p>
            {task.lastCheckpoint.nextSteps.length > 0 && (
              <ol>
                {task.lastCheckpoint.nextSteps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            )}
          </section>
        )}
        <AnalysisReports analyses={task.analyses} runs={task.agentRuns} />
        {task.lastReport !== null &&
          (task.state === 'WAIT_IMPLEMENTATION_ACCEPTANCE' ? (
            <ImplementationReportView report={task.lastReport} />
          ) : (
            <details class="plan-section">
              <summary>Implementation report v{task.lastReport.version}</summary>
              <ImplementationReportView report={task.lastReport} />
            </details>
          ))}
        {isOpen(task) &&
          task.plan.document !== undefined &&
          (task.lastReport === null ? (
            <PlanDocumentView plan={task.plan.document} />
          ) : (
            <details class="plan-section">
              <summary>Approved plan v{task.plan.version}</summary>
              <PlanDocumentView plan={task.plan.document} />
            </details>
          ))}
        {task.finalCheck !== null && (
          <section class={['final-check', task.finalCheck.passed ? 'final-check--passed' : 'final-check--failed']}>
            <h3>
              {task.finalCheck.passed ? 'Completed by JERRY' : 'JERRY did not complete the task'}{' '}
              <span class="muted small">
                final checks {formatTime(task.finalCheck.at)}
                {task.finalCheck.reportVersion !== null && ` · report v${task.finalCheck.reportVersion}`}
              </span>
            </h3>
            <ul class="list">
              {task.finalCheck.conditions.map((condition) => (
                <li key={condition.id}>
                  <Badge tone={condition.passed ? 'pass' : condition.blocking ? 'deny' : 'warn'}>{condition.passed ? 'ok' : condition.blocking ? 'blocks' : 'note'}</Badge> {condition.detail}
                </li>
              ))}
            </ul>
            {!task.finalCheck.passed && <p class="muted small">Request changes to send the work back to Claude, or cancel the task.</p>}
          </section>
        )}
        {actions(task)}
        {history(task.taskId)}
      </article>
    );

    return () => {
      const newestFirst = [...state.tasks].reverse();
      const open = newestFirst.filter(isOpen);
      const closed = newestFirst.filter((task) => !isOpen(task));
      return (
        <div class="stack">
          {state.tasks.length === 0 && (
            <section class="panel">
              <h2>No tasks yet</h2>
              <p class="muted">
                Ask Claude for a plan with <code>/jerry:plan</code>, or create one with <code>jerry task create --repo &lt;path&gt; --title &lt;text&gt; --scope &lt;glob&gt;</code>.
              </p>
            </section>
          )}
          {open.map(card)}
          {closed.length > 0 && (
            <details class="panel">
              <summary>Finished and cancelled ({closed.length})</summary>
              <div class="stack">{closed.map(card)}</div>
            </details>
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
              <p>{pending.value.task.title}</p>
              <p class="muted">Scope: {pending.value.task.plan.scope.join(', ')}</p>
              {pending.value.action === 'accept' && (pending.value.task.plan.document?.definitionOfDone.length ?? 0) > 0 && (
                <div class="dod">
                  <p>You confirm the plan's Definition of Done:</p>
                  <ul class="list">
                    {pending.value.task.plan.document?.definitionOfDone.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p class="muted small">{DIALOG[pending.value.action].note}</p>
            </ConfirmDialog>
          )}
        </div>
      );
    };
  },
});
