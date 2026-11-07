import type { ReviewState, TaskSummary } from '@jerry/contracts';
import { EMOJI, SEVERITY_EMOJI, STATE_EMOJI } from '@jerry/contracts/emoji';
import { STATE_LABELS } from '@jerry/workflow';
import { ChevronDown } from '@lucide/vue';
import { defineComponent, ref, watch, type PropType } from 'vue';
import { api } from '../api';
import { formatTime, stateTone, waitsForUser } from '../format';
import { ATTENTION, CHIP } from '../lib/classes';
import { lastActivity, nextStepText, projectName, REVIEW_STATES, versionsText } from '../lib/tasks';
import { cn } from '../lib/utils';
import { linkTo, navigate, taskHref } from '../router';
import { taskReviewRequested } from '../settings';
import { handleError } from '../state';
import { Emoji, resultEmoji } from './Emoji';
import { Fact, Facts } from './Facts';
import { StatusBadge } from './StatusBadge';
import { effectiveReviewMode, TaskActions, TaskMenu } from './TaskActions';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';

/** The amber marker of a task whose next step is the user's. */
export const WaitingMarker = defineComponent({
  name: 'WaitingMarker',
  setup() {
    return () => (
      <Badge variant="outline" class="waiting-marker border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400" title="The next step is your decision">
        <Emoji symbol={EMOJI.waiting} class="mr-0" />
        waiting for you
      </Badge>
    );
  },
});

/** The independent review in a few words: requested or not, and the round while it runs. */
export function reviewSummary(task: TaskSummary, review: ReviewState | null): string | null {
  const requested = taskReviewRequested(task);
  if (REVIEW_STATES.has(task.state)) {
    const round = review?.rounds.at(-1)?.round;
    return round === undefined ? 'in review' : `in review · round ${round} of at most ${review?.maxRounds ?? 3}`;
  }
  if (requested === true) return 'requested';
  if (requested === false) return 'not requested';
  const mode = effectiveReviewMode(task);
  if (mode === null) return null;
  return task.lastReport === null || task.reportDecision === null ? `decided at acceptance (review is ${mode})` : `review is ${mode}`;
}

/** The latest checks: Claude's last test run and JERRY's final checks. */
export function checksSummary(task: TaskSummary) {
  const run = task.lastTestRun;
  const final = task.finalCheck;
  if (run === null && final === null) return <span class="text-muted-foreground">none yet</span>;
  return (
    <div class="grid gap-1">
      {run !== null && (
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge tone={run.result === 'PASS' ? 'pass' : run.result === 'FAIL' ? 'deny' : 'warn'} emoji={resultEmoji(run.result)}>
            {run.result}
          </StatusBadge>
          <code class="font-mono text-xs break-all">{run.command}</code>
          <span class="text-muted-foreground text-xs">{formatTime(run.at)}</span>
        </div>
      )}
      {final !== null && (
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge tone={final.passed ? 'pass' : 'deny'} emoji={final.passed ? EMOJI.done : EMOJI.fail}>
            {final.passed ? 'final checks passed' : 'final checks failed'}
          </StatusBadge>
          <span class="text-muted-foreground text-xs">
            {final.conditions.filter((condition) => !condition.passed && condition.blocking).length} blocking · {formatTime(final.at)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Open quality findings by severity, most urgent first. */
export function findingsSummary(task: TaskSummary) {
  const counts = task.findings;
  if (counts === null || counts.open === 0) return <span class="text-muted-foreground">none open</span>;
  return (
    <div class="flex flex-wrap gap-1.5">
      {(['P1', 'P2', 'P3', 'P4'] as const)
        .filter((severity) => counts.bySeverity[severity] > 0)
        .map((severity) => (
          <StatusBadge key={severity} tone={severity === 'P1' || severity === 'P2' ? 'deny' : 'warn'} emoji={SEVERITY_EMOJI[severity]}>
            {counts.bySeverity[severity]} {severity}
          </StatusBadge>
        ))}
    </div>
  );
}

/** Clicks on these do their own thing; elsewhere in the tile header a click opens the task page. */
const INTERACTIVE = 'a, button, input, [role="menuitem"], [role="switch"], [data-slot="collapsible-content"]';

/**
 * A task as a tile: who, where and what state at a glance. The chevron unfolds the key facts and the
 * decisions in place; a click on the header opens the task's own page.
 */
export const TaskTile = defineComponent({
  name: 'TaskTile',
  props: {
    task: { type: Object as PropType<TaskSummary>, required: true },
    /** Hide the project name (on the project's own page). */
    hideProject: { type: Boolean, default: false },
  },
  setup(props) {
    const open = ref(false);
    const review = ref<ReviewState | null>(null);

    const loadReview = async (): Promise<void> => {
      if (!open.value || !REVIEW_STATES.has(props.task.state)) return;
      try {
        review.value = await api.review(props.task.taskId);
      } catch (error) {
        handleError(error);
      }
    };
    watch(open, () => void loadReview());
    watch(
      () => props.task.state,
      () => void loadReview(),
    );

    const openPage = (event: MouseEvent): void => {
      if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
      navigate(taskHref(props.task.taskId));
    };

    return () => {
      const task = props.task;
      const waiting = waitsForUser(task);
      const summary = reviewSummary(task, review.value);
      return (
        <Card class={cn('task gap-0 py-0 transition-[border-color,box-shadow] hover:shadow-md', waiting && 'border-amber-500/50')} data-task-id={task.taskId} data-state={task.state}>
          <Collapsible open={open.value} onUpdate:open={(value: boolean) => (open.value = value)}>
            <div class="task-tile__header grid cursor-pointer gap-2 p-4" onClick={openPage}>
              <div class="flex items-start gap-2">
                <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <a class="font-mono text-sm font-medium hover:underline" {...linkTo(taskHref(task.taskId))}>
                    {task.taskId}
                  </a>
                  <StatusBadge tone={stateTone(task.state)} emoji={STATE_EMOJI[task.state]}>
                    {STATE_LABELS[task.state]}
                  </StatusBadge>
                  {waiting && <WaitingMarker />}
                </div>
                <div class="-mt-1 -mr-2 flex shrink-0 items-center">
                  <TaskMenu task={task} />
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={open.value ? `Fold ${task.taskId}` : `Unfold ${task.taskId}`} data-expand class="[&[data-state=open]>svg]:rotate-180">
                      <ChevronDown class="transition-transform duration-200" />
                    </Button>
                  </CollapsibleTrigger>
                </div>
              </div>
              <a class="line-clamp-2 leading-snug font-semibold hover:underline" {...linkTo(taskHref(task.taskId))}>
                {task.title}
              </a>
              <p class="text-muted-foreground flex flex-wrap gap-x-1.5 text-xs">
                {!props.hideProject && (
                  <span class="flex items-center" title={task.repoRoot}>
                    <Emoji symbol={EMOJI.repository} class="mr-1" />
                    {projectName(task.repoRoot)}
                  </span>
                )}
                {!props.hideProject && <span aria-hidden="true">·</span>}
                <span>{versionsText(task)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatTime(lastActivity(task))}</span>
              </p>
            </div>
            <CollapsibleContent>
              <div class="task-tile__details grid gap-4 border-t p-4">
                <Facts class="gap-x-4 text-xs sm:text-sm">
                  {task.goal !== undefined && <Fact label="Goal">{task.goal}</Fact>}
                  {task.goal === undefined && task.plan.document !== undefined && <Fact label="Goal">{task.plan.document.goal}</Fact>}
                  <Fact label="Next">
                    <span class={waiting ? ATTENTION : undefined}>{nextStepText(task)}</span>
                  </Fact>
                  <Fact label="Checks">{checksSummary(task)}</Fact>
                  <Fact label="Findings">{findingsSummary(task)}</Fact>
                  {summary !== null && <Fact label="Review">{summary}</Fact>}
                  <Fact label="Scope">
                    <div class="flex flex-wrap gap-1">
                      {task.plan.scope.map((glob) => (
                        <code class={CHIP} key={glob}>
                          {glob}
                        </code>
                      ))}
                    </div>
                  </Fact>
                </Facts>
                <TaskActions task={task} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      );
    };
  },
});
