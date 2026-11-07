import type { EvalRunnerStatus, EvalRunSummary, EvalStatus } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { Play, Square, X } from '@lucide/vue';
import { defineComponent, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Emoji } from '../components/Emoji';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { formatTime } from '../format';
import { ATTENTION } from '../lib/classes';
import { evalRunHref, linkTo, navigate } from '../router';
import { handleError } from '../state';
import { runCounts } from './EvalRunPage';

/** How often the page asks how a running eval run goes. */
const RUNNER_POLL_MS = 2000;
const RUNNER_STATE: Record<EvalRunnerStatus['state'], { label: string; tone: Tone; emoji: string }> = {
  idle: { label: 'idle', tone: 'neutral', emoji: EMOJI.info },
  running: { label: 'running', tone: 'accent', emoji: EMOJI.waiting },
  finished: { label: 'finished', tone: 'pass', emoji: EMOJI.pass },
  failed: { label: 'ended with errors or regressions', tone: 'warn', emoji: EMOJI.warning },
  stopped: { label: 'stopped', tone: 'neutral', emoji: EMOJI.paused },
};

/** Clicks on these do their own thing; elsewhere on a run's row a click opens its page. */
const INTERACTIVE = 'a, button';

/**
 * JERRY's evals: where things stand (baseline, latest run, what changed since the baseline,
 * calibration) and the runs as full-width rows; a click opens a run's own page with its cases.
 * "Run evals" starts `jerry eval run` in the background (Core runs it); its progress panel shows
 * while a run runs or has just ended and can be closed. Choosing a baseline is on a run's page.
 */
export const Evals = defineComponent({
  name: 'Evals',
  setup() {
    const runs = ref<EvalRunSummary[]>([]);
    const status = ref<EvalStatus | null>(null);
    const calibration = ref<Array<{ rubricId: string; labels: number; agreement: number; calibrated: boolean }>>([]);
    const busy = ref(false);
    const runner = ref<EvalRunnerStatus | null>(null);
    /** The progress panel: shown after a start, or for a run that is running when the page opens; closable. */
    const panelOpen = ref(false);
    /** The run dialog: open, and the suite chosen in it ('' for all cases). */
    const asking = ref(false);
    const suite = ref('');
    const label = ref('');
    let poll: ReturnType<typeof setTimeout> | null = null;

    const load = async (): Promise<void> => {
      try {
        [runs.value, status.value, calibration.value] = await Promise.all([api.evalRuns(), api.evalStatus(), api.evalCalibration()]);
      } catch (error) {
        handleError(error);
      }
    };

    const watchRunner = async (): Promise<void> => {
      poll = null;
      try {
        const before = runner.value?.state;
        runner.value = await api.evalRunner();
        if (runner.value.state === 'running') {
          // A run that was already running when the page opened shows its progress.
          if (before === undefined) panelOpen.value = true;
          poll = setTimeout(() => void watchRunner(), RUNNER_POLL_MS);
        } else if (before === 'running') {
          // Just ended: the run it recorded joins the list.
          await load();
        }
      } catch (error) {
        handleError(error);
      }
    };
    onMounted(() => {
      void load();
      void watchRunner();
    });
    onUnmounted(() => {
      if (poll !== null) clearTimeout(poll);
    });

    const casesFor = (choice: string): number => {
      const suites = runner.value?.suites ?? [];
      return choice === '' ? suites.reduce((sum, entry) => sum + entry.cases, 0) : (suites.find((entry) => entry.suite === choice)?.cases ?? 0);
    };

    const startRun = async (): Promise<void> => {
      busy.value = true;
      try {
        runner.value = await api.startEvalRun(suite.value === '' ? null : suite.value, label.value.trim());
        asking.value = false;
        panelOpen.value = true;
        if (poll !== null) clearTimeout(poll);
        poll = setTimeout(() => void watchRunner(), RUNNER_POLL_MS);
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    const stopRun = async (): Promise<void> => {
      busy.value = true;
      try {
        runner.value = await api.stopEvalRun();
        await load();
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    const running = (): boolean => runner.value?.state === 'running';

    /** The Run evals button, or what stands in for it while a run runs with its panel closed. */
    const runControl = () => {
      const current = runner.value;
      if (current === null) return null;
      if (running() && !panelOpen.value) {
        return (
          <Button size="sm" variant="outline" data-show-progress onClick={() => (panelOpen.value = true)}>
            <Emoji symbol={EMOJI.waiting} />
            Running… Show progress
          </Button>
        );
      }
      return (
        <Button size="sm" data-run-evals disabled={busy.value || running() || current.unavailable !== null} title={current.unavailable ?? undefined} onClick={() => (asking.value = true)}>
          <Play />
          Run evals
        </Button>
      );
    };

    const runnerPanel = () => {
      const current = runner.value;
      if (current === null || !panelOpen.value || current.state === 'idle') return null;
      const shown = RUNNER_STATE[current.state];
      return (
        <Card class="eval-runner" data-runner-state={current.state}>
          <CardHeader>
            <div class="flex items-start justify-between gap-2">
              <CardTitle class="flex flex-wrap items-center gap-2">
                <Emoji symbol={EMOJI.evals} />
                Eval run
                <StatusBadge tone={shown.tone} emoji={shown.emoji}>
                  {shown.label}
                </StatusBadge>
              </CardTitle>
              <Button variant="ghost" size="icon-sm" aria-label="Close the progress panel" data-close-runner onClick={() => (panelOpen.value = false)}>
                <X />
              </Button>
            </div>
            <CardDescription>
              {current.startedAt !== null && `Started ${formatTime(current.startedAt)}`}
              {current.suite !== null && ` · suite ${current.suite}`}
              {current.label !== '' && ` · ${current.label}`}
              {current.exitCode !== null && ` · exit ${current.exitCode}`}
            </CardDescription>
          </CardHeader>
          <CardContent class="grid gap-3">
            <div class="flex flex-wrap items-center gap-2">
              {current.state === 'running' && (
                <Button size="sm" variant="outline" data-stop-evals disabled={busy.value} onClick={() => void stopRun()}>
                  <Square />
                  Stop
                </Button>
              )}
              {current.runId !== null && current.state !== 'running' && (
                <Button size="sm" data-open-run onClick={() => navigate(evalRunHref(current.runId!))}>
                  Open {current.runId}
                </Button>
              )}
            </div>
            {current.logTail.length > 0 && (
              <pre class="eval-runner__log bg-muted max-h-64 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap" aria-live="polite">
                {current.logTail.join('\n')}
              </pre>
            )}
            {current.logFile !== null && <p class="text-muted-foreground text-xs break-all">Full output: {current.logFile}</p>}
          </CardContent>
        </Card>
      );
    };

    const runRow = (run: EvalRunSummary) => (
      <li
        key={run.runId}
        class="eval-run-row bg-card hover:bg-muted/40 flex cursor-pointer flex-wrap items-center justify-between gap-3 rounded-xl border p-4 transition-colors"
        data-run-id={run.runId}
        onClick={(event: MouseEvent) => {
          if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
          navigate(evalRunHref(run.runId));
        }}
      >
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <a class="font-mono font-medium hover:underline" {...linkTo(evalRunHref(run.runId))}>
            {run.runId}
          </a>
          {run.label !== '' && <span class="truncate text-sm">{run.label}</span>}
          <span class="text-muted-foreground text-xs">{formatTime(run.finishedAt)}</span>
        </div>
        {runCounts(run)}
      </li>
    );

    return () => (
      <section class="evals flex flex-col gap-4 md:gap-6">
        <Card>
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="grid gap-1.5">
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.evals} />
                  Evals
                </CardTitle>
                {status.value !== null && (
                  <CardDescription class="flex flex-wrap items-center gap-2">
                    <span>
                      Baseline: <strong class="text-foreground font-mono font-medium">{status.value.baselineRunId ?? 'none yet'}</strong> · latest run: <span class="font-mono">{status.value.latestRunId ?? 'none'}</span>
                    </span>
                    {status.value.releaseBlocked && (
                      <StatusBadge tone="deny" emoji={EMOJI.blocked}>
                        release blocked: critical regression
                      </StatusBadge>
                    )}
                  </CardDescription>
                )}
              </div>
              {runControl()}
            </div>
          </CardHeader>
          <CardContent class="grid gap-2 text-sm">
            {status.value === null ? (
              <div class="grid gap-2">
                <span class="sr-only">Loading…</span>
                <Skeleton class="h-4 w-2/3" />
                <Skeleton class="h-4 w-1/2" />
              </div>
            ) : (
              <>
                <p class={status.value.changedSinceBaseline.length > 0 ? ATTENTION : 'text-muted-foreground'}>
                  <Emoji symbol={status.value.changedSinceBaseline.length > 0 ? EMOJI.warning : EMOJI.pass} />
                  {status.value.changedSinceBaseline.length > 0 ? `Changed since the baseline: ${status.value.changedSinceBaseline.join(', ')}. Run the evals again.` : 'Nothing JERRY ships changed since the baseline.'}
                </p>
                {calibration.value.length > 0 && (
                  <p class="text-muted-foreground text-xs">
                    Rubric calibration: {calibration.value.map((entry) => `${entry.rubricId} ${entry.labels} label(s), ${(entry.agreement * 100).toFixed(0)}%${entry.calibrated ? ' ✓' : ''}`).join(' · ')}
                  </p>
                )}
                {runner.value?.unavailable != null && <p class={ATTENTION}>{runner.value.unavailable}</p>}
              </>
            )}
          </CardContent>
        </Card>
        {runnerPanel()}
        {runs.value.length === 0 ? (
          <p class="text-muted-foreground text-sm">No eval runs yet. Start one with Run evals, or from a terminal: jerry eval run</p>
        ) : (
          <ul class="eval-runs grid grid-cols-1 gap-3" aria-label="Eval runs">
            {runs.value.map(runRow)}
          </ul>
        )}
        {asking.value && runner.value !== null && (
          <ConfirmDialog title="Run the evals?" expected="evals" confirmLabel="Run evals" busy={busy.value} onConfirm={() => void startRun()} onCancel={() => (asking.value = false)}>
            <div class="grid gap-3">
              <p>
                Starts real Claude Code sessions in the background, each in its own temporary repository: {casesFor(suite.value)} case(s). They use your Claude Code account (tokens, plan limits) and take a while. You can follow
                and stop the run here.
              </p>
              <div class="grid gap-1.5">
                <Label for="eval-suite">Cases</Label>
                <select id="eval-suite" class="border-input bg-background h-9 rounded-md border px-3 text-sm" value={suite.value} onChange={(event: Event) => (suite.value = (event.target as HTMLSelectElement).value)}>
                  <option value="">All ({casesFor('')})</option>
                  {runner.value.suites.map((entry) => (
                    <option key={entry.suite} value={entry.suite}>
                      {entry.suite} ({entry.cases})
                    </option>
                  ))}
                </select>
              </div>
              <div class="grid gap-1.5">
                <Label for="eval-label">Label (optional)</Label>
                <Input id="eval-label" maxlength={80} placeholder="e.g. after the skills change" modelValue={label.value} onUpdate:modelValue={(value: string) => (label.value = value)} />
              </div>
            </div>
          </ConfirmDialog>
        )}
      </section>
    );
  },
});
