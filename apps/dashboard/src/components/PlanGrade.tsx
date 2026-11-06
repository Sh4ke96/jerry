import type { PlanGrade } from '@jerry/contracts';
import { defineComponent, type PropType } from 'vue';
import { Badge, type Tone } from './Badge';

const LEVEL: Record<PlanGrade['level'], { label: string; tone: Tone }> = {
  complete: { label: 'complete', tone: 'pass' },
  'mostly-complete': { label: 'mostly complete', tone: 'warn' },
  incomplete: { label: 'incomplete', tone: 'deny' },
  'scope-only': { label: 'scope only', tone: 'neutral' },
};

/**
 * JERRY's completeness check of the plan (ADR 0025). Informational: the gaps are shown to help
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
            Plan completeness <Badge tone={level.tone}>{level.label}</Badge>{' '}
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
