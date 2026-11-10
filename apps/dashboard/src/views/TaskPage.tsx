import type { PlanDrift, TaskSummary, WorkflowTransition } from '@jerry/contracts';
import { EMOJI, STATE_EMOJI } from '@jerry/contracts/emoji';
import { diffPlans, STATE_LABELS, WORK_STATES, type PlanDiff } from '@jerry/workflow';
import { ArrowLeft } from '@lucide/vue';
import { computed, defineComponent, onMounted, ref, watch } from 'vue';
import { api } from '../api';
import { AnalysisReports } from '../components/AnalysisReports';
import { Emoji, resultEmoji } from '../components/Emoji';
import { Fact, Facts } from '../components/Facts';
import { FindingsPanel } from '../components/Findings';
import { FinalReportView } from '../components/FinalReport';
import { ImplementationReportView } from '../components/ImplementationReport';
import { PlanDiffView } from '../components/PlanDiff';
import { PlanDocumentView } from '../components/PlanDocument';
import { PlanDriftView } from '../components/PlanDrift';
import { PlanGradeView } from '../components/PlanGrade';
import { ReviewPanel } from '../components/Review';
import { StatusBadge } from '../components/StatusBadge';
import { ARTIFACT_KIND_LABEL, artifactChoice, effectiveReviewMode, TaskActions, TaskMenu } from '../components/TaskActions';
import { checksSummary, findingsSummary, reviewSummary, WaitingMarker } from '../components/TaskTile';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Loading } from '../components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { formatTime, isIntake, stateTone, waitsForUser } from '../format';
import { CHIP, LIST } from '../lib/classes';
import { remedyFor } from '../lib/final-checks';
import { lastActivity, nextStepText, projectName, REVIEW_STATES, REVIEWER_STATES, taskRepositories, versionsText } from '../lib/tasks';
import { cn } from '../lib/utils';
import { linkTo, projectHref, taskHref } from '../router';
import { taskReviewRequested } from '../settings';
import { handleError, perform, state } from '../state';

/**
 * The Artifact of a task: the recorded decision once there is one, else the user's switch (with the
 * kind), which stays changeable until then. An older Core sends no artifact field: nothing is shown.
 */
function artifactFact(task: TaskSummary) {
  const artifact = task.artifact;
  if (artifact === undefined) return null;
  const { decision, request } = artifact;
  if (decision !== null) {
    return (
      <Fact label="Artifact">
        <span data-artifact-decision={decision.decision}>
          {decision.decision === 'created' && decision.url !== null ? (
            <a class="hover:underline" href={decision.url} target="_blank" rel="noopener noreferrer">
              {decision.title ?? 'Artifact'}
            </a>
          ) : (
            <span class="text-muted-foreground">declined{decision.reason === '' ? '' : ` · ${decision.reason}`}</span>
          )}{' '}
          <span class="text-muted-foreground text-xs">{formatTime(decision.at)}</span>
        </span>
      </Fact>
    );
  }
  if (task.state === 'CANCELLED') return null;
  const save = (next: { wanted: boolean; kind: keyof typeof ARTIFACT_KIND_LABEL }) =>
    void perform(() => api.setArtifactRequest(task.taskId, next), next.wanted ? `${task.taskId}: Claude creates ${ARTIFACT_KIND_LABEL[next.kind].toLowerCase()} when the task is done.` : `${task.taskId}: no Artifact.`);
  return (
    <Fact label="Artifact">
      <div class="grid gap-1">
        {artifactChoice(`task-artifact-${task.taskId}`, request?.wanted === true, request?.kind ?? 'stakeholder-presentation', save)}
        {request?.by === 'plan' && <span class="text-muted-foreground text-xs">From your answer in the plan; the switch overrides it.</span>}
      </div>
    </Fact>
  );
}

type TaskTab = 'overview' | 'plan' | 'analysis' | 'report' | 'review' | 'final' | 'history';

const TABS: Array<{ id: TaskTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'plan', label: 'Plan' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'report', label: 'Implementation report' },
  { id: 'review', label: 'Review' },
  { id: 'final', label: 'Final report' },
  { id: 'history', label: 'History' },
];

/** The tab with the user's next decision, else the overview. */
function defaultTab(task: TaskSummary): TaskTab {
  if (task.state === 'WAIT_PLAN_APPROVAL' || task.state === 'PLAN_DRAFT') return 'plan';
  if (task.state === 'WAIT_IMPLEMENTATION_ACCEPTANCE') return 'report';
  if (REVIEW_STATES.has(task.state)) return 'review';
  return 'overview';
}

/** How many Claude Code sessions worked on the task, and whether the last one has ended. */
function sessionsText(task: TaskSummary): string {
  const { sessionCount, lastActivityAt, lastSessionEndedAt } = task.activity;
  if (sessionCount === 0 || lastActivityAt === null) return 'No session has worked on it yet';
  const count = sessionCount === 1 ? '1 session' : `${sessionCount} sessions`;
  const last = lastSessionEndedAt === null ? 'last session may still be open' : `last session ended ${formatTime(lastSessionEndedAt)}`;
  return `${count} · last activity ${formatTime(lastActivityAt)} · ${last}`;
}

/** The workflow transitions of a task, loaded when shown. */
const TaskHistory = defineComponent({
  name: 'TaskHistory',
  props: { taskId: { type: String, required: true } },
  setup(props) {
    const steps = ref<WorkflowTransition[] | null>(null);
    onMounted(async () => {
      try {
        steps.value = await api.transitions(props.taskId);
      } catch (error) {
        handleError(error);
      }
    });
    return () => {
      if (steps.value === null) return <Loading class="text-xs" text="Loading history…" />;
      if (steps.value.length === 0) return <p class="text-muted-foreground text-xs">No transitions recorded; the task predates workflow states.</p>;
      return (
        <ol class="history grid gap-1.5 text-sm">
          {steps.value.map((step, index) => (
            <li key={index}>
              <Emoji symbol={STATE_EMOJI[step.to]} />
              <span class="text-muted-foreground">{formatTime(step.at)}</span> {step.from === null ? 'created' : STATE_LABELS[step.from]} → <strong class="font-medium">{STATE_LABELS[step.to]}</strong>{' '}
              <span class="text-muted-foreground">
                {step.event} by {step.actor}
                {step.reason !== '' && ` · ${step.reason}`}
              </span>
            </li>
          ))}
        </ol>
      );
    };
  },
});

const Empty = defineComponent({
  name: 'Empty',
  setup(_props, { slots }) {
    return () => <p class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">{slots.default?.()}</p>;
  },
});

/** One task with everything JERRY knows about it, in tabs; the decisions are in the header. */
export const TaskPage = defineComponent({
  name: 'TaskPage',
  props: { taskId: { type: String, required: true } },
  setup(props) {
    const task = computed(() => state.tasks.find((candidate) => candidate.taskId === props.taskId));
    const tab = ref<TaskTab>(task.value === undefined ? 'overview' : defaultTab(task.value));
    /** Changed after a decision, so the history shows it. */
    const revision = ref(0);
    /** The plan comparison and the drift, loaded on demand; null while loading. */
    const diff = ref<PlanDiff | null | undefined>(undefined);
    const drift = ref<PlanDrift | null | undefined>(undefined);

    watch(
      () => props.taskId,
      () => {
        tab.value = task.value === undefined ? 'overview' : defaultTab(task.value);
        diff.value = undefined;
        drift.value = undefined;
      },
    );
    // Opened by its address before the tasks were loaded: choose the tab once the task is known.
    watch(
      () => task.value !== undefined,
      (known, before) => {
        if (known && before === false && task.value !== undefined) tab.value = defaultTab(task.value);
      },
    );

    const toggleDiff = async (current: TaskSummary): Promise<void> => {
      if (diff.value !== undefined) {
        diff.value = undefined;
        return;
      }
      diff.value = null;
      try {
        const versions = await api.plans(current.taskId);
        const newer = versions.find((plan) => plan.version === current.plan.version);
        const older = versions.find((plan) => plan.version === current.plan.version - 1);
        diff.value = newer === undefined || older === undefined ? undefined : diffPlans(older, newer);
      } catch (error) {
        diff.value = undefined;
        handleError(error);
      }
    };

    const toggleDrift = async (current: TaskSummary): Promise<void> => {
      if (drift.value !== undefined) {
        drift.value = undefined;
        return;
      }
      drift.value = null;
      try {
        drift.value = await api.drift(current.taskId);
      } catch (error) {
        drift.value = undefined;
        handleError(error);
      }
    };

    const header = (current: TaskSummary) => (
      <Card class="task-page__header gap-4">
        <CardHeader class="gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-sm font-medium">{current.taskId}</span>
            <StatusBadge tone={stateTone(current.state)} emoji={STATE_EMOJI[current.state]}>
              {STATE_LABELS[current.state]}
            </StatusBadge>
            {waitsForUser(current) && <WaitingMarker />}
            <span class="ml-auto">
              <TaskMenu task={current} onChanged={() => (revision.value += 1)} />
            </span>
          </div>
          <CardTitle class="text-xl leading-tight">{current.title}</CardTitle>
          <CardDescription class="flex flex-wrap items-center gap-x-1.5 text-xs">
            {/* Every repository of the task, its own first: a task across a workspace names each one. */}
            <span class="task-repositories flex flex-wrap items-center">
              <Emoji symbol={EMOJI.repository} class="mr-1" />
              {taskRepositories(current).map((repository, index) => (
                <span key={repository.repoRoot} class="flex items-center">
                  {index > 0 && <span class="mr-1">,</span>}
                  <a class="text-foreground font-medium hover:underline" title={repository.repoRoot} data-task-page-repo={repository.repoRoot} {...linkTo(projectHref(repository.repoRoot))}>
                    {repository.name}
                  </a>
                </span>
              ))}
            </span>
            <span aria-hidden="true">·</span>
            <code class="font-mono break-all">{current.repoRoot}</code>
            <span aria-hidden="true">·</span>
            <span>{versionsText(current)}</span>
            <span aria-hidden="true">·</span>
            <span>last activity {formatTime(lastActivity(current))}</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TaskActions task={current} onChanged={() => (revision.value += 1)} />
        </CardContent>
      </Card>
    );

    const finalCheck = (current: TaskSummary) => {
      const check = current.finalCheck;
      if (check === null) return null;
      const failed = check.conditions.filter((condition) => condition.blocking && !condition.passed);
      // An older Core sends no later-work list.
      const laterWork = (check.laterWork as typeof check.laterWork | undefined) ?? [];
      return (
        <section class={cn('final-check grid gap-2 rounded-lg border p-4 text-sm', check.passed ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-destructive/40 bg-destructive/5')} data-passed={check.passed ? 'true' : 'false'}>
          <h3 class="flex flex-wrap items-center gap-x-2 font-medium">
            <Emoji symbol={check.passed ? EMOJI.done : EMOJI.fail} class="mr-0" />
            {check.passed ? 'Completed by JERRY' : 'JERRY did not complete the task'}{' '}
            <span class="text-muted-foreground text-xs font-normal">
              final checks {formatTime(check.at)}
              {check.reportVersion !== null && ` · report v${check.reportVersion}`}
            </span>
          </h3>
          {failed.length > 0 && (
            <div class="final-check__failed grid gap-1">
              <p class="font-medium">What blocks it</p>
              <ul class={LIST}>
                {failed.map((condition) => (
                  <li key={condition.id} data-condition={condition.id}>
                    <StatusBadge tone="deny" emoji={resultEmoji('FAIL')}>
                      blocks
                    </StatusBadge>{' '}
                    {condition.detail}
                    {current.state === 'FINAL_REPORT' && (
                      <p class="text-muted-foreground mt-0.5 text-xs" data-remedy>
                        What fixes it: {remedyFor(condition.id).text}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {laterWork.length > 0 && (
            <div class="final-check__later-work grid gap-1">
              <p class="font-medium">Changed later by other tasks</p>
              <p class="text-muted-foreground text-xs">Their approved work after this report; it does not hold this task back.</p>
              <ul class={LIST}>
                {laterWork.map((work) => (
                  <li key={work.taskId} data-later-task={work.taskId}>
                    <a class="font-mono font-medium hover:underline" {...linkTo(taskHref(work.taskId))}>
                      {work.taskId}
                    </a>
                    {': '}
                    {work.files.map((file, index) => (
                      <span key={file}>
                        {index > 0 && ', '}
                        <code class="font-mono text-xs">{file}</code>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul class={LIST}>
            {check.conditions.filter((condition) => !failed.includes(condition)).map((condition) => (
              <li key={condition.id}>
                <StatusBadge tone={condition.passed ? 'pass' : condition.blocking ? 'deny' : 'warn'} emoji={resultEmoji(condition.passed ? 'PASS' : condition.blocking ? 'FAIL' : 'WARN')}>
                  {condition.passed ? 'ok' : condition.blocking ? 'blocks' : 'note'}
                </StatusBadge>{' '}
                {condition.detail}
              </li>
            ))}
          </ul>
          {!check.passed && <p class="text-muted-foreground text-xs">Re-run the final checks when what blocks it is resolved (for example after a later task reported), request changes to send the work back to Claude, or cancel the task.</p>}
        </section>
      );
    };

    const overview = (current: TaskSummary) => {
      const review = reviewSummary(current, null);
      return (
        <div class="grid gap-4">
          <Facts>
            {current.goal !== undefined && <Fact label="Goal">{current.goal}</Fact>}
            {current.goal === undefined && current.plan.document !== undefined && <Fact label="Goal">{current.plan.document.goal}</Fact>}
            <Fact label="Next step">{nextStepText(current)}</Fact>
            <Fact label="Plan">{isIntake(current) ? `none yet: analysis first · taken in ${formatTime(current.plan.createdAt)}` : `version ${current.plan.version} · created ${formatTime(current.plan.createdAt)}`}</Fact>
            {/* An intake's scope is only the area to analyse; nothing is approved yet. */}
            <Fact label={isIntake(current) ? 'Analysis focus' : (current.plan.repositories ?? []).length > 0 ? `Scope in ${projectName(current.repoRoot)}` : 'Scope'}>
              <div class="flex flex-wrap gap-1.5">
                {current.plan.scope.map((glob) => (
                  <code class={CHIP} key={glob}>
                    {glob}
                  </code>
                ))}
              </div>
            </Fact>
            {/* A plan across several repositories of a workspace: each other one with its own scope. */}
            {(current.plan.repositories ?? []).map((repository) => (
              <Fact key={repository.repoRoot} label={`Scope in ${projectName(repository.repoRoot)}`}>
                <div class="task-repository flex flex-wrap items-center gap-1.5" data-task-repository={repository.repoRoot} title={repository.repoRoot}>
                  {repository.scope.map((glob) => (
                    <code class={CHIP} key={glob}>
                      {glob}
                    </code>
                  ))}
                  {repository.exclude.length > 0 && <span class="text-muted-foreground text-xs">not {repository.exclude.join(', ')}</span>}
                </div>
              </Fact>
            ))}
            <Fact label="Hash">
              <code class="text-muted-foreground font-mono text-xs break-all">{current.plan.contentHash}</code>
            </Fact>
            {current.planDecision !== null && (
              <Fact label="Decision">
                {current.planDecision.decision === 'APPROVED' ? 'Approved' : 'Rejected'} {formatTime(current.planDecision.approvedAt)}
                {current.planDecision.comment !== '' && <span class="text-muted-foreground"> · {current.planDecision.comment}</span>}
              </Fact>
            )}
            <Fact label="Activity">{sessionsText(current)}</Fact>
            <Fact label="Checks">{checksSummary(current)}</Fact>
            {current.lastTestRun !== null && current.lastTestRun.summary !== null && (
              <Fact label="Last tests">
                <span class="text-muted-foreground text-xs">
                  {current.lastTestRun.summary} · run by Claude, seen by JERRY
                </span>
              </Fact>
            )}
            {current.lastReport !== null && (
              <Fact label="Report">
                version {current.lastReport.version} · {formatTime(current.lastReport.createdAt)} ·{' '}
                {current.reportDecision === null ? 'waiting for your decision' : current.reportDecision.decision === 'APPROVED' ? `accepted ${formatTime(current.reportDecision.approvedAt)}` : `changes requested ${formatTime(current.reportDecision.approvedAt)}`}
                {current.reportDecision !== null && current.reportDecision.comment !== '' && <span class="text-muted-foreground"> · {current.reportDecision.comment}</span>}
              </Fact>
            )}
            <Fact label="Findings">{findingsSummary(current)}</Fact>
            {review !== null && <Fact label="Review">{review}</Fact>}
            {artifactFact(current)}
          </Facts>
          {current.lastCheckpoint !== null && (
            <section class="checkpoint bg-muted/50 grid gap-1.5 rounded-lg border-l-2 border-l-primary p-4 text-sm">
              <h3 class="flex flex-wrap items-center gap-x-2 font-medium">
                <Emoji symbol={EMOJI.next} class="mr-0" />
                Last checkpoint <span class="text-muted-foreground text-xs font-normal">{formatTime(current.lastCheckpoint.at)} · written by Claude</span>
              </h3>
              <p>{current.lastCheckpoint.summary}</p>
              {current.lastCheckpoint.nextSteps.length > 0 && (
                <ol class="grid list-decimal gap-1 pl-5">
                  {current.lastCheckpoint.nextSteps.map((step, index) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              )}
            </section>
          )}
          {finalCheck(current)}
          <div>
            <FindingsPanel task={current} />
          </div>
        </div>
      );
    };

    const plan = (current: TaskSummary) => (
      <div class="grid gap-4">
        <div class="flex flex-wrap gap-2">
          {current.plan.version > 1 && (
            <Button variant="outline" size="sm" onClick={() => void toggleDiff(current)}>
              {diff.value === undefined ? `Changes since v${current.plan.version - 1}` : 'Hide changes'}
            </Button>
          )}
          {WORK_STATES.has(current.state) && current.plan.document !== undefined && (
            <Button variant="outline" size="sm" onClick={() => void toggleDrift(current)}>
              {drift.value === undefined ? 'Plan drift' : 'Hide drift'}
            </Button>
          )}
        </div>
        {diff.value === null && <Loading class="text-xs" text="Loading plan versions…" />}
        {diff.value != null && <PlanDiffView diff={diff.value} />}
        {drift.value === null && <p class="text-muted-foreground text-xs">Reading the repository…</p>}
        {drift.value != null && <PlanDriftView drift={drift.value} />}
        {current.planGrade !== null && !isIntake(current) && <PlanGradeView grade={current.planGrade} />}
        {current.plan.document !== undefined ? <PlanDocumentView plan={current.plan.document} /> : <Empty>{isIntake(current) ? 'No plan yet: the task is being analysed first.' : 'This plan was created with a scope only; it has no document.'}</Empty>}
      </div>
    );

    const content = (current: TaskSummary, id: TaskTab) => {
      switch (id) {
        case 'overview':
          return overview(current);
        case 'plan':
          return plan(current);
        case 'analysis':
          return current.analyses.length === 0 && current.agentRuns.length === 0 ? <Empty>No analysis reports for this task.</Empty> : <AnalysisReports analyses={current.analyses} runs={current.agentRuns} />;
        case 'report':
          return current.lastReport === null ? <Empty>Claude has not submitted an implementation report yet.</Empty> : <ImplementationReportView report={current.lastReport} bare />;
        case 'review': {
          const summary = reviewSummary(current, null);
          const requested = taskReviewRequested(current);
          const mode = effectiveReviewMode(current);
          return (
            <div class="grid gap-4">
              <Facts>
                <Fact label="Review">{summary ?? 'not known: this JERRY Core always reviews after acceptance'}</Fact>
                {requested !== null && <Fact label="At acceptance">{requested ? 'sent to independent review' : 'accepted without review'}</Fact>}
                {mode !== null && <Fact label="Mode">{mode === 'required' ? 'required: every accepted report is reviewed' : 'optional: chosen when accepting'}</Fact>}
              </Facts>
              {REVIEWER_STATES.has(current.state) && (
                <p class="text-muted-foreground text-sm">
                  Claude runs the three read-only reviewers: start them with <code class={CHIP}>/jerry:review {current.taskId}</code> in Claude Code, or skip the review above.
                </p>
              )}
              <ReviewPanel task={current} />
            </div>
          );
        }
        case 'final':
          return current.lastReport === null ? <Empty>The final report is assembled once Claude has reported the implementation.</Empty> : <FinalReportView taskId={current.taskId} />;
        case 'history':
          return <TaskHistory key={`${current.taskId}:${revision.value}:${current.state}`} taskId={current.taskId} />;
      }
    };

    return () => {
      const current = task.value;
      if (current === undefined) {
        return (
          <Card class="task-missing">
            <CardHeader>
              <CardTitle>Task {props.taskId} not found</CardTitle>
              <CardDescription>It may have been forgotten together with its repository, or the address is mistyped.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" size="sm" as="a" {...linkTo({ section: 'tasks' })}>
                <ArrowLeft />
                All tasks
              </Button>
            </CardContent>
          </Card>
        );
      }
      return (
        <div class="task-page flex flex-col gap-4 md:gap-6" data-task-id={current.taskId}>
          {header(current)}
          <Tabs modelValue={tab.value} onUpdate:modelValue={(value: string) => (tab.value = value as TaskTab)} class="gap-4">
            <TabsList aria-label="Task sections" class="task-tabs max-w-full justify-start overflow-x-auto">
              {TABS.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id} data-tab={entry.id} class="flex-none">
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {TABS.map((entry) => (
              <TabsContent key={entry.id} value={entry.id} class={`task-tab task-tab--${entry.id}`}>
                <Card class="py-4">
                  <CardContent class="px-4 md:px-6">{content(current, entry.id)}</CardContent>
                </Card>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      );
    };
  },
});
