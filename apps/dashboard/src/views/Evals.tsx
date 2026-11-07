import type { EvalRunDetail, EvalRunSummary, EvalStatus } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref } from 'vue';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Emoji } from '../components/Emoji';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
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

/**
 * JERRY's evals: runs, per-case results across repeats compared with the baseline,
 * regressions, flaky cases, calibration and what changed since the baseline. Runs start from the
 * CLI (`jerry eval run`); choosing a baseline is the user's decision.
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
                  {status.value.changedSinceBaseline.length > 0 ? `Changed since the baseline: ${status.value.changedSinceBaseline.join(', ')}. Run the evals again: jerry eval run` : 'Nothing JERRY ships changed since the baseline.'}
                </p>
                {calibration.value.length > 0 && (
                  <p class="text-muted-foreground text-xs">
                    Rubric calibration: {calibration.value.map((entry) => `${entry.rubricId} ${entry.labels} label(s), ${(entry.agreement * 100).toFixed(0)}%${entry.calibrated ? ' ✓' : ''}`).join(' · ')}
                  </p>
                )}
              </div>
            )}
            {runs.value.length === 0 && <p class="text-muted-foreground">No eval runs yet. Run them from a terminal: jerry eval run</p>}
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
        {baselineFor.value !== null && (
          <ConfirmDialog title={`Make ${baselineFor.value.runId} the baseline`} expected={baselineFor.value.runId} confirmLabel="Make baseline" busy={busy.value} commentLabel="Why (required)" commentRequired onConfirm={setBaseline} onCancel={() => (baselineFor.value = null)}>
            <p>Later runs are compared with this one; a case that passes here and fails later is a regression.</p>
          </ConfirmDialog>
        )}
      </section>
    );
  },
});
