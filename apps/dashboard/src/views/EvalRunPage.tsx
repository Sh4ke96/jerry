import type { EvalRunDetail, EvalRunSummary } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { ArrowLeft } from '@lucide/vue';
import { defineComponent, onMounted, ref } from 'vue';
import { api, HttpError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Emoji } from '../components/Emoji';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatTime } from '../format';
import { linkTo } from '../router';
import { handleError, perform } from '../state';

const OUTCOME_TONE: Record<string, Tone> = { PASS: 'pass', FAIL: 'deny', FLAKY: 'warn', ERROR: 'warn' };
const COMPARISON_TONE: Record<string, Tone> = { REGRESSION: 'deny', FIXED: 'pass', UNCHANGED: 'neutral', FLAKY: 'warn', NEW: 'accent', MISSING: 'warn', ERROR: 'warn' };
const OUTCOME_EMOJI: Record<string, string> = { PASS: EMOJI.pass, FAIL: EMOJI.fail, FLAKY: EMOJI.warning, ERROR: EMOJI.fail };
/** An unchanged case has no emoji of its own: its result column shows the outcome. */
const COMPARISON_EMOJI: Record<string, string> = { REGRESSION: EMOJI.blocked, FIXED: EMOJI.pass, FLAKY: EMOJI.warning, NEW: EMOJI.info, MISSING: EMOJI.warning, ERROR: EMOJI.fail };

/** A run's results in badges: pass, fail, flaky, error, baseline. */
export function runCounts(run: EvalRunSummary) {
  return (
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
  );
}

function casesTable(detail: EvalRunDetail) {
  return (
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
}

/** One eval run on its own page: what ran, its results against the baseline, and the baseline decision. */
export const EvalRunPage = defineComponent({
  name: 'EvalRunPage',
  props: { runId: { type: String, required: true } },
  setup(props) {
    const detail = ref<EvalRunDetail | null>(null);
    const missing = ref(false);
    const choosing = ref(false);
    const busy = ref(false);

    const load = async (): Promise<void> => {
      try {
        detail.value = await api.evalRun(props.runId);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) missing.value = true;
        else handleError(error);
      }
    };
    onMounted(() => void load());

    const setBaseline = async (typed: string, note: string): Promise<void> => {
      busy.value = true;
      const done = await perform(() => api.setEvalBaseline(props.runId, note, typed), `${props.runId} is the eval baseline.`);
      busy.value = false;
      if (done) {
        choosing.value = false;
        await load();
      }
    };

    const back = () => (
      <a class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm" {...linkTo('#/evals')}>
        <ArrowLeft class="size-4" />
        All eval runs
      </a>
    );

    return () => {
      if (missing.value) {
        return (
          <div class="eval-run-page flex flex-col gap-4">
            {back()}
            <Card>
              <CardHeader>
                <CardTitle>There is no eval run {props.runId}</CardTitle>
                <CardDescription>It may have been deleted with old data, or the address is mistyped.</CardDescription>
              </CardHeader>
            </Card>
          </div>
        );
      }
      const run = detail.value;
      if (run === null) {
        return (
          <div class="eval-run-page grid gap-2">
            <span class="sr-only">Loading…</span>
            <Skeleton class="h-6 w-1/3" />
            <Skeleton class="h-40 w-full" />
          </div>
        );
      }
      return (
        <div class="eval-run-page flex flex-col gap-4 md:gap-6" data-eval-run={run.runId}>
          {back()}
          <Card>
            <CardHeader>
              <CardTitle class="flex flex-wrap items-center gap-2">
                <Emoji symbol={EMOJI.evals} />
                <span class="font-mono">{run.runId}</span>
                {run.label !== '' && <span class="text-muted-foreground font-normal">· {run.label}</span>}
              </CardTitle>
              <CardDescription>
                Finished {formatTime(run.finishedAt)} · JERRY {run.jerryVersion} · compared with {run.comparison.baselineRunId ?? 'no baseline'}
              </CardDescription>
            </CardHeader>
            <CardContent class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-2">
                {runCounts(run)}
                {run.comparison.releaseBlocked && (
                  <StatusBadge tone="deny" emoji={EMOJI.blocked}>
                    release blocked: critical regression
                  </StatusBadge>
                )}
                {run.comparison.regressions.length > 0 && <span class="text-destructive text-sm">Regressions: {run.comparison.regressions.join(', ')}</span>}
              </div>
              {!run.isBaseline && (
                <Button size="sm" variant="outline" data-make-baseline onClick={() => (choosing.value = true)}>
                  Make baseline
                </Button>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.tests} />
                Cases
              </CardTitle>
              <CardDescription>Each case's result across its attempts, and how it compares with the baseline.</CardDescription>
            </CardHeader>
            <CardContent>{run.comparison.cases.length === 0 ? <p class="text-muted-foreground text-sm">This run has no cases.</p> : casesTable(run)}</CardContent>
          </Card>
          {choosing.value && (
            <ConfirmDialog title={`Make ${run.runId} the baseline`} expected={run.runId} confirmLabel="Make baseline" busy={busy.value} commentLabel="Why (required)" commentRequired onConfirm={setBaseline} onCancel={() => (choosing.value = false)}>
              <p>Later runs are compared with this one; a case that passes here and fails later is a regression.</p>
            </ConfirmDialog>
          )}
        </div>
      );
    };
  },
});
