import type { PlanGrade } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType } from 'vue';
import { Badge, type Tone } from './Badge';
import { Emoji } from './Emoji';

const LEVEL: Record<PlanGrade['level'], { label: string; tone: Tone; emoji: string }> = {
  complete: { label: 'complete', tone: 'pass', emoji: EMOJI.pass },
  'mostly-complete': { label: 'mostly complete', tone: 'warn', emoji: EMOJI.warning },
  incomplete: { label: 'incomplete', tone: 'deny', emoji: EMOJI.fail },
  'scope-only': { label: 'scope only', tone: 'neutral', emoji: EMOJI.info },
};

/**
 * JERRY's completeness check of the plan. Informational: the gaps are shown to help
 * the review, and the approval stays the user's decision.
 */
export const PlanGradeView = defineComponent({
  name: 'PlanGradeView',
  props: { grade: { type: Object as PropType<PlanGrade>, required: true } },
  setup(props) {
    return () => {
      const { grade } = props;
      const missing = grade.checks.filter((check) => !check.passed);
      const level = LEVEL[grade.level];
      return (
        <details class="plan-section plan-grade" open={missing.some((check) => check.weight === 'major')}>
          <summary>
            <Emoji symbol={EMOJI.plan} />
            Plan completeness{' '}
            <Badge tone={level.tone} emoji={level.emoji}>
              {level.label}
            </Badge>{' '}
            <span class="muted small">
              {grade.level === 'scope-only' ? 'nothing to grade' : `${grade.score}/100`} · plan v{grade.planVersion} · informational, you decide
            </span>
          </summary>
          <div class="plan-section__body">
            {missing.length === 0 ? (
              <p class="muted">Every check passed ({grade.checks.length}).</p>
            ) : (
              <ul class="list">
                {missing.map((check) => (
                  <li key={check.id}>
                    <Badge tone={check.weight === 'major' ? 'deny' : 'warn'}>{check.weight}</Badge> {check.detail}
                  </li>
                ))}
              </ul>
            )}
            {missing.length > 0 && <p class="muted small">Passed: {grade.checks.length - missing.length} of {grade.checks.length} checks.</p>}
          </div>
        </details>
      );
    };
  },
});
