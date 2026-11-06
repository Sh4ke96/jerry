import type { PlanDocument } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType, type VNodeChild } from 'vue';
import { Badge, type Tone } from './Badge';
import { Emoji } from './Emoji';

const SEVERITY_TONE: Record<'low' | 'medium' | 'high', Tone> = { low: 'neutral', medium: 'warn', high: 'deny' };
const CHANGE_LABEL: Record<'add' | 'change' | 'remove', string> = { add: 'Add', change: 'Change', remove: 'Remove' };

/** One section of the plan; empty sections are left out so the plan reads as a document. */
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

/** The full plan Claude submitted, as the user reviews it before approving. */
export const PlanDocumentView = defineComponent({
  name: 'PlanDocumentView',
  props: { plan: { type: Object as PropType<PlanDocument>, required: true } },
  setup(props) {
    return () => {
      const plan = props.plan;
      return (
        <div class="plan">
          <p class="plan__goal">{plan.goal}</p>
          <p class="chips">
            {plan.classification.map((area) => (
              <Badge key={area} tone="accent">
                {area}
              </Badge>
            ))}
          </p>
          {section('Current state', <p class="prewrap">{plan.currentState}</p>, false)}
          {section(
            `Changes (${plan.changes.length})`,
            <ul class="list">
              {plan.changes.map((change, index) => (
                <li key={index}>
                  <strong>{CHANGE_LABEL[change.kind]}</strong> <code>{change.target}</code>: {change.description}
                </li>
              ))}
            </ul>,
            false,
            true,
            EMOJI.implementation,
          )}
          {section('Architecture impact', <p class="prewrap">{plan.architectureImpact}</p>, false)}
          {section('Cross-repository dependencies', <p class="prewrap">{plan.crossRepoDependencies}</p>, plan.crossRepoDependencies === '', false, EMOJI.repository)}
          {section(
            `Risks (${plan.risks.length})`,
            <ul class="list">
              {plan.risks.map((risk, index) => (
                <li key={index}>
                  <Badge tone={SEVERITY_TONE[risk.severity]}>{risk.severity}</Badge> {risk.risk} <span class="muted">→ {risk.mitigation}</span>
                </li>
              ))}
            </ul>,
            plan.risks.length === 0,
            plan.risks.some((risk) => risk.severity === 'high'),
            EMOJI.warning,
          )}
          {section('Rollback', <p class="prewrap">{plan.rollback}</p>, plan.rollback === '')}
          {section(
            'Out of scope',
            <p class="chips">
              {plan.scope.exclude.map((area) => (
                <code class="chip" key={area}>
                  {area}
                </code>
              ))}
            </p>,
            plan.scope.exclude.length === 0,
          )}
          {section(
            `Steps (${plan.steps.length})`,
            <ol class="steps">
              {plan.steps.map((step, index) => (
                <li key={index}>
                  {step.step}
                  {step.dependsOn.length > 0 && <span class="muted"> (after {step.dependsOn.join(', ')})</span>}
                  {step.files.length > 0 && (
                    <div class="chips">
                      {step.files.map((file) => (
                        <code class="chip" key={file}>
                          {file}
                        </code>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>,
            false,
            false,
            EMOJI.plan,
          )}
          {section(
            `Tests (${plan.tests.length})`,
            <ul class="list">
              {plan.tests.map((test, index) => (
                <li key={index}>
                  <Badge>{test.kind}</Badge> {test.description}
                </li>
              ))}
            </ul>,
            false,
            false,
            EMOJI.tests,
          )}
          {section('Regression', <p class="prewrap">{plan.regression}</p>, plan.regression === '')}
          {section(
            `Manual QA (${plan.qaScenarios.length})`,
            <ul class="list">
              {plan.qaScenarios.map((scenario, index) => (
                <li key={index}>
                  <strong>{scenario.title}</strong>
                  <ol class="steps">
                    {scenario.steps.map((step, stepIndex) => (
                      <li key={stepIndex}>{step}</li>
                    ))}
                  </ol>
                  <span class="muted">Expected: {scenario.expected}</span>
                </li>
              ))}
            </ul>,
            plan.qaScenarios.length === 0,
            false,
            EMOJI.tests,
          )}
          {section(
            'Proposed commits',
            <ul class="list">
              {plan.commitSubjects.map((subject, index) => (
                <li key={index}>
                  <code>{subject}</code>
                </li>
              ))}
            </ul>,
            plan.commitSubjects.length === 0,
            false,
            EMOJI.next,
          )}
          {section('Artifact', <p class="prewrap">{plan.artifact}</p>, plan.artifact === '', false, EMOJI.artifact)}
          {section(
            'Definition of Done',
            <ul class="list">
              {plan.definitionOfDone.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>,
            false,
            true,
            EMOJI.done,
          )}
          {section(
            `Open questions (${plan.openQuestions.length})`,
            <ul class="list">
              {plan.openQuestions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>,
            plan.openQuestions.length === 0,
            true,
            EMOJI.session,
          )}
          {plan.analysis !== undefined &&
            section(
              `Based on analysis (${plan.analysis.reports.length} report(s), ${plan.analysis.gaps.length} gap(s))`,
              <div>
                <p>
                  Analysis reports:{' '}
                  {plan.analysis.reports.length === 0 ? <span class="muted">none</span> : plan.analysis.reports.map((id) => <code key={id} class="chip">#{id}</code>)}
                </p>
                {plan.analysis.gaps.length > 0 && (
                  <ul class="list">
                    {plan.analysis.gaps.map((gap, index) => (
                      <li key={index}>{gap}</li>
                    ))}
                  </ul>
                )}
              </div>,
              false,
              plan.analysis.gaps.length > 0,
              EMOJI.analysis,
            )}
        </div>
      );
    };
  },
});
