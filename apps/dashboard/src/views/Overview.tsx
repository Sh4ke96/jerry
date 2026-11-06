import { computed, defineComponent } from 'vue';
import { Badge, toneOf } from '../components/Badge';
import { STATE_LABELS } from '@jerry/workflow';
import { eventReason, eventTarget, formatDuration, formatTime, inImplementation, shortPath, startOfToday, waitsForUser } from '../format';
import { state } from '../state';

export const Overview = defineComponent({
  name: 'Overview',
  emits: { navigate: (tab: 'tasks' | 'timeline') => typeof tab === 'string' },
  setup(_props, { emit }) {
    const today = computed(() => state.events.filter((event) => event.timestamp >= startOfToday()));
    const deviationsToday = computed(() => today.value.filter((event) => event.verdict === 'WARN').length);
    const blockedToday = computed(() => today.value.filter((event) => event.verdict === 'DENY').length);
    const waiting = computed(() => state.tasks.filter(waitsForUser));
    const working = computed(() => state.tasks.filter(inImplementation));
    const recent = computed(() => state.events.filter((event) => event.verdict === 'WARN' || event.verdict === 'DENY').slice(0, 6));

    return () => {
      const status = state.status;
      return (
        <div class="stack">
          <section class="cards">
            <article class="card">
              <h3>Guard</h3>
              <p class="metric">
                <Badge tone="pass">GUARDED</Badge>
              </p>
              <p class="muted">
                Core {status?.version} · running {status === null ? '' : formatDuration(status.startedAt)} · {status?.sessionCount ?? 0} sessions
              </p>
            </article>
            <article class="card card--link" onClick={() => emit('navigate', 'tasks')}>
              <h3>Tasks</h3>
              <p class="metric">{working.value.length} in implementation</p>
              <p class={waiting.value.length > 0 ? 'attention' : 'muted'}>{waiting.value.length} waiting for your decision</p>
            </article>
            <article class="card card--link" onClick={() => emit('navigate', 'timeline')}>
              <h3>Today</h3>
              <p class="metric">
                {deviationsToday.value} <span class="metric__unit">deviations</span>
              </p>
              <p class={blockedToday.value > 0 ? 'attention' : 'muted'}>{blockedToday.value} blocked by hard rules</p>
            </article>
          </section>

          {waiting.value.length > 0 && (
            <section class="panel panel--attention">
              <h2>Waiting for your decision</h2>
              <ul class="list">
                {waiting.value.map((task) => (
                  <li key={task.taskId}>
                    <strong>{task.taskId}</strong> {task.title} <span class="muted">plan v{task.plan.version} · {STATE_LABELS[task.state]}</span>
                  </li>
                ))}
              </ul>
              <button class="button button--primary" onClick={() => emit('navigate', 'tasks')}>
                Review tasks
              </button>
            </section>
          )}

          <section class="panel">
            <h2>Latest deviations and blocks</h2>
            {recent.value.length === 0 ? (
              <p class="muted">Nothing recorded. Claude has stayed within the approved plans.</p>
            ) : (
              <ul class="list">
                {recent.value.map((event) => (
                  <li key={event.eventId} title={eventReason(event)}>
                    <Badge tone={toneOf(event.verdict)}>{event.verdict}</Badge> <span class="muted">{formatTime(event.timestamp)}</span> {event.toolName}{' '}
                    <code>{shortPath(eventTarget(event))}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p class="muted small">
            Database schema {status?.database.migration} · refreshed {state.refreshedAt?.toLocaleTimeString()}
          </p>
        </div>
      );
    };
  },
});
