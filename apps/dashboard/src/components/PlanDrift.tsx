import type { PlanDrift } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType } from 'vue';
import { Emoji } from './Emoji';

/**
 * Where the work strays from the plan: files no step names, steps not started yet, the
 * order of the steps and who implements what. Information for the review, not a verdict.
 */
export const PlanDriftView = defineComponent({
  name: 'PlanDriftView',
  props: { drift: { type: Object as PropType<PlanDrift>, required: true } },
  setup(props) {
    return () => {
      const { drift } = props;
      return (
        <section class="plan-drift">
          <h3>
            <Emoji symbol={EMOJI.plan} />
            Plan drift
          </h3>
          {drift.unplannedFiles.length === 0 ? (
            <p class="muted">
              <Emoji symbol={EMOJI.pass} />
              Every changed file is named by the plan.
            </p>
          ) : (
            <p class="attention">
              <Emoji symbol={EMOJI.warning} />
              Changed but not named by any plan step: {drift.unplannedFiles.map((file) => <code key={file}>{file} </code>)}
            </p>
          )}
          {drift.untouchedSteps.length > 0 && (
            <p>
              Steps not started yet:{' '}
              {drift.untouchedSteps.map((step) => (
                <span key={step.number} class="chip">
                  {step.number}. {step.step}
                </span>
              ))}
            </p>
          )}
          {drift.layers.length > 0 && (
            <p class="muted small">
              Step order: {drift.layers.map((layer) => layer.join(' + ')).join(' → ')}
              {drift.blockedSteps.length > 0 && ` · cannot be ordered: ${drift.blockedSteps.join(', ')}`}
            </p>
          )}
          {drift.assignments.length > 0 && (
            <ul class="list">
              {drift.assignments.map((assignment) => (
                <li key={assignment.label}>
                  <Emoji symbol={EMOJI.agent} />
                  <strong>{assignment.label}</strong>: steps {assignment.steps.join(', ')} · {assignment.files.join(', ')}{' '}
                  <span class="muted small">{assignment.agentId === null ? 'not started' : `implementer ${assignment.agentId}`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      );
    };
  },
});
