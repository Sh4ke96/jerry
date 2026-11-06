import { computed, defineComponent, ref } from 'vue';
import { Badge, toneOf } from '../components/Badge';
import { eventReason, eventTarget, formatTime, shortPath } from '../format';
import { state } from '../state';

type Filter = 'all' | 'tools' | 'deviations' | 'blocked';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'tools', label: 'Tool calls' },
  { id: 'deviations', label: 'Deviations' },
  { id: 'blocked', label: 'Blocked' },
];

export const Timeline = defineComponent({
  name: 'Timeline',
  setup() {
    const filter = ref<Filter>('all');
    const visible = computed(() =>
      state.events.filter((event) => {
        switch (filter.value) {
          case 'tools':
            return event.eventType === 'PreToolUse' || event.eventType === 'PostToolUse' || event.eventType === 'PostToolUseFailure';
          case 'deviations':
            return event.verdict === 'WARN';
          case 'blocked':
            return event.verdict === 'DENY';
          case 'all':
            return true;
        }
      }),
    );

    return () => (
      <div class="stack">
        <div class="filters" role="tablist" aria-label="Filter events">
          {FILTERS.map((option) => (
            <button key={option.id} role="tab" aria-selected={filter.value === option.id} class={['chip-button', filter.value === option.id && 'chip-button--active']} onClick={() => (filter.value = option.id)}>
              {option.label}
            </button>
          ))}
        </div>
        <section class="panel panel--flush">
          {visible.value.length === 0 ? (
            <p class="muted padded">No events for this filter.</p>
          ) : (
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Tool or agent</th>
                    <th>JERRY</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.value.map((event) => (
                    <tr key={event.eventId} title={eventReason(event)}>
                      <td class="nowrap">{formatTime(event.timestamp)}</td>
                      <td class="nowrap">{event.eventType}</td>
                      <td class="nowrap">{shortPath(event.toolName ?? event.agentType ?? '', 40)}</td>
                      <td class="nowrap">
                        {event.verdict !== null && <Badge tone={toneOf(event.verdict)} title={event.ruleId ?? undefined}>{event.verdict}</Badge>}
                        {event.spooled && <Badge title="Recorded while Core was down">spooled</Badge>}
                      </td>
                      <td class="target">
                        <code>{shortPath(eventTarget(event), 90)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <p class="muted small">Showing the latest {state.events.length} events. Hover a row for JERRY's reason.</p>
      </div>
    );
  },
});
