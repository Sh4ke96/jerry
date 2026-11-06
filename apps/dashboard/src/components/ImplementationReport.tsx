import type { ImplementationReportRecord } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType, type VNodeChild } from 'vue';
import { formatTime } from '../format';
import { Badge, type Tone } from './Badge';
import { Emoji, resultEmoji } from './Emoji';

const RESULT_TONE: Record<'PASS' | 'FAIL' | 'NOT_RUN', Tone> = { PASS: 'pass', FAIL: 'deny', NOT_RUN: 'warn' };
const SEVERITY_TONE: Record<'low' | 'medium' | 'high' | 'critical', Tone> = { low: 'neutral', medium: 'warn', high: 'deny', critical: 'deny' };

function section(title: string, content: VNodeChild, empty: boolean, open = false, emoji?: string): VNodeChild {
  if (empty) return null;
  return (
    <details class="plan-section" open={open}>
      <summary>
        {emoji !== undefined && <Emoji symbol={emoji} />}
        {title}
      </summary>
      <div class="plan-section__body">{content}</div>
    </details>
  );
}

/**
 * Claude's implementation report next to what JERRY recorded itself, so the user judges the
 * claims against the facts before accepting.
 */
export const ImplementationReportView = defineComponent({
  name: 'ImplementationReportView',
  props: { report: { type: Object as PropType<ImplementationReportRecord>, required: true } },
  setup(props) {
    return () => {
      const { document, evidence } = props.report;
      const problems = document.checks.filter((check) => check.result !== 'PASS');
      return (
        <div class="plan report">
          <h3>
            <Emoji symbol={EMOJI.report} />
            Implementation report v{props.report.version}{' '}
            <span class="muted small">
              for plan v{props.report.planVersion} · {formatTime(props.report.createdAt)} · written by {props.report.submittedBy === 'claude' ? 'Claude' : 'you'}
            </span>
          </h3>
          <p class="plan__goal">{document.summary}</p>

          <section class={['evidence', evidence.unreportedEdits.length > 0 || evidence.deviationCount > 0 || problems.length > 0 ? 'evidence--attention' : '']}>
            <h4>
              <Emoji symbol={EMOJI.jerry} />
              Recorded by JERRY since the plan approval
            </h4>
            <p>
              {evidence.deviationCount} deviation(s) · {evidence.blockedCount} blocked · {evidence.observedEdits.length} file(s) edited with the file tools
            </p>
            {evidence.unreportedEdits.length > 0 && (
              <p class="attention">
                <Emoji symbol={EMOJI.warning} />
                Edited but not in the report:{' '}
                {evidence.unreportedEdits.map((file) => (
                  <code class="chip" key={file}>
                    {file}
                  </code>
                ))}
              </p>
            )}
            {problems.length > 0 && (
              <p class="attention">
                <Emoji symbol={EMOJI.warning} />
                {problems.length} check(s) failed or did not run.
              </p>
            )}
            {evidence.deviations.length > 0 && (
              <ul class="list small">
                {evidence.deviations.map((deviation, index) => (
                  <li key={index}>
                    <span class="muted">{formatTime(deviation.at)}</span> {deviation.tool} <code>{deviation.target}</code> <span class="muted">{deviation.rule}</span>
                  </li>
                ))}
              </ul>
            )}
            {evidence.quality !== undefined && (
              <div class="evidence__quality">
                <p>
                  <Emoji symbol={EMOJI.finding} />
                  Quality: {evidence.quality.openFindings} open finding(s)
                  {evidence.quality.lastTestRun !== null && (
                    <span>
                      {' '}
                      · last tests JERRY saw: <Badge tone={evidence.quality.lastTestRun.result === 'PASS' ? 'pass' : 'deny'} emoji={resultEmoji(evidence.quality.lastTestRun.result)}>
                        {evidence.quality.lastTestRun.result}
                      </Badge> <code>{evidence.quality.lastTestRun.command}</code>
                    </span>
                  )}
                </p>
                {evidence.quality.serious.length > 0 && <p class="attention">Open P1/P2 findings: {evidence.quality.serious.join('; ')}</p>}
                {evidence.quality.claimedVsObserved.map((line) => (
                  <p key={line} class="attention">
                    {line}
                  </p>
                ))}
                {evidence.quality.unplannedFiles.length > 0 && <p class="attention">Changed but named by no plan step: {evidence.quality.unplannedFiles.join(', ')}</p>}
                {evidence.quality.untouchedSteps.length > 0 && <p class="muted">Plan steps without changes: {evidence.quality.untouchedSteps.join('; ')}</p>}
              </div>
            )}
          </section>

          {section(
            `Checks (${document.checks.length})`,
            <ul class="list">
              {document.checks.map((check, index) => (
                <li key={index}>
                  <Badge tone={RESULT_TONE[check.result]} emoji={resultEmoji(check.result)}>
                    {check.result}
                  </Badge>{' '}
                  <Badge>{check.kind}</Badge> <code>{check.command}</code>
                  {check.details !== '' && <span class="muted"> · {check.details}</span>}
                </li>
              ))}
            </ul>,
            false,
            true,
            EMOJI.tests,
          )}
          {section(
            `Changes (${document.changes.length})`,
            <ul class="list">
              {document.changes.map((change, index) => (
                <li key={index}>
                  <strong>{change.kind}</strong> <code>{change.repository === '' ? change.path : `${change.repository}: ${change.path}`}</code>: {change.description}
                </li>
              ))}
            </ul>,
            false,
            true,
            EMOJI.implementation,
          )}
          {section(
            `Differences from the plan (${document.planDeviations.length})`,
            <ul class="list">
              {document.planDeviations.map((deviation, index) => (
                <li key={index}>
                  {deviation.description} <span class="muted">· {deviation.reason}</span>
                </li>
              ))}
            </ul>,
            document.planDeviations.length === 0,
            true,
            EMOJI.plan,
          )}
          {section(
            `Risks and findings (${document.risks.length})`,
            <ul class="list">
              {document.risks.map((risk, index) => (
                <li key={index}>
                  <Badge tone={SEVERITY_TONE[risk.severity]}>{risk.severity}</Badge> {risk.risk}
                  {risk.mitigation !== '' && <span class="muted"> → {risk.mitigation}</span>}
                </li>
              ))}
            </ul>,
            document.risks.length === 0,
            document.risks.some((risk) => risk.severity === 'high' || risk.severity === 'critical'),
            EMOJI.warning,
          )}
          {section(
            `Manual QA (${document.qaScenarios.length})`,
            <ul class="list">
              {document.qaScenarios.map((scenario) => (
                <li key={scenario.id}>
                  <strong>
                    {scenario.id} {scenario.title}
                  </strong>{' '}
                  <Badge tone={scenario.priority === 'P1' ? 'warn' : 'neutral'}>{scenario.priority}</Badge> <Badge>{scenario.kind}</Badge>
                  <div class="muted small">
                    {scenario.location}
                    {scenario.roles.length > 0 && ` · roles: ${scenario.roles.join(', ')}`}
                    {scenario.preconditions !== '' && ` · given: ${scenario.preconditions}`}
                    {scenario.testData !== '' && ` · data: ${scenario.testData}`}
                  </div>
                  <ol class="steps">
                    {scenario.steps.map((step, stepIndex) => (
                      <li key={stepIndex}>{step}</li>
                    ))}
                  </ol>
                  <div class="muted">Expected: {scenario.expected}</div>
                  {scenario.negative !== '' && <div class="muted">Negative: {scenario.negative}</div>}
                  {scenario.related !== '' && <div class="muted">Related: {scenario.related}</div>}
                </li>
              ))}
            </ul>,
            false,
            false,
            EMOJI.tests,
          )}
          {section(
            'Agents and skills',
            <ul class="list">
              {document.agents.map((agent, index) => (
                <li key={`a${index}`}>
                  <strong>{agent.agent}</strong>: {agent.work}
                </li>
              ))}
              {document.skills.map((skill, index) => (
                <li key={`s${index}`}>
                  <Badge tone={skill.used ? 'pass' : 'warn'}>{skill.used ? 'used' : 'not used'}</Badge> {skill.name}
                  {skill.note !== '' && <span class="muted"> · {skill.note}</span>}
                </li>
              ))}
            </ul>,
            document.agents.length === 0 && document.skills.length === 0,
            false,
            EMOJI.agent,
          )}
          {section(
            'Proposed commits',
            <ul class="list">
              {document.commitSubjects.map((subject, index) => (
                <li key={index}>
                  <code>{subject}</code>
                </li>
              ))}
            </ul>,
            false,
            false,
            EMOJI.next,
          )}
          {section('Artifact', <p class="prewrap">{document.artifact}</p>, document.artifact === '', false, EMOJI.artifact)}
        </div>
      );
    };
  },
});
