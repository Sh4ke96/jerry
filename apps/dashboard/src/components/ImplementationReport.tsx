import type { ImplementationReportRecord } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType } from 'vue';
import { formatTime } from '../format';
import { ATTENTION, CHIP, LIST, PREWRAP, STEPS } from '../lib/classes';
import { cn } from '../lib/utils';
import { QA_LANGUAGE_LABEL, reportQaLanguage } from '../settings';
import { Emoji, resultEmoji } from './Emoji';
import { Section } from './Section';
import { StatusBadge, type Tone } from './StatusBadge';

const RESULT_TONE: Record<'PASS' | 'FAIL' | 'NOT_RUN', Tone> = { PASS: 'pass', FAIL: 'deny', NOT_RUN: 'warn' };
const SEVERITY_TONE: Record<'low' | 'medium' | 'high' | 'critical', Tone> = { low: 'neutral', medium: 'warn', high: 'deny', critical: 'deny' };

/**
 * Claude's implementation report next to what JERRY recorded itself, so the user judges the
 * claims against the facts before accepting.
 */
export const ImplementationReportView = defineComponent({
  name: 'ImplementationReportView',
  props: {
    report: { type: Object as PropType<ImplementationReportRecord>, required: true },
    /** Without the separating line above it (on its own tab). */
    bare: { type: Boolean, default: false },
  },
  setup(props) {
    return () => {
      const { document, evidence } = props.report;
      const qaLanguage = reportQaLanguage(props.report);
      const problems = document.checks.filter((check) => check.result !== 'PASS');
      const attention = evidence.unreportedEdits.length > 0 || evidence.deviationCount > 0 || problems.length > 0;
      return (
        <div class={cn('report grid gap-3', !props.bare && 'border-t pt-4')}>
          <h3 class="flex flex-wrap items-center gap-x-2 font-semibold">
            <Emoji symbol={EMOJI.report} class="mr-0" />
            Implementation report v{props.report.version}{' '}
            <span class="text-muted-foreground text-xs font-normal">
              for plan v{props.report.planVersion} · {formatTime(props.report.createdAt)} · written by {props.report.submittedBy === 'claude' ? 'Claude' : 'you'}
            </span>
          </h3>
          <p class="text-base font-medium">{document.summary}</p>

          <section class={cn('evidence grid gap-1.5 rounded-lg border p-4 text-sm', attention ? 'border-amber-500/50 bg-amber-500/5' : 'bg-muted/50')} data-attention={attention ? 'true' : 'false'}>
            <h4 class="flex items-center font-medium">
              <Emoji symbol={EMOJI.jerry} />
              Recorded by JERRY since the plan approval
            </h4>
            <p>
              {evidence.deviationCount} deviation(s) · {evidence.blockedCount} blocked · {evidence.observedEdits.length} file(s) edited with the file tools
            </p>
            {evidence.unreportedEdits.length > 0 && (
              <p class={ATTENTION}>
                <Emoji symbol={EMOJI.warning} />
                Edited but not in the report:{' '}
                {evidence.unreportedEdits.map((file) => (
                  <code class={CHIP} key={file}>
                    {file}
                  </code>
                ))}
              </p>
            )}
            {problems.length > 0 && (
              <p class={ATTENTION}>
                <Emoji symbol={EMOJI.warning} />
                {problems.length} check(s) failed or did not run.
              </p>
            )}
            {evidence.deviations.length > 0 && (
              <ul class="grid gap-1 text-xs">
                {evidence.deviations.map((deviation, index) => (
                  <li key={index}>
                    <span class="text-muted-foreground">{formatTime(deviation.at)}</span> {deviation.tool} <code class="font-mono">{deviation.target}</code> <span class="text-muted-foreground">{deviation.rule}</span>
                  </li>
                ))}
              </ul>
            )}
            {evidence.quality !== undefined && (
              <div class="grid gap-1">
                <p class="flex flex-wrap items-center gap-x-1">
                  <Emoji symbol={EMOJI.finding} />
                  Quality: {evidence.quality.openFindings} open finding(s)
                  {evidence.quality.lastTestRun !== null && (
                    <span class="inline-flex flex-wrap items-center gap-1">
                      {' '}
                      · last tests JERRY saw:{' '}
                      <StatusBadge tone={evidence.quality.lastTestRun.result === 'PASS' ? 'pass' : 'deny'} emoji={resultEmoji(evidence.quality.lastTestRun.result)}>
                        {evidence.quality.lastTestRun.result}
                      </StatusBadge>{' '}
                      <code class="font-mono text-xs">{evidence.quality.lastTestRun.command}</code>
                    </span>
                  )}
                </p>
                {evidence.quality.serious.length > 0 && <p class={ATTENTION}>Open P1/P2 findings: {evidence.quality.serious.join('; ')}</p>}
                {evidence.quality.claimedVsObserved.map((line) => (
                  <p key={line} class={ATTENTION}>
                    {line}
                  </p>
                ))}
                {evidence.quality.unplannedFiles.length > 0 && <p class={ATTENTION}>Changed but named by no plan step: {evidence.quality.unplannedFiles.join(', ')}</p>}
                {evidence.quality.untouchedSteps.length > 0 && <p class="text-muted-foreground">Plan steps without changes: {evidence.quality.untouchedSteps.join('; ')}</p>}
              </div>
            )}
          </section>

          <div>
            <Section title={`Checks (${document.checks.length})`} defaultOpen emoji={EMOJI.tests}>
              <ul class={LIST}>
                {document.checks.map((check, index) => (
                  <li key={index} class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StatusBadge tone={RESULT_TONE[check.result]} emoji={resultEmoji(check.result)}>
                      {check.result}
                    </StatusBadge>{' '}
                    <StatusBadge>{check.kind}</StatusBadge> <code class="font-mono text-xs">{check.command}</code>
                    {check.details !== '' && <span class="text-muted-foreground"> · {check.details}</span>}
                  </li>
                ))}
              </ul>
            </Section>
            <Section title={`Changes (${document.changes.length})`} defaultOpen emoji={EMOJI.implementation}>
              <ul class={LIST}>
                {document.changes.map((change, index) => (
                  <li key={index}>
                    <strong class="font-medium">{change.kind}</strong> <code class={CHIP}>{change.repository === '' ? change.path : `${change.repository}: ${change.path}`}</code>: {change.description}
                  </li>
                ))}
              </ul>
            </Section>
            {document.planDeviations.length > 0 && (
              <Section title={`Differences from the plan (${document.planDeviations.length})`} defaultOpen emoji={EMOJI.plan}>
                <ul class={LIST}>
                  {document.planDeviations.map((deviation, index) => (
                    <li key={index}>
                      {deviation.description} <span class="text-muted-foreground">· {deviation.reason}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {document.risks.length > 0 && (
              <Section title={`Risks and findings (${document.risks.length})`} defaultOpen={document.risks.some((risk) => risk.severity === 'high' || risk.severity === 'critical')} emoji={EMOJI.warning}>
                <ul class={LIST}>
                  {document.risks.map((risk, index) => (
                    <li key={index}>
                      <StatusBadge tone={SEVERITY_TONE[risk.severity]}>{risk.severity}</StatusBadge> {risk.risk}
                      {risk.mitigation !== '' && <span class="text-muted-foreground"> → {risk.mitigation}</span>}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section class="qa" emoji={EMOJI.tests}>
              {{
                title: () => [
                  `Manual QA (${document.qaScenarios.length})`,
                  qaLanguage !== null && (
                    <StatusBadge key="language" class="qa-language" title={`The QA scenarios are written in ${QA_LANGUAGE_LABEL[qaLanguage]}`}>
                      {qaLanguage.toUpperCase()}
                    </StatusBadge>
                  ),
                ],
                default: () => (
                  <ul class="grid gap-3">
                    {document.qaScenarios.map((scenario) => (
                      <li key={scenario.id}>
                        <div class="flex flex-wrap items-center gap-2">
                          <strong class="font-medium">
                            {scenario.id} {scenario.title}
                          </strong>{' '}
                          <StatusBadge tone={scenario.priority === 'P1' ? 'warn' : 'neutral'}>{scenario.priority}</StatusBadge> <StatusBadge>{scenario.kind}</StatusBadge>
                        </div>
                        <div class="text-muted-foreground text-xs">
                          {scenario.location}
                          {scenario.roles.length > 0 && ` · roles: ${scenario.roles.join(', ')}`}
                          {scenario.preconditions !== '' && ` · given: ${scenario.preconditions}`}
                          {scenario.testData !== '' && ` · data: ${scenario.testData}`}
                        </div>
                        <ol class={[STEPS, 'my-1.5']}>
                          {scenario.steps.map((step, stepIndex) => (
                            <li key={stepIndex}>{step}</li>
                          ))}
                        </ol>
                        <div class="text-muted-foreground">Expected: {scenario.expected}</div>
                        {scenario.negative !== '' && <div class="text-muted-foreground">Negative: {scenario.negative}</div>}
                        {scenario.related !== '' && <div class="text-muted-foreground">Related: {scenario.related}</div>}
                      </li>
                    ))}
                  </ul>
                ),
              }}
            </Section>
            {(document.agents.length > 0 || document.skills.length > 0) && (
              <Section title="Agents and skills" emoji={EMOJI.agent}>
                <ul class={LIST}>
                  {document.agents.map((agent, index) => (
                    <li key={`a${index}`}>
                      <strong class="font-medium">{agent.agent}</strong>: {agent.work}
                    </li>
                  ))}
                  {document.skills.map((skill, index) => (
                    <li key={`s${index}`}>
                      <StatusBadge tone={skill.used ? 'pass' : 'warn'}>{skill.used ? 'used' : 'not used'}</StatusBadge> {skill.name}
                      {skill.note !== '' && <span class="text-muted-foreground"> · {skill.note}</span>}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Proposed commits" emoji={EMOJI.next}>
              <ul class={LIST}>
                {document.commitSubjects.map((subject, index) => (
                  <li key={index}>
                    <code class="font-mono text-xs">{subject}</code>
                  </li>
                ))}
              </ul>
            </Section>
            {document.artifact !== '' && (
              <Section title="Artifact" emoji={EMOJI.artifact}>
                <p class={PREWRAP}>{document.artifact}</p>
              </Section>
            )}
          </div>
        </div>
      );
    };
  },
});
