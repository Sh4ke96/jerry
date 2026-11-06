import type { EvalRunDetail, EvalRunSummary, EvalStatus } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref } from 'vue';
import { api } from '../api';
import { Badge, type Tone } from '../components/Badge';
import { Emoji } from '../components/Emoji';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatTime } from '../format';
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

    return () => (
      <section class="evals">
        <div class="panel">
          <h2>
            <Emoji symbol={EMOJI.evals} />
            Evals
          </h2>
          {status.value === null ? (
            <p class="muted">Loading…</p>
          ) : (
            <div>
              <p>
                Baseline: <strong>{status.value.baselineRunId ?? 'none yet'}</strong> · latest run: {status.value.latestRunId ?? 'none'}{' '}
                {status.value.releaseBlocked && (
                  <Badge tone="deny" emoji={EMOJI.blocked}>
                    release blocked: critical regression
                  </Badge>
                )}
              </p>
              <p class={status.value.changedSinceBaseline.length > 0 ? 'attention' : 'muted'}>
                <Emoji symbol={status.value.changedSinceBaseline.length > 0 ? EMOJI.warning : EMOJI.pass} />
                {status.value.changedSinceBaseline.length > 0 ? `Changed since the baseline: ${status.value.changedSinceBaseline.join(', ')}. Run the evals again: jerry eval run` : 'Nothing JERRY ships changed since the baseline.'}
              </p>
              {calibration.value.length > 0 && (
                <p class="muted small">
                  Rubric calibration:{' '}
                  {calibration.value.map((entry) => `${entry.rubricId} ${entry.labels} label(s), ${(entry.agreement * 100).toFixed(0)}%${entry.calibrated ? ' ✓' : ''}`).join(' · ')}
                </p>
              )}
            </div>
          )}
          {runs.value.length === 0 && <p class="muted">No eval runs yet. Run them from a terminal: jerry eval run</p>}
          <ul class="list evals__runs">
            {runs.value.map((run) => (
              <li key={run.runId}>
                <button type="button" class={['button', 'button--quiet', selected.value?.runId === run.runId && 'tab--active']} onClick={() => void open(run.runId)}>
                  {run.runId}
                </button>{' '}
                <span class="muted small">{formatTime(run.finishedAt)}</span> <Badge tone="pass" emoji={EMOJI.pass}>
                  {run.counts.PASS} pass
                </Badge>{' '}
                {run.counts.FAIL > 0 && (
                  <Badge tone="deny" emoji={EMOJI.fail}>
                    {run.counts.FAIL} fail
                  </Badge>
                )}{' '}
                {run.counts.FLAKY > 0 && (
                  <Badge tone="warn" emoji={EMOJI.warning}>
                    {run.counts.FLAKY} flaky
                  </Badge>
                )}{' '}
                {run.counts.ERROR > 0 && (
                  <Badge tone="warn" emoji={EMOJI.fail}>
                    {run.counts.ERROR} error
                  </Badge>
                )}{' '}
                {run.isBaseline && (
                  <Badge tone="accent" emoji={EMOJI.evals}>
                    baseline
                  </Badge>
                )} <span class="muted small">{run.label}</span>{' '}
                {!run.isBaseline && (
                  <button type="button" class="button button--quiet button--small" onClick={() => (baselineFor.value = run)}>
                    Make baseline
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        {selected.value !== null && (
          <div class="panel">
            <h3>
              <Emoji symbol={EMOJI.evals} />
              {selected.value.runId} compared with {selected.value.comparison.baselineRunId ?? 'no baseline'}
            </h3>
            <table class="evals__table">
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Result</th>
                  <th scope="col">Against baseline</th>
                  <th scope="col">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {selected.value.comparison.cases.map((entry) => {
                  const result = selected.value!.results.find((candidate) => candidate.caseId === entry.caseId);
                  return (
                    <tr key={entry.caseId}>
                      <td>
                        <code>{entry.caseId}</code> {entry.critical && <Badge tone="deny">critical</Badge>} <span class="muted small">{result?.suite}</span>
                      </td>
                      <td>
                        {entry.current === null ? (
                          '-'
                        ) : (
                          <Badge tone={OUTCOME_TONE[entry.current] ?? 'neutral'} emoji={OUTCOME_EMOJI[entry.current]}>
                            {entry.current}
                          </Badge>
                        )}
                      </td>
                      <td>
                        <Badge tone={COMPARISON_TONE[entry.comparison] ?? 'neutral'} emoji={COMPARISON_EMOJI[entry.comparison]}>
                          {entry.comparison}
                        </Badge> <span class="muted small">{entry.baseline ?? '-'} → {entry.current ?? '-'}</span>
                      </td>
                      <td class="small">
                        {result?.attempts.map((attempt) => (
                          <div key={attempt.attempt}>
                            #{attempt.attempt} {attempt.outcome}
                            {attempt.outcome !== 'PASS' && <span class="muted"> · {attempt.harnessError ?? attempt.graders.filter((grader) => grader.passed === false).map((grader) => `${grader.grader}: ${grader.detail}`).join('; ')}</span>}
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
