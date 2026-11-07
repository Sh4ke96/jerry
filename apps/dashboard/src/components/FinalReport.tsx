import type { ArtifactDecision, FinalReport } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref, type PropType } from 'vue';
import { api } from '../api';
import { ATTENTION, LIST } from '../lib/classes';
import { finalReportReviewRequested } from '../settings';
import { handleError } from '../state';
import { Emoji, resultEmoji } from './Emoji';
import { Section } from './Section';
import { StatusBadge } from './StatusBadge';
import { Card, CardContent } from './ui/card';
import { Skeleton } from './ui/skeleton';

/** Only links to claude.ai Artifacts are shown as links; anything else stays text. */
export function safeArtifactLink(url: string | null): string | null {
  return url !== null && /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+(?:[/?#][^\s"'<>]*)?$/.test(url) ? url : null;
}

const LINK = 'text-primary font-medium underline underline-offset-4';
const HEADING = 'flex items-center font-medium';

/** The final report of a task, assembled by Core from what it recorded. */
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
      if (r === null) {
        return (
          <div class="grid gap-2 rounded-lg border p-4">
            <p class="text-muted-foreground text-xs">Assembling the final report…</p>
            <Skeleton class="h-4 w-1/2" />
            <Skeleton class="h-4 w-2/3" />
          </div>
        );
      }
      const link = safeArtifactLink(r.artifact.url);
      return (
        <section class="final-report grid gap-3 rounded-lg border p-4 text-sm">
          <h3 class="flex flex-wrap items-center gap-x-2 font-semibold">
            <Emoji symbol={EMOJI.report} class="mr-0" />
            Final report{' '}
            {r.status === 'draft' ? (
              <StatusBadge tone="warn" emoji={EMOJI.waiting}>
                draft
              </StatusBadge>
            ) : (
              <StatusBadge tone="pass" emoji={EMOJI.done}>
                DONE
              </StatusBadge>
            )}
          </h3>
          <p>{r.goal}</p>
          <h4 class={HEADING}>
            <Emoji symbol={EMOJI.implementation} />
            Changes ({r.diffSummary.files})
          </h4>
          <ul class={[LIST, 'text-xs']}>
            {r.repositories.flatMap((repository) =>
              repository.changes.map((change) => (
                <li key={`${repository.repository}|${change.path}`}>
                  <code class="font-mono">{change.path}</code> <span class="text-muted-foreground">{change.kind}</span> {change.description}
                </li>
              )),
            )}
          </ul>
          {r.diffSummary.unreported.length > 0 && <p class={[ATTENTION, 'text-xs']}>Not in the report: {r.diffSummary.unreported.join(', ')}</p>}
          <h4 class={HEADING}>
            <Emoji symbol={EMOJI.tests} />
            Tests
          </h4>
          <ul class={[LIST, 'text-xs']}>
            {r.tests.checks.map((check, index) => (
              <li key={index} class="flex flex-wrap items-center gap-x-2">
                <StatusBadge tone={check.result === 'PASS' ? 'pass' : check.result === 'FAIL' ? 'deny' : 'warn'} emoji={resultEmoji(check.result)}>
                  {check.result}
                </StatusBadge>{' '}
                <code class="font-mono">{check.command}</code> {check.details}
              </li>
            ))}
          </ul>
          {r.tests.claimedVsObserved.map((line) => (
            <p key={line} class={[ATTENTION, 'text-xs']}>
              {line}
            </p>
          ))}
          {r.review !== null && finalReportReviewRequested(r) === false && r.review.rounds === 0 && (
            <p class="final-report__review">
              <Emoji symbol={EMOJI.review} />
              Review: <strong class="font-medium">not requested</strong> at acceptance
            </p>
          )}
          {r.review !== null && !(finalReportReviewRequested(r) === false && r.review.rounds === 0) && (
            <p class="final-report__review">
              <Emoji symbol={EMOJI.review} />
              Review: <strong class="font-medium">{r.review.outcome}</strong> after {r.review.rounds} round(s) · {r.review.findings.total} finding(s), {r.review.findings.fixed} fixed
              {r.review.findings.open.length > 0 && <span class={ATTENTION}> · open: {r.review.findings.open.join('; ')}</span>}
            </p>
          )}
          <h4 class={HEADING}>
            <Emoji symbol={EMOJI.next} />
            Proposed commits
          </h4>
          <ul class={[LIST, 'text-xs']}>
            {r.commitSubjects.map((subject) => (
              <li key={subject}>
                <code class="font-mono">{subject}</code>
              </li>
            ))}
          </ul>
          <p>
            <Emoji symbol={EMOJI.artifact} />
            Artifact:{' '}
            {r.artifact.decision === 'created' ? (
              link === null ? (
                <span>{r.artifact.title}</span>
              ) : (
                <a href={link} target="_blank" rel="noopener noreferrer" class={LINK}>
                  {r.artifact.title}
                </a>
              )
            ) : r.artifact.decision === 'declined' ? (
              <span class="text-muted-foreground">declined by the user</span>
            ) : (
              <span class="text-muted-foreground">not asked yet{r.artifact.planned === '' ? '' : ` (plan: ${r.artifact.planned})`}; Claude offers it with /jerry:artifact</span>
            )}
          </p>
          {r.limitations.length > 0 && (
            <div class="grid gap-2">
              <h4 class={HEADING}>
                <Emoji symbol={EMOJI.warning} />
                Limitations
              </h4>
              <ul class={[LIST, 'list-disc pl-5 text-xs']}>
                {r.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          )}
          {/* An older Core sends no later-work list. */}
          {(r.laterWork ?? []).length > 0 && (
            <div class="final-report__later-work grid gap-2">
              <h4 class={HEADING}>
                <Emoji symbol={EMOJI.info} />
                Changed later by other tasks
              </h4>
              <ul class={[LIST, 'list-disc pl-5 text-xs']}>
                {(r.laterWork ?? []).map((work) => (
                  <li key={work.taskId}>
                    <span class="font-mono">{work.taskId}</span>: {work.files.join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p class="text-xs">
            <Emoji symbol={r.definitionOfDone.passed ? EMOJI.done : EMOJI.fail} />
            Definition of Done: <strong class="font-medium">{r.definitionOfDone.passed ? 'met' : 'not met'}</strong> · {r.definitionOfDone.items.join('; ')}
          </p>
        </section>
      );
    };
  },
});

/** Every Artifact decision, newest first: links to the user's Artifacts, or "declined". */
export const ArtifactsList = defineComponent({
  name: 'ArtifactsList',
  props: { decisions: { type: Array as PropType<ArtifactDecision[]>, required: true } },
  setup(props) {
    return () =>
      props.decisions.length === 0 ? null : (
        <Card class="artifacts py-2">
          <CardContent>
            <Section title={`Artifacts (${props.decisions.filter((decision) => decision.decision === 'created').length})`} emoji={EMOJI.artifact}>
              <ul class={LIST}>
                {props.decisions.map((decision) => {
                  const link = safeArtifactLink(decision.url);
                  return (
                    <li key={decision.taskId}>
                      <code class="font-mono text-xs">{decision.taskId}</code>{' '}
                      {decision.decision === 'declined' ? (
                        <span class="text-muted-foreground">declined{decision.reason === '' ? '' : `: ${decision.reason}`}</span>
                      ) : link === null ? (
                        <span>{decision.title}</span>
                      ) : (
                        <a href={link} target="_blank" rel="noopener noreferrer" class={LINK}>
                          {decision.title}
                        </a>
                      )}{' '}
                      {decision.kind !== null && <span class="text-muted-foreground text-xs">{decision.kind}</span>}
                    </li>
                  );
                })}
              </ul>
            </Section>
          </CardContent>
        </Card>
      );
  },
});
