import { EMOJI } from '@jerry/contracts/emoji';
import { computed, defineComponent, ref, type PropType } from 'vue';
import { cn } from '../lib/utils';
import { linkTo } from '../router';
import { renderTime, state } from '../state';
import {
  clockTime,
  collecting,
  entrypointLabel,
  exactTokens,
  formatCost,
  formatTokens,
  hasNoData,
  LIMITS_NOTE,
  percent,
  REFRESH_HINT,
  resetText,
  sourcePhrase,
  staleText,
  type UsageLimit,
  type UsageShare,
  type UsageSummary,
  type UsageTotals,
} from '../usage';
import { Emoji } from './Emoji';
import { limitClasses } from './UsageBar';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { Separator } from './ui/separator';
import { Skeleton } from './ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * One plan window, like a row of Claude's /usage: "23%" left of the bar, the window's name under the
 * bar, then when it resets and when it was read. A reading older than 30 minutes is muted as stale,
 * with how to refresh it.
 */
const LimitRow = defineComponent({
  name: 'LimitRow',
  props: {
    id: { type: String, required: true },
    title: { type: String, required: true },
    limit: { type: Object as PropType<UsageLimit | null>, default: null },
    now: { type: Date, required: true },
  },
  setup(props) {
    return () => {
      const limit = props.limit;
      const classes = limitClasses(limit, props.now);
      const stale = classes.tone === 'stale' && limit !== null ? staleText(limit, props.now) : null;
      return (
        <div class="grid gap-1.5" data-usage-limit={props.id} data-tone={classes.tone} title={stale === null ? undefined : REFRESH_HINT}>
          <div class="flex items-center gap-3">
            <span class={cn('w-12 shrink-0 text-sm tabular-nums', limit === null ? 'text-muted-foreground' : cn('font-medium', classes.text))} data-limit-value>
              {limit === null ? 'no data' : percent(limit.pct)}
            </span>
            <Progress label={props.title} class={cn('flex-1', classes.track)} indicatorClass={classes.fill} modelValue={limit?.pct ?? 0} />
          </div>
          <div class="grid gap-0.5 pl-15">
            <span class="text-sm font-medium" data-limit-label>
              {props.title}
              {stale !== null && (
                <span class="text-muted-foreground font-normal" data-limit-stale>
                  {' '}
                  · {stale}
                </span>
              )}
            </span>
            <p class="text-muted-foreground text-xs">
              {limit === null ? (
                'No current reading: plan limits arrive with the next terminal session.'
              ) : (
                <>
                  <span class="text-foreground">{capitalize(resetText(limit.resetsAt, props.now))}</span>
                  {` · last known · read at ${clockTime(limit.readAt, props.now)} ${sourcePhrase(limit.entrypoint)}`}
                </>
              )}
            </p>
            {stale !== null && (
              <p class="text-muted-foreground text-xs" data-usage-refresh>
                {REFRESH_HINT}
              </p>
            )}
          </div>
        </div>
      );
    };
  },
});

const PERIODS: Array<{ id: 'today' | 'last7d' | 'last30d'; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'last7d', label: '7 days' },
  { id: 'last30d', label: '30 days' },
];

function stat(label: string, value: string, title?: string, hint?: string) {
  return (
    <div class="grid gap-0.5 rounded-lg border p-3" title={title} data-stat={label}>
      <span class="text-muted-foreground text-xs">{label}</span>
      <span class="text-lg font-semibold tabular-nums">{value}</span>
      {hint !== undefined && <span class="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

function totalsPanel(totals: UsageTotals) {
  return (
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {stat('Tokens', formatTokens(totals.tokens), exactTokens(totals.tokens))}
      {stat('Input', formatTokens(totals.input), exactTokens(totals.input))}
      {stat('Output', formatTokens(totals.output), exactTokens(totals.output))}
      {stat('Cache read', formatTokens(totals.cacheRead), exactTokens(totals.cacheRead))}
      {stat('Cache write', formatTokens(totals.cacheCreation), exactTokens(totals.cacheCreation))}
      {stat('Cost', formatCost(totals.costUsd), `$${totals.costUsd.toFixed(4)}`, 'estimate at list price')}
    </div>
  );
}

/** Tokens per day for 30 days, in the look of shadcn's bar chart: muted grid, primary bars, a tooltip per day. */
const DailyChart = defineComponent({
  name: 'DailyChart',
  props: { days: { type: Array as PropType<UsageSummary['daily']>, required: true } },
  setup(props) {
    return () => {
      const days = props.days;
      const max = Math.max(0, ...days.map((day) => day.tokens));
      const width = Math.max(1, days.length) * 10;
      const first = days[0]?.date;
      const last = days[days.length - 1]?.date;
      return (
        <figure class="grid gap-2" data-usage-chart>
          <figcaption class="flex items-baseline justify-between gap-2 text-sm">
            <span class="font-medium">Tokens per day</span>
            <span class="text-muted-foreground text-xs tabular-nums">{max > 0 ? `top day ${formatTokens(max)}` : 'no tokens yet'}</span>
          </figcaption>
          <svg class="h-36 w-full" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" role="img" aria-label={`Tokens per day over the last ${days.length} days`}>
            {[0, 25, 50, 75].map((y) => (
              <line key={y} x1="0" x2={width} y1={y + 0.5} y2={y + 0.5} class="stroke-border" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
            ))}
            <line x1="0" x2={width} y1="99.5" y2="99.5" class="stroke-border" vector-effect="non-scaling-stroke" />
            {days.map((day, index) => {
              const height = max > 0 && day.tokens > 0 ? Math.max(1.5, (day.tokens / max) * 96) : 0;
              return (
                <g key={day.date} class="group" data-day={day.date}>
                  <title>{`${day.date}: ${exactTokens(day.tokens)} tokens · ${formatCost(day.costUsd)} (estimate)`}</title>
                  <rect x={index * 10} y="0" width="10" height="100" class="group-hover:fill-muted fill-transparent" />
                  <rect x={index * 10 + 1.5} y={100 - height} width="7" height={height} rx="1" class="fill-primary group-hover:fill-primary/80" />
                </g>
              );
            })}
          </svg>
          <div class="text-muted-foreground flex justify-between text-xs tabular-nums">
            <span>{first ?? ''}</span>
            <span>{last ?? ''}</span>
          </div>
        </figure>
      );
    };
  },
});

function shareTable<T extends UsageShare>(id: string, heading: string, column: string, rows: T[], name: (row: T) => string, title?: (row: T) => string) {
  const sorted = [...rows].sort((a, b) => b.tokens - a.tokens);
  return (
    <div class="grid content-start gap-2" data-usage-table={id}>
      <h4 class="text-sm font-medium">{heading}</h4>
      {sorted.length === 0 ? (
        <p class="text-muted-foreground text-sm">Nothing recorded.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{column}</TableHead>
              <TableHead class="text-right">Tokens</TableHead>
              <TableHead class="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={name(row)} title={title?.(row)}>
                <TableCell class="max-w-48 truncate">{name(row)}</TableCell>
                <TableCell class="text-right tabular-nums" title={exactTokens(row.tokens)}>
                  {formatTokens(row.tokens)}
                </TableCell>
                <TableCell class="text-right tabular-nums">{formatCost(row.costUsd)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** What the user can do when nothing is collected, or why some of it is not. */
function notices(usage: UsageSummary) {
  const { collection } = usage;
  const items = [];
  if (collection.statusline === 'off' && collection.telemetry === 'off') {
    items.push(
      <Alert role="status" class="usage-off" key="off">
        <AlertTitle>
          <Emoji symbol={EMOJI.info} />
          Usage collection is off
        </AlertTitle>
        <AlertDescription>
          <p>
            Turn it on in{' '}
            <a class="text-foreground underline underline-offset-4" {...linkTo({ section: 'settings' })}>
              Settings
            </a>{' '}
            or run <code class="bg-muted rounded px-1 py-0.5 text-xs">jerry usage enable</code> in a terminal.
          </p>
        </AlertDescription>
      </Alert>,
    );
  }
  if (collection.telemetry === 'clash') {
    items.push(
      <Alert role="status" class="usage-clash" key="clash">
        <AlertTitle>
          <Emoji symbol={EMOJI.info} />
          Your own OpenTelemetry settings are kept
        </AlertTitle>
        <AlertDescription>
          <p>Claude Code already sends its telemetry where you set it up, so JERRY leaves those settings alone and does not collect tokens or cost. Plan limits still come through the status line.</p>
        </AlertDescription>
      </Alert>,
    );
  }
  if (collection.statusline === 'not-jerry') {
    items.push(
      <Alert role="status" class="usage-own-statusline" key="statusline">
        <AlertTitle>
          <Emoji symbol={EMOJI.info} />
          Your own status line is kept
        </AlertTitle>
        <AlertDescription>
          <p>Plan limits reach JERRY only through its status line, so they are not collected while yours is set. Tokens and cost still are.</p>
        </AlertDescription>
      </Alert>,
    );
  }
  if (collecting(collection) && hasNoData(usage)) {
    items.push(
      <Alert role="status" class="usage-empty" key="empty">
        <AlertTitle>
          <Emoji symbol={EMOJI.waiting} />
          No usage yet
        </AlertTitle>
        <AlertDescription>
          <p>Use Claude Code for a few minutes; tokens appear within ~1 minute, plan limits after a terminal session.</p>
        </AlertDescription>
      </Alert>,
    );
  }
  return items;
}

/** JERRY's own part of Claude's context, as an estimate. */
function jerryShare(usage: UsageSummary) {
  const share = usage.jerryShare;
  const parts: Array<[string, number]> = [
    ['session start', share.sessionStart],
    ['warnings', share.warnings],
    ['MCP answers', share.mcp],
  ];
  const sum = parts.reduce((total, [, value]) => total + value, 0);
  return (
    <p class="text-muted-foreground text-sm" data-usage-jerry>
      <span class="text-foreground font-medium">JERRY's share:</span> ~{formatTokens(share.estimatedTokens30d)} tokens in 30 days (estimate)
      {sum > 0 &&
        ` · ${parts
          .filter(([, value]) => value > 0)
          .map(([name, value]) => `${name} ${Math.round((value / sum) * 100)}%`)
          .join(' · ')}`}
    </p>
  );
}

/**
 * The Overview's Usage card, laid out like Claude's /usage: the last known plan limits, then
 * tokens and estimated cost per period, per day, model, project and where Claude Code ran.
 */
export const UsageCard = defineComponent({
  name: 'UsageCard',
  setup() {
    const period = ref<string>('today');
    const usage = computed(() => state.usage);

    const body = () => {
      const current = usage.value;
      if (state.usageState === 'unavailable') {
        return <p class="text-muted-foreground text-sm usage-unavailable">Usage is not available on this Core. Update JERRY and restart Core to see Claude Code's usage here.</p>;
      }
      if (current === null) {
        if (state.usageState === 'error') {
          return (
            <Alert variant="destructive" class="usage-error">
              <AlertDescription>
                <p>Usage could not be read: {state.usageError}</p>
              </AlertDescription>
            </Alert>
          );
        }
        return <Skeleton class="h-40" />;
      }
      const now = renderTime();
      const empty = hasNoData(current);
      return (
        <div class="grid gap-6">
          {notices(current)}
          {state.usageState === 'error' && <p class="text-destructive text-xs">Not refreshed: {state.usageError}</p>}
          <section class="grid gap-4" aria-label="Plan limits">
            <LimitRow id="fiveHour" title="5h session" limit={current.limits.fiveHour} now={now} />
            <LimitRow id="sevenDay" title="Week session" limit={current.limits.sevenDay} now={now} />
            <div class="text-muted-foreground grid gap-0.5 text-xs">
              <p>Per-model weekly limits: not available from Claude Code</p>
              <p>{LIMITS_NOTE}</p>
            </div>
          </section>
          {!empty && (
            <>
              <Separator />
              <section class="grid gap-6" aria-label="Tokens and cost">
                <Tabs modelValue={period.value} onUpdate:modelValue={(value: string) => (period.value = value)} class="gap-3">
                  <TabsList aria-label="Period">
                    {PERIODS.map((entry) => (
                      <TabsTrigger key={entry.id} value={entry.id} data-tab={`usage-${entry.id}`}>
                        {entry.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {PERIODS.map((entry) => (
                    <TabsContent key={entry.id} value={entry.id} data-usage-period={entry.id}>
                      {totalsPanel(current.totals[entry.id])}
                    </TabsContent>
                  ))}
                </Tabs>
                <DailyChart days={current.daily} />
                <div class="grid gap-6 lg:grid-cols-3">
                  {shareTable('model', 'By model', 'Model', current.byModel, (row) => row.model)}
                  {shareTable('project', 'By project', 'Project', current.byProject, (row) => row.name, (row) => row.repoRoot)}
                  {shareTable(
                    'entrypoint',
                    'VS Code and terminal',
                    'Where',
                    current.byEntrypoint,
                    (row) => entrypointLabel(row.entrypoint),
                    (row) => row.entrypoint,
                  )}
                </div>
                <p class="text-muted-foreground text-xs">Tables and chart: the last 30 days. Cost is an estimate at list price, not your bill.</p>
              </section>
            </>
          )}
          {jerryShare(current)}
        </div>
      );
    };

    return () => (
      <Card class="usage-card" data-usage-card>
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.evals} />
            Usage
          </CardTitle>
          <CardDescription>Claude Code on this computer: plan limits, tokens and estimated cost.</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" as="a" {...linkTo({ section: 'settings' })}>
              Settings
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>{body()}</CardContent>
      </Card>
    );
  },
});
