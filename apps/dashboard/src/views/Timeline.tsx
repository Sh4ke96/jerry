import { EMOJI } from '@jerry/contracts/emoji';
import { computed, defineComponent, ref } from 'vue';
import { resultEmoji } from '../components/Emoji';
import { StatusBadge, toneOf } from '../components/StatusBadge';
import { Card } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
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

    const table = () =>
      visible.value.length === 0 ? (
        <p class="text-muted-foreground p-6 text-sm">No events for this filter.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="pl-4">Time</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>Tool or agent</TableHead>
              <TableHead>JERRY</TableHead>
              <TableHead class="pr-4">Target</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.value.map((event) => (
              <TableRow key={event.eventId} title={eventReason(event)}>
                <TableCell class="text-muted-foreground pl-4">{formatTime(event.timestamp)}</TableCell>
                <TableCell>{event.eventType}</TableCell>
                <TableCell>{shortPath(event.toolName ?? event.agentType ?? '', 40)}</TableCell>
                <TableCell>
                  <div class="flex gap-1">
                    {event.verdict !== null && (
                      <StatusBadge tone={toneOf(event.verdict)} title={event.ruleId ?? undefined} emoji={resultEmoji(event.verdict)}>
                        {event.verdict}
                      </StatusBadge>
                    )}
                    {event.spooled && (
                      <StatusBadge title="Recorded while Core was down" emoji={EMOJI.waiting}>
                        spooled
                      </StatusBadge>
                    )}
                  </div>
                </TableCell>
                <TableCell class="min-w-60 pr-4 font-mono text-xs whitespace-normal break-all">{shortPath(eventTarget(event), 90)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );

    return () => (
      <Tabs modelValue={filter.value} onUpdate:modelValue={(value: string) => (filter.value = value as Filter)} class="gap-4">
        <TabsList aria-label="Filter events" class="max-w-full overflow-x-auto">
          {FILTERS.map((option) => (
            <TabsTrigger key={option.id} value={option.id}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {FILTERS.map((option) => (
          <TabsContent key={option.id} value={option.id}>
            <Card class="gap-0 overflow-hidden py-0">{table()}</Card>
          </TabsContent>
        ))}
        <p class="text-muted-foreground text-xs">Showing the latest {state.events.length} events. Hover a row for JERRY's reason.</p>
      </Tabs>
    );
  },
});
