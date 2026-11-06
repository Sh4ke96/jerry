import type { ArtifactDecision, FinalReport } from '@jerry/contracts';
import { defineComponent, onMounted, ref, type PropType } from 'vue';
import { api } from '../api';
import { handleError } from '../state';
import { Badge } from './Badge';

/** Only links to claude.ai Artifacts are shown as links (ADR 0042); anything else stays text. */
export function safeArtifactLink(url: string | null): string | null {
  return url !== null && /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+(?:[/?#][^\s"'<>]*)?$/.test(url) ? url : null;
}

/** The final report of a task (spec Phase 9, ADR 0041), assembled by Core from what it recorded. */
export const FinalReportView = defineComponent({
  name: 'FinalReportView',
  props: { taskId: { type: String, required: true } },
  setup(props) {
    const report = ref<FinalReport | null>(null);
    onMounted(async () => {
      try {
        report.value = await api.finalReport(props.taskId);
      } catch (error) {
        handleError(error);
      }
    });
    return () => {
      const r = report.value;
      if (r === null) return <p class="muted small">Assembling the final report…</p>;
      const link = safeArtifactLink(r.artifact.url);
      return (
        <section class="final-report">
          <h3>
            Final report {r.status === 'draft' ? <Badge tone="warn">draft</Badge> : <Badge tone="pass">DONE</Badge>}
          </h3>
          <p>{r.goal}</p>
          <h4>Changes ({r.diffSummary.files})</h4>
          <ul class="list small">
            {r.repositories.flatMap((repository) =>
              repository.changes.map((change) => (
                <li key={`${repository.repository}|${change.path}`}>
                  <code>{change.path}</code> <span class="muted">{change.kind}</span> {change.description}
                </li>
              )),
            )}
          </ul>
          {r.diffSummary.unreported.length > 0 && <p class="attention small">Not in the report: {r.diffSummary.unreported.join(', ')}</p>}
          <h4>Tests</h4>
          <ul class="list small">
            {r.tests.checks.map((check, index) => (
              <li key={index}>
                <Badge tone={check.result === 'PASS' ? 'pass' : check.result === 'FAIL' ? 'deny' : 'warn'}>{check.result}</Badge> <code>{check.command}</code> {check.details}
              </li>
            ))}
          </ul>
          {r.tests.claimedVsObserved.map((line) => (
            <p key={line} class="attention small">
              {line}
            </p>
          ))}
          {r.review !== null && (
            <p>
              Review: <strong>{r.review.outcome}</strong> after {r.review.rounds} round(s) · {r.review.findings.total} finding(s), {r.review.findings.fixed} fixed
              {r.review.findings.open.length > 0 && <span class="attention"> · open: {r.review.findings.open.join('; ')}</span>}
            </p>
          )}
          <h4>Proposed commits</h4>
          <ul class="list small">
            {r.commitSubjects.map((subject) => (
              <li key={subject}>
                <code>{subject}</code>
              </li>
            ))}
          </ul>
          <p>
            Artifact:{' '}
            {r.artifact.decision === 'created' ? (
              link === null ? (
                <span>{r.artifact.title}</span>
              ) : (
                <a href={link} target="_blank" rel="noopener noreferrer">
                  {r.artifact.title}
                </a>
              )
            ) : r.artifact.decision === 'declined' ? (
              <span class="muted">declined by the user</span>
            ) : (
              <span class="muted">not asked yet{r.artifact.planned === '' ? '' : ` (plan: ${r.artifact.planned})`}; Claude offers it with /jerry:artifact</span>
            )}
          </p>
          {r.limitations.length > 0 && (
            <div>
              <h4>Limitations</h4>
              <ul class="list small">
                {r.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          )}
          <p class="small">
            Definition of Done: <strong>{r.definitionOfDone.passed ? 'met' : 'not met'}</strong> · {r.definitionOfDone.items.join('; ')}
          </p>
        </section>
      );
    };
  },
});

/** Every Artifact decision, newest first (ADR 0042): links to the user's Artifacts, or "declined". */
export const ArtifactsList = defineComponent({
  name: 'ArtifactsList',
  props: { decisions: { type: Array as PropType<ArtifactDecision[]>, required: true } },
  setup(props) {
    return () =>
      props.decisions.length === 0 ? null : (
        <details class="panel artifacts">
          <summary>Artifacts ({props.decisions.filter((decision) => decision.decision === 'created').length})</summary>
          <ul class="list">
            {props.decisions.map((decision) => {
              const link = safeArtifactLink(decision.url);
              return (
                <li key={decision.taskId}>
                  <code>{decision.taskId}</code>{' '}
                  {decision.decision === 'declined' ? (
                    <span class="muted">declined{decision.reason === '' ? '' : `: ${decision.reason}`}</span>
                  ) : link === null ? (
                    <span>{decision.title}</span>
                  ) : (
                    <a href={link} target="_blank" rel="noopener noreferrer">
                      {decision.title}
                    </a>
                  )}{' '}
                  {decision.kind !== null && <span class="muted small">{decision.kind}</span>}
                </li>
              );
            })}
          </ul>
        </details>
      );
  },
});
