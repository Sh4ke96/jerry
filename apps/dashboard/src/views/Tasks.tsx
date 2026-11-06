import type { TaskWithDecision } from '@jerry/contracts';
import { defineComponent, ref } from 'vue';
import { api } from '../api';
import { Badge, type Tone } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatTime, taskStatus, type TaskStatus } from '../format';
import { perform, state } from '../state';

const STATUS_TONE: Record<TaskStatus, Tone> = { APPROVED: 'pass', WAITING: 'warn', REJECTED: 'deny' };
const STATUS_LABEL: Record<TaskStatus, string> = { APPROVED: 'Approved', WAITING: 'Waiting for decision', REJECTED: 'Rejected' };

interface PendingDecision {
  task: TaskWithDecision;
  decision: 'APPROVED' | 'REJECTED';
}

export const Tasks = defineComponent({
  name: 'Tasks',
  setup() {
    const pending = ref<PendingDecision | null>(null);
    const busy = ref(false);

    const decide = async (typed: string): Promise<void> => {
      const current = pending.value;
      if (current === null) return;
      busy.value = true;
      const verb = current.decision === 'APPROVED' ? 'Approved' : 'Rejected';
      const done = await perform(() => api.decide(current.task, current.decision, typed), `${verb} ${current.task.taskId} plan v${current.task.plan.version}.`);
      busy.value = false;
      if (done) pending.value = null;
    };

    return () => (
      <div class="stack">
        {state.tasks.length === 0 ? (
          <section class="panel">
            <h2>No tasks yet</h2>
            <p class="muted">
              Create one with <code>jerry task create --repo &lt;path&gt; --title &lt;text&gt; --scope &lt;glob&gt;</code>.
            </p>
          </section>
        ) : (
          [...state.tasks].reverse().map((task) => {
            const status = taskStatus(task);
            return (
              <article class="panel task" key={task.taskId}>
                <header class="task__header">
                  <div>
                    <h2>
                      {task.taskId} <span class="task__title">{task.title}</span>
                    </h2>
                    <p class="muted">{task.repoRoot}</p>
                  </div>
                  <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
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
                      {STATUS_LABEL[status]} {formatTime(task.planDecision.approvedAt)}
                      {task.planDecision.comment !== '' && <span class="muted"> · {task.planDecision.comment}</span>}
                    </dd>,
                  ]}
                </dl>
                {status !== 'APPROVED' && (
                  <div class="actions">
                    <button class="button button--primary" onClick={() => (pending.value = { task, decision: 'APPROVED' })}>
                      Approve plan v{task.plan.version}
                    </button>
                    {status === 'WAITING' && (
                      <button class="button" onClick={() => (pending.value = { task, decision: 'REJECTED' })}>
                        Reject
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })
        )}

        {pending.value !== null && (
          <ConfirmDialog
            title={`${pending.value.decision === 'APPROVED' ? 'Approve' : 'Reject'} ${pending.value.task.taskId} plan v${pending.value.task.plan.version}`}
            expected={pending.value.task.taskId}
            confirmLabel={pending.value.decision === 'APPROVED' ? 'Approve plan' : 'Reject plan'}
            tone={pending.value.decision === 'APPROVED' ? 'primary' : 'danger'}
            busy={busy.value}
            onConfirm={decide}
            onCancel={() => (pending.value = null)}
          >
            <p>{pending.value.task.title}</p>
            <p class="muted">
              Scope: {pending.value.task.plan.scope.join(', ')}
            </p>
            <p class="muted small">
              {pending.value.decision === 'APPROVED'
                ? 'Edits inside this scope pass silently; edits outside it are recorded as deviations. Hard rules stay in force.'
                : 'Claude keeps working without an approved plan; its edits in this repository are recorded as deviations.'}
            </p>
          </ConfirmDialog>
        )}
      </div>
    );
  },
});
