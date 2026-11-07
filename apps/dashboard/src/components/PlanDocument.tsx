import type { PlanDocument } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType } from 'vue';
import { CHIP, LIST, PREWRAP, STEPS } from '../lib/classes';
import { projectName } from '../lib/tasks';
import { Section } from './Section';
import { StatusBadge, type Tone } from './StatusBadge';

const SEVERITY_TONE: Record<'low' | 'medium' | 'high', Tone> = { low: 'neutral', medium: 'warn', high: 'deny' };
const CHANGE_LABEL: Record<'add' | 'change' | 'remove', string> = { add: 'Add', change: 'Change', remove: 'Remove' };

/** A repository named by its folder, with its full root on hover. */
const RepositoryBadge = (props: { root: string }) => (
  <StatusBadge tone="accent" title={props.root} data-repository-badge={props.root}>
    {projectName(props.root)}
  </StatusBadge>
);

/** The full plan Claude submitted, as the user reviews it before approving. Empty sections are left out. */
export const PlanDocumentView = defineComponent({
  name: 'PlanDocumentView',
  props: { plan: { type: Object as PropType<PlanDocument>, required: true } },
  setup(props) {
    return () => {
      const plan = props.plan;
      return (
        <div class="plan grid gap-3 border-t pt-4">
          <p class="text-base font-medium">{plan.goal}</p>
          {plan.classification.length > 0 && (
            <p class="flex flex-wrap gap-1.5">
              {plan.classification.map((area) => (
                <StatusBadge key={area} tone="accent">
                  {area}
                </StatusBadge>
              ))}
            </p>
          )}
          <div>
            <Section title="Current state">
              <p class={PREWRAP}>{plan.currentState}</p>
            </Section>
            <Section title={`Changes (${plan.changes.length})`} defaultOpen emoji={EMOJI.implementation}>
              <ul class={LIST}>
                {plan.changes.map((change, index) => (
                  <li key={index}>
                    <strong class="font-medium">{CHANGE_LABEL[change.kind]}</strong> {change.repository !== undefined && <RepositoryBadge root={change.repository} />}
                    <code class={CHIP}>{change.target}</code>: {change.description}
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Architecture impact">
              <p class={PREWRAP}>{plan.architectureImpact}</p>
            </Section>
            {plan.crossRepoDependencies !== '' && (
              <Section title="Cross-repository dependencies" emoji={EMOJI.repository}>
                <p class={PREWRAP}>{plan.crossRepoDependencies}</p>
              </Section>
            )}
            {plan.risks.length > 0 && (
              <Section title={`Risks (${plan.risks.length})`} defaultOpen={plan.risks.some((risk) => risk.severity === 'high')} emoji={EMOJI.warning}>
                <ul class={LIST}>
                  {plan.risks.map((risk, index) => (
                    <li key={index}>
                      <StatusBadge tone={SEVERITY_TONE[risk.severity]}>{risk.severity}</StatusBadge> {risk.risk} <span class="text-muted-foreground">→ {risk.mitigation}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {plan.rollback !== '' && (
              <Section title="Rollback">
                <p class={PREWRAP}>{plan.rollback}</p>
              </Section>
            )}
            {(plan.repositoryScopes ?? []).length > 0 && (
              <Section title={`Other repositories (${(plan.repositoryScopes ?? []).length})`} defaultOpen emoji={EMOJI.repository}>
                <ul class={LIST}>
                  {(plan.repositoryScopes ?? []).map((scope) => (
                    <li key={scope.repository} class="plan-repository" data-plan-repository={scope.repository}>
                      <RepositoryBadge root={scope.repository} />
                      <span class="ml-1 inline-flex flex-wrap gap-1.5">
                        {scope.include.map((glob) => (
                          <code class={CHIP} key={glob}>
                            {glob}
                          </code>
                        ))}
                      </span>
                      {scope.exclude.length > 0 && <span class="text-muted-foreground"> · not {scope.exclude.join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {plan.scope.exclude.length > 0 && (
              <Section title="Out of scope">
                <p class="flex flex-wrap gap-1.5">
                  {plan.scope.exclude.map((area) => (
                    <code class={CHIP} key={area}>
                      {area}
                    </code>
                  ))}
                </p>
              </Section>
            )}
            <Section title={`Steps (${plan.steps.length})`} emoji={EMOJI.plan}>
              <ol class={STEPS}>
                {plan.steps.map((step, index) => (
                  <li key={index}>
                    {step.repository !== undefined && <RepositoryBadge root={step.repository} />} {step.step}
                    {step.dependsOn.length > 0 && <span class="text-muted-foreground"> (after {step.dependsOn.join(', ')})</span>}
                    {step.files.length > 0 && (
                      <div class="mt-1 flex flex-wrap gap-1.5">
                        {step.files.map((file) => (
                          <code class={CHIP} key={file}>
                            {file}
                          </code>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </Section>
            <Section title={`Tests (${plan.tests.length})`} emoji={EMOJI.tests}>
              <ul class={LIST}>
                {plan.tests.map((test, index) => (
                  <li key={index}>
                    <StatusBadge>{test.kind}</StatusBadge> {test.description}
                  </li>
                ))}
              </ul>
            </Section>
            {plan.regression !== '' && (
              <Section title="Regression">
                <p class={PREWRAP}>{plan.regression}</p>
              </Section>
            )}
            {plan.qaScenarios.length > 0 && (
              <Section title={`Manual QA (${plan.qaScenarios.length})`} emoji={EMOJI.tests}>
                <ul class={LIST}>
                  {plan.qaScenarios.map((scenario, index) => (
                    <li key={index}>
                      <strong class="font-medium">{scenario.title}</strong>
                      <ol class={[STEPS, 'my-1']}>
                        {scenario.steps.map((step, stepIndex) => (
                          <li key={stepIndex}>{step}</li>
                        ))}
                      </ol>
                      <span class="text-muted-foreground">Expected: {scenario.expected}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {plan.commitSubjects.length > 0 && (
              <Section title="Proposed commits" emoji={EMOJI.next}>
                <ul class={LIST}>
                  {plan.commitSubjects.map((subject, index) => (
                    <li key={index}>
                      <code class="font-mono text-xs">{subject}</code>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {plan.artifact !== '' && (
              <Section title="Artifact" emoji={EMOJI.artifact}>
                <p class={PREWRAP}>{plan.artifact}</p>
              </Section>
            )}
            <Section title="Definition of Done" defaultOpen emoji={EMOJI.done}>
              <ul class={[LIST, 'list-disc pl-5']}>
                {plan.definitionOfDone.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </Section>
            {plan.openQuestions.length > 0 && (
              <Section title={`Open questions (${plan.openQuestions.length})`} defaultOpen emoji={EMOJI.session}>
                <ul class={[LIST, 'list-disc pl-5']}>
                  {plan.openQuestions.map((question, index) => (
                    <li key={index}>{question}</li>
                  ))}
                </ul>
              </Section>
            )}
            {plan.analysis !== undefined && (
              <Section title={`Based on analysis (${plan.analysis.reports.length} report(s), ${plan.analysis.gaps.length} gap(s))`} defaultOpen={plan.analysis.gaps.length > 0} emoji={EMOJI.analysis}>
                <p class="flex flex-wrap items-center gap-1.5">
                  Analysis reports:{' '}
                  {plan.analysis.reports.length === 0 ? (
                    <span class="text-muted-foreground">none</span>
                  ) : (
                    plan.analysis.reports.map((id) => (
                      <code key={id} class={CHIP}>
                        #{id}
                      </code>
                    ))
                  )}
                </p>
                {plan.analysis.gaps.length > 0 && (
                  <ul class={[LIST, 'mt-2 list-disc pl-5']}>
                    {plan.analysis.gaps.map((gap, index) => (
                      <li key={index}>{gap}</li>
                    ))}
                  </ul>
                )}
              </Section>
            )}
          </div>
        </div>
      );
    };
  },
});
