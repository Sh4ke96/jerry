import type { PlanGrade } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType } from 'vue';
import { LIST } from '../lib/classes';
import { Section } from './Section';
import { StatusBadge, type Tone } from './StatusBadge';

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
        <Section class="plan-grade" emoji={EMOJI.plan} defaultOpen={missing.some((check) => check.weight === 'major')}>
          {{
            title: () => [
              'Plan completeness ',
              <StatusBadge tone={level.tone} emoji={level.emoji}>
                {level.label}
              </StatusBadge>,
              <span class="text-muted-foreground text-xs font-normal">
                {grade.level === 'scope-only' ? 'nothing to grade' : `${grade.score}/100`} · plan v{grade.planVersion} · informational, you decide
              </span>,
            ],
            default: () => [
              missing.length === 0 ? (
                <p class="text-muted-foreground">Every check passed ({grade.checks.length}).</p>
              ) : (
                <ul class={LIST}>
                  {missing.map((check) => (
                    <li key={check.id}>
                      <StatusBadge tone={check.weight === 'major' ? 'deny' : 'warn'}>{check.weight}</StatusBadge> {check.detail}
                    </li>
                  ))}
                </ul>
              ),
              missing.length > 0 && (
                <p class="text-muted-foreground mt-2 text-xs">
                  Passed: {grade.checks.length - missing.length} of {grade.checks.length} checks.
                </p>
              ),
            ],
          }}
        </Section>
      );
    };
  },
});
