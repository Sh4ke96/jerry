import { defineComponent, type PropType } from 'vue';
import { cn } from '../lib/utils';
import { linkTo } from '../router';
import { showsUsageBar } from '../settings';
import { renderTime, state } from '../state';
import { LIMITS_NOTE, limitExpired, limitStale, limitTone, percent, readText, REFRESH_HINT, resetText, staleText, TONE_CLASSES, type UsageLimit } from '../usage';
import { Progress } from './ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/** Bar and text classes of a limit: by tone, muted when there is no value, the window has reset or the reading is stale. */
export function limitClasses(limit: UsageLimit | null, now: Date): { track: string; fill: string; text: string; tone: string } {
  if (limit === null) return { track: 'bg-muted', fill: 'fill-muted-foreground', text: 'text-muted-foreground', tone: 'none' };
  if (limitExpired(limit, now)) return { track: 'bg-muted', fill: 'fill-muted-foreground/60', text: 'text-muted-foreground', tone: 'expired' };
  if (limitStale(limit, now)) return { track: 'bg-muted', fill: 'fill-muted-foreground/60', text: 'text-muted-foreground', tone: 'stale' };
  const tone = limitTone(limit.pct);
  return { ...TONE_CLASSES[tone], tone };
}

/** One window in the top bar: "23%" left of a thin bar, its name under the bar ("5h session · stale · 43 min" when old). */
const LimitMeter = defineComponent({
  name: 'LimitMeter',
  props: {
    name: { type: String, required: true },
    label: { type: String, required: true },
    limit: { type: Object as PropType<UsageLimit | null>, default: null },
    now: { type: Date, required: true },
  },
  setup(props) {
    return () => {
      const classes = limitClasses(props.limit, props.now);
      const stale = classes.tone === 'stale' && props.limit !== null ? staleText(props.limit, props.now) : null;
      return (
        <span class="flex items-center gap-1.5 text-xs whitespace-nowrap tabular-nums" data-limit={props.name} data-tone={classes.tone}>
          <span class={cn('font-medium', classes.text)} data-limit-value>
            {props.limit === null ? <span class="font-normal">no data</span> : percent(props.limit.pct)}
          </span>
          <span class="grid gap-0.5">
            <Progress class={cn('h-1.5 w-12 lg:w-16', classes.track)} indicatorClass={classes.fill} modelValue={props.limit?.pct ?? 0} />
            <span class="text-muted-foreground text-[10px] leading-none" data-limit-label>
              {props.label}
              {stale !== null && <span data-limit-stale> · {stale}</span>}
            </span>
          </span>
        </span>
      );
    };
  },
});

function windowLine(name: string, limit: UsageLimit | null, now: Date): string {
  return limit === null ? `${name}: no data yet` : `${name}: ${percent(limit.pct)} used, ${resetText(limit.resetsAt, now)}`;
}

/**
 * The last known plan limits in the top bar of every view, while the user keeps the bar on. A
 * link to the Overview's Usage card; its tooltip says when and where the values were read, and how
 * to refresh them when they are stale.
 */
export const UsageBar = defineComponent({
  name: 'UsageBar',
  setup() {
    return () => {
      const usage = state.usage;
      if (usage === null || !showsUsageBar(state.settings)) return null;
      const now = renderTime();
      const { fiveHour, sevenDay } = usage.limits;
      const latest = [fiveHour, sevenDay].filter((limit): limit is UsageLimit => limit !== null).sort((a, b) => b.readAt.localeCompare(a.readAt))[0];
      const stale = [fiveHour, sevenDay].some((limit) => limit !== null && !limitExpired(limit, now) && limitStale(limit, now));
      const summary = `Plan usage: 5-hour ${fiveHour === null ? 'no data' : percent(fiveHour.pct)}, week ${sevenDay === null ? 'no data' : percent(sevenDay.pct)}${stale ? ' (stale)' : ''}. Open the usage on the Overview.`;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              data-usage-bar
              aria-label={summary}
              class="hover:bg-accent focus-visible:ring-ring/50 hidden items-center gap-3 rounded-md px-2 py-1 transition-colors outline-none focus-visible:ring-3 sm:flex"
              {...linkTo({ section: 'overview' })}
            >
              <LimitMeter name="5h" label="5h session" limit={fiveHour} now={now} />
              <LimitMeter name="week" label="Week session" limit={sevenDay} now={now} />
            </a>
          </TooltipTrigger>
          <TooltipContent class="grid max-w-xs gap-1 text-left" data-usage-tooltip>
            <p>{windowLine('5-hour window', fiveHour, now)}</p>
            <p>{windowLine('Week', sevenDay, now)}</p>
            {latest !== undefined && <p>{readText(latest, now)}</p>}
            {stale && <p data-usage-refresh>{REFRESH_HINT}</p>}
            <p class="opacity-70">{LIMITS_NOTE}</p>
          </TooltipContent>
        </Tooltip>
      );
    };
  },
});
