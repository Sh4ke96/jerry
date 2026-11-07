import { EMOJI, STATE_EMOJI } from '@jerry/contracts/emoji';
import { STATE_LABELS } from '@jerry/workflow';
import { computed, defineComponent } from 'vue';
import { Emoji, resultEmoji } from '../components/Emoji';
import { StatusBadge, toneOf } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { eventReason, eventTarget, formatDuration, formatTime, inImplementation, shortPath, startOfToday, waitsForUser } from '../format';
import { ATTENTION } from '../lib/classes';
import { state } from '../state';

/** Cards that lead to another view also answer Enter and Space. */
function linkTo(go: () => void) {
  return {
    role: 'button',
    tabindex: 0,
    onClick: go,
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        go();
      }
    },
  };
}

export const Overview = defineComponent({
  name: 'Overview',
  emits: { navigate: (view: 'tasks' | 'timeline') => typeof view === 'string' },
  setup(_props, { emit }) {
    const today = computed(() => state.events.filter((event) => event.timestamp >= startOfToday()));
    const deviationsToday = computed(() => today.value.filter((event) => event.verdict === 'WARN').length);
    const blockedToday = computed(() => today.value.filter((event) => event.verdict === 'DENY').length);
    const waiting = computed(() => state.tasks.filter(waitsForUser));
    const working = computed(() => state.tasks.filter(inImplementation));
    const recent = computed(() => state.events.filter((event) => event.verdict === 'WARN' || event.verdict === 'DENY').slice(0, 6));
    const cardLink = 'hover:border-ring focus-visible:border-ring focus-visible:ring-ring/50 cursor-pointer outline-none transition-[color,box-shadow,border-color] focus-visible:ring-3';

    return () => {
      const status = state.status;
      return (
        <div class="flex flex-col gap-4 md:gap-6">
          <section class="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs md:grid-cols-3 dark:*:data-[slot=card]:bg-card">
            <Card class="@container/card">
              <CardHeader>
                <CardDescription>
                  <Emoji symbol={EMOJI.jerry} />
                  Guard
                </CardDescription>
                <CardTitle class="text-2xl font-semibold tabular-nums">
                  <StatusBadge tone="pass" emoji={EMOJI.jerry} class="px-2.5 py-1 text-sm">
                    GUARDED
                  </StatusBadge>
                </CardTitle>
              </CardHeader>
              <CardFooter class="flex-col items-start gap-1 text-sm">
                <span class={['guard-projects', state.projects.length === 0 ? ATTENTION : 'font-medium']}>
                  {state.projects.length === 0 ? 'No projects yet: only hard rules apply' : `${state.projects.length} project(s) monitored`}
                </span>
                <span class="text-muted-foreground">
                  Core {status?.version} · running {status === null ? '' : formatDuration(status.startedAt)} · {status?.sessionCount ?? 0} sessions
                </span>
              </CardFooter>
            </Card>
            <Card class={['@container/card', cardLink]} {...linkTo(() => emit('navigate', 'tasks'))}>
              <CardHeader>
                <CardDescription>
                  <Emoji symbol={EMOJI.task} />
                  Tasks
                </CardDescription>
                <CardTitle class="text-2xl font-semibold tabular-nums">{working.value.length} in implementation</CardTitle>
              </CardHeader>
              <CardFooter class={['text-sm', waiting.value.length > 0 ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground']}>{waiting.value.length} waiting for your decision</CardFooter>
            </Card>
            <Card class={['@container/card', cardLink]} {...linkTo(() => emit('navigate', 'timeline'))}>
              <CardHeader>
                <CardDescription>
                  <Emoji symbol={blockedToday.value > 0 ? EMOJI.blocked : deviationsToday.value > 0 ? EMOJI.warning : EMOJI.pass} />
                  Today
                </CardDescription>
                <CardTitle class="text-2xl font-semibold tabular-nums">
                  {deviationsToday.value} <span class="text-muted-foreground text-base font-normal">deviations</span>
                </CardTitle>
              </CardHeader>
              <CardFooter class={['text-sm', blockedToday.value > 0 ? 'text-destructive font-medium' : 'text-muted-foreground']}>{blockedToday.value} blocked by hard rules</CardFooter>
            </Card>
          </section>

          {waiting.value.length > 0 && (
            <Card class="border-amber-500/50">
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.waiting} />
                  Waiting for your decision
                </CardTitle>
                <CardAction>
                  <Button size="sm" onClick={() => emit('navigate', 'tasks')}>
                    Review tasks
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <ul class="grid gap-2 text-sm">
                  {waiting.value.map((task) => (
                    <li key={task.taskId} class="flex flex-wrap items-baseline gap-x-2">
                      <Emoji symbol={STATE_EMOJI[task.state]} class="mr-0" />
                      <strong class="font-mono font-medium">{task.taskId}</strong> {task.title}{' '}
                      <span class="text-muted-foreground">
                        plan v{task.plan.version} · {STATE_LABELS[task.state]}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.warning} />
                Latest deviations and blocks
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recent.value.length === 0 ? (
                <p class="text-muted-foreground text-sm">Nothing recorded. Claude has stayed within the approved plans.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>JERRY</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Tool</TableHead>
                      <TableHead>Target</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recent.value.map((event) => (
                      <TableRow key={event.eventId} title={eventReason(event)}>
                        <TableCell>
                          <StatusBadge tone={toneOf(event.verdict)} emoji={resultEmoji(event.verdict)}>
                            {event.verdict}
                          </StatusBadge>
                        </TableCell>
                        <TableCell class="text-muted-foreground">{formatTime(event.timestamp)}</TableCell>
                        <TableCell>{event.toolName}</TableCell>
                        <TableCell class="font-mono text-xs whitespace-normal break-all">{shortPath(eventTarget(event))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <p class="text-muted-foreground text-xs">
            Database schema {status?.database.migration} · refreshed {state.refreshedAt?.toLocaleTimeString()}
          </p>
        </div>
      );
    };
  },
});
