import type { TaskWithDecision, WorkflowTransition } from '@jerry/contracts';
import { availableEvents, STATE_LABELS } from '@jerry/workflow';
import { defineComponent, reactive, ref } from 'vue';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PlanDocumentView } from '../components/PlanDocument';
import { formatTime, isOpen, stateTone } from '../format';
import { handleError, perform, state } from '../state';

/** Decisions that need the task ID typed, like their CLI prompts. Pause and resume are one click. */
type ConfirmedAction = 'approve' | 'reject' | 'cancel';

interface PendingAction {
  task: TaskWithDecision;
  action: ConfirmedAction;
}

const DIALOG: Record<ConfirmedAction, { title: string; confirm: string; tone: 'primary' | 'danger'; note: string }> = {
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
  cancel: {
    title: 'Cancel',
    confirm: 'Cancel task',
    tone: 'danger',
    note: 'Cancelling cannot be undone. The task and its history stay on record; its plan no longer covers any edits.',
  },
};

export const Tasks = defineComponent({
  name: 'Tasks',
  setup() {
    const pending = ref<PendingAction | null>(null);
    const busy = ref(false);
    /** Loaded on demand; null while loading. */
    const histories = reactive<Record<string, WorkflowTransition[] | null>>({});

    const confirm = async (typed: string): Promise<void> => {
      const current = pending.value;
      if (current === null) return;
      const { task, action } = current;
      busy.value = true;
      const done =
        action === 'cancel'
          ? await perform(() => api.control(task.taskId, 'task.cancelled', typed), `Cancelled ${task.taskId}.`)
          : await perform(() => api.decide(task, action === 'approve' ? 'APPROVED' : 'REJECTED', typed), `${action === 'approve' ? 'Approved' : 'Rejected'} ${task.taskId} plan v${task.plan.version}.`);
      busy.value = false;
      if (done) {
        pending.value = null;
        if (histories[task.taskId] !== undefined) void loadHistory(task.taskId);
      }
    };

    const control = async (task: TaskWithDecision, event: 'task.paused' | 'task.resumed'): Promise<void> => {
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

    const actions = (task: TaskWithDecision) => {
      const allowed = availableEvents(task.state, 'user');
      const ask = (action: ConfirmedAction) => () => (pending.value = { task, action });
      const buttons = [];
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

    const card = (task: TaskWithDecision) => (
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
        </dl>
        {isOpen(task) && task.plan.document !== undefined && <PlanDocumentView plan={task.plan.document} />}
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
              title={`${DIALOG[pending.value.action].title} ${pending.value.task.taskId}${pending.value.action === 'cancel' ? '' : ` plan v${pending.value.task.plan.version}`}`}
              expected={pending.value.task.taskId}
              confirmLabel={DIALOG[pending.value.action].confirm}
              tone={DIALOG[pending.value.action].tone}
              busy={busy.value}
              onConfirm={confirm}
              onCancel={() => (pending.value = null)}
            >
              <p>{pending.value.task.title}</p>
              <p class="muted">Scope: {pending.value.task.plan.scope.join(', ')}</p>
              <p class="muted small">{DIALOG[pending.value.action].note}</p>
            </ConfirmDialog>
          )}
        </div>
      );
    };
  },
});
