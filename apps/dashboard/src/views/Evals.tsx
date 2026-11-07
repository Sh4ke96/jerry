import type { EvalRunDetail, EvalRunnerStatus, EvalRunSummary, EvalStatus } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { Play, Square } from '@lucide/vue';
import { defineComponent, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Emoji } from '../components/Emoji';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatTime } from '../format';
import { ATTENTION } from '../lib/classes';
import { handleError, perform } from '../state';

const OUTCOME_TONE: Record<string, Tone> = { PASS: 'pass', FAIL: 'deny', FLAKY: 'warn', ERROR: 'warn' };
const COMPARISON_TONE: Record<string, Tone> = { REGRESSION: 'deny', FIXED: 'pass', UNCHANGED: 'neutral', FLAKY: 'warn', NEW: 'accent', MISSING: 'warn', ERROR: 'warn' };
const OUTCOME_EMOJI: Record<string, string> = { PASS: EMOJI.pass, FAIL: EMOJI.fail, FLAKY: EMOJI.warning, ERROR: EMOJI.fail };
/** An unchanged case has no emoji of its own: its result column shows the outcome. */
const COMPARISON_EMOJI: Record<string, string> = { REGRESSION: EMOJI.blocked, FIXED: EMOJI.pass, FLAKY: EMOJI.warning, NEW: EMOJI.info, MISSING: EMOJI.warning, ERROR: EMOJI.fail };

/** How often the page asks how a running eval run goes. */
const RUNNER_POLL_MS = 2000;
const RUNNER_STATE: Record<EvalRunnerStatus['state'], { label: string; tone: Tone; emoji: string }> = {
  idle: { label: 'idle', tone: 'neutral', emoji: EMOJI.info },
  running: { label: 'running', tone: 'accent', emoji: EMOJI.waiting },
  finished: { label: 'finished', tone: 'pass', emoji: EMOJI.pass },
  failed: { label: 'ended with errors or regressions', tone: 'warn', emoji: EMOJI.warning },
  stopped: { label: 'stopped', tone: 'neutral', emoji: EMOJI.paused },
};

/**
 * JERRY's evals: runs, per-case results across repeats compared with the baseline,
 * regressions, flaky cases, calibration and what changed since the baseline. Runs start here
 * ("Run evals": Core runs `jerry eval run` in the background) or from the CLI; choosing a baseline
 * is the user's decision.
 */
export const Evals = defineComponent({
  name: 'Evals',
  setup() {
    const runs = ref<EvalRunSummary[]>([]);
    const status = ref<EvalStatus | null>(null);
    const calibration = ref<Array<{ rubricId: string; labels: number; agreement: number; calibrated: boolean }>>([]);
    const selected = ref<EvalRunDetail | null>(null);
    const baselineFor = ref<EvalRunSummary | null>(null);
    const busy = ref(false);
    const runner = ref<EvalRunnerStatus | null>(null);
    /** The run dialog: open, and the suite chosen in it ('' for all cases). */
    const asking = ref(false);
    const suite = ref('');
    const label = ref('');
    let poll: ReturnType<typeof setTimeout> | null = null;

    const watchRunner = async (): Promise<void> => {
      poll = null;
      try {
        const before = runner.value?.state;
        runner.value = await api.evalRunner();
        if (runner.value.state === 'running') poll = setTimeout(() => void watchRunner(), RUNNER_POLL_MS);
        else if (before === 'running') {
          // Just finished: show the run it recorded.
          selected.value = null;
          await load();
          if (runner.value.runId !== null) await open(runner.value.runId);
        }
      } catch (error) {
        handleError(error);
      }
    };
    onMounted(() => void watchRunner());
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
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    const runnerPanel = () => {
      const current = runner.value;
      if (current === null) return null;
      const shown = RUNNER_STATE[current.state];
      return (
        <div class="eval-runner grid gap-3 rounded-lg border p-3" data-runner-state={current.state}>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" data-run-evals disabled={busy.value || current.state === 'running' || current.unavailable !== null} onClick={() => (asking.value = true)}>
                <Play />
                Run evals
              </Button>
              {current.state !== 'idle' && (
                <StatusBadge tone={shown.tone} emoji={shown.emoji}>
                  {shown.label}
                </StatusBadge>
              )}
              {current.startedAt !== null && (
                <span class="text-muted-foreground text-xs">
                  started {formatTime(current.startedAt)}
                  {current.suite !== null && ` · suite ${current.suite}`}
                  {current.label !== '' && ` · ${current.label}`}
                  {current.exitCode !== null && ` · exit ${current.exitCode}`}
                </span>
              )}
              {current.runId !== null && current.state !== 'running' && (
                <Button variant="link" size="sm" class="h-auto px-0 font-mono" onClick={() => void open(current.runId!)}>
                  {current.runId}
                </Button>
              )}
            </div>
            {current.state === 'running' && (
              <Button size="sm" variant="outline" data-stop-evals disabled={busy.value} onClick={() => void stopRun()}>
                <Square />
                Stop
              </Button>
            )}
          </div>
          {current.unavailable !== null && <p class={ATTENTION}>{current.unavailable}</p>}
          {current.logTail.length > 0 && (
            <pre class="eval-runner__log bg-muted max-h-64 overflow-auto rounded p-2 font-mono text-xs whitespace-pre-wrap" aria-live="polite">
              {current.logTail.join('\n')}
            </pre>
          )}
          {current.logFile !== null && <p class="text-muted-foreground text-xs break-all">Full output: {current.logFile}</p>}
        </div>
      );
    };

    const load = async (): Promise<void> => {
      try {
        [runs.value, status.value, calibration.value] = await Promise.all([api.evalRuns(), api.evalStatus(), api.evalCalibration()]);
        const first = runs.value[0];
        if (first !== undefined && selected.value === null) selected.value = await api.evalRun(first.runId);
      } catch (error) {
        handleError(error);
      }
    };
    onMounted(() => void load());

    const open = async (runId: string): Promise<void> => {
      try {
        selected.value = await api.evalRun(runId);
      } catch (error) {
        handleError(error);
      }
    };

    const setBaseline = async (typed: string, note: string): Promise<void> => {
      const run = baselineFor.value;
      if (run === null) return;
      busy.value = true;
      const done = await perform(() => api.setEvalBaseline(run.runId, note, typed), `${run.runId} is the eval baseline.`);
      busy.value = false;
      if (done) {
        baselineFor.value = null;
        selected.value = null;
        await load();
      }
    };

    const runsTable = () => (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Finished</TableHead>
            <TableHead>Results</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>
              <span class="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.value.map((run) => (
            <TableRow key={run.runId} data-state={selected.value?.runId === run.runId ? 'selected' : undefined}>
              <TableCell>
                <Button variant="link" size="sm" class="h-auto px-0 font-mono" aria-current={selected.value?.runId === run.runId ? 'true' : undefined} onClick={() => void open(run.runId)}>
                  {run.runId}
                </Button>
              </TableCell>
              <TableCell class="text-muted-foreground">{formatTime(run.finishedAt)}</TableCell>
              <TableCell>
                <div class="flex flex-wrap gap-1">
                  <StatusBadge tone="pass" emoji={EMOJI.pass}>
                    {run.counts.PASS} pass
                  </StatusBadge>
                  {run.counts.FAIL > 0 && (
                    <StatusBadge tone="deny" emoji={EMOJI.fail}>
                      {run.counts.FAIL} fail
                    </StatusBadge>
                  )}
                  {run.counts.FLAKY > 0 && (
                    <StatusBadge tone="warn" emoji={EMOJI.warning}>
                      {run.counts.FLAKY} flaky
                    </StatusBadge>
                  )}
                  {run.counts.ERROR > 0 && (
                    <StatusBadge tone="warn" emoji={EMOJI.fail}>
                      {run.counts.ERROR} error
                    </StatusBadge>
                  )}
                  {run.isBaseline && (
                    <StatusBadge tone="accent" emoji={EMOJI.evals}>
                      baseline
                    </StatusBadge>
                  )}
                </div>
              </TableCell>
              <TableCell class="text-muted-foreground">{run.label}</TableCell>
              <TableCell class="text-right">
                {!run.isBaseline && (
                  <Button variant="ghost" size="sm" onClick={() => (baselineFor.value = run)}>
                    Make baseline
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );

    const casesTable = (detail: EvalRunDetail) => (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Case</TableHead>
            <TableHead scope="col">Result</TableHead>
            <TableHead scope="col">Against baseline</TableHead>
            <TableHead scope="col">Attempts</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.comparison.cases.map((entry) => {
            const result = detail.results.find((candidate) => candidate.caseId === entry.caseId);
            return (
              <TableRow key={entry.caseId}>
                <TableCell class="align-top">
                  <div class="flex flex-wrap items-center gap-2">
                    <code class="font-mono text-xs">{entry.caseId}</code>
                    {entry.critical && <StatusBadge tone="deny">critical</StatusBadge>}
                    <span class="text-muted-foreground text-xs">{result?.suite}</span>
                  </div>
                </TableCell>
                <TableCell class="align-top">
                  {entry.current === null ? (
                    '-'
                  ) : (
                    <StatusBadge tone={OUTCOME_TONE[entry.current] ?? 'neutral'} emoji={OUTCOME_EMOJI[entry.current]}>
                      {entry.current}
                    </StatusBadge>
                  )}
                </TableCell>
                <TableCell class="align-top">
                  <div class="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={COMPARISON_TONE[entry.comparison] ?? 'neutral'} emoji={COMPARISON_EMOJI[entry.comparison]}>
                      {entry.comparison}
                    </StatusBadge>
                    <span class="text-muted-foreground text-xs">
                      {entry.baseline ?? '-'} → {entry.current ?? '-'}
                    </span>
                  </div>
                </TableCell>
                <TableCell class="align-top text-xs whitespace-normal">
                  {result?.attempts.map((attempt) => (
                    <div key={attempt.attempt}>
                      #{attempt.attempt} {attempt.outcome}
                      {attempt.outcome !== 'PASS' && (
                        <span class="text-muted-foreground">
                          {' '}
                          · {attempt.harnessError ?? attempt.graders.filter((grader) => grader.passed === false).map((grader) => `${grader.grader}: ${grader.detail}`).join('; ')}
                        </span>
                      )}
                    </div>
                  ))}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );

    return () => (
      <section class="evals flex flex-col gap-4 md:gap-6">
        <Card>
          <CardHeader>
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
          </CardHeader>
          <CardContent class="grid gap-4 text-sm">
            {status.value === null ? (
              <div class="grid gap-2">
                <span class="sr-only">Loading…</span>
                <Skeleton class="h-4 w-2/3" />
                <Skeleton class="h-4 w-1/2" />
              </div>
            ) : (
              <div class="grid gap-1">
                <p class={status.value.changedSinceBaseline.length > 0 ? ATTENTION : 'text-muted-foreground'}>
                  <Emoji symbol={status.value.changedSinceBaseline.length > 0 ? EMOJI.warning : EMOJI.pass} />
                  {status.value.changedSinceBaseline.length > 0 ? `Changed since the baseline: ${status.value.changedSinceBaseline.join(', ')}. Run the evals again.` : 'Nothing JERRY ships changed since the baseline.'}
                </p>
                {calibration.value.length > 0 && (
                  <p class="text-muted-foreground text-xs">
                    Rubric calibration: {calibration.value.map((entry) => `${entry.rubricId} ${entry.labels} label(s), ${(entry.agreement * 100).toFixed(0)}%${entry.calibrated ? ' ✓' : ''}`).join(' · ')}
                  </p>
                )}
              </div>
            )}
            {runnerPanel()}
            {runs.value.length === 0 && <p class="text-muted-foreground">No eval runs yet. Start one with Run evals, or from a terminal: jerry eval run</p>}
            {runs.value.length > 0 && runsTable()}
          </CardContent>
        </Card>
        {selected.value !== null && (
          <Card>
            <CardHeader>
              <CardTitle class="flex flex-wrap items-center">
                <Emoji symbol={EMOJI.evals} />
                {selected.value.runId} compared with {selected.value.comparison.baselineRunId ?? 'no baseline'}
              </CardTitle>
            </CardHeader>
            <CardContent>{casesTable(selected.value)}</CardContent>
          </Card>
        )}
        {asking.value && runner.value !== null && (
          <ConfirmDialog title="Run the evals?" expected="evals" confirmLabel="Run evals" busy={busy.value} onConfirm={() => void startRun()} onCancel={() => (asking.value = false)}>
            <div class="grid gap-3">
              <p>
                Starts real Claude Code sessions in the background, each in its own temporary repository: {casesFor(suite.value)} case(s). They use your Claude Code account (tokens, plan limits) and take a while. You can stop the run
                here.
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
        {baselineFor.value !== null && (
          <ConfirmDialog title={`Make ${baselineFor.value.runId} the baseline`} expected={baselineFor.value.runId} confirmLabel="Make baseline" busy={busy.value} commentLabel="Why (required)" commentRequired onConfirm={setBaseline} onCancel={() => (baselineFor.value = null)}>
            <p>Later runs are compared with this one; a case that passes here and fails later is a regression.</p>
          </ConfirmDialog>
        )}
      </section>
    );
  },
});
