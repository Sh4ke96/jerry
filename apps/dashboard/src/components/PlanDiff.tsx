import { EMOJI } from '@jerry/contracts/emoji';
import { isEmptyDiff, type PlanDiff } from '@jerry/workflow';
import { defineComponent, type PropType } from 'vue';
import { Emoji } from './Emoji';

/**
 * What changed between two plan versions: the scope JERRY checks edits against first,
 * then each changed section with its added (+) and removed (−) items.
 */
export const PlanDiffView = defineComponent({
  name: 'PlanDiffView',
  props: { diff: { type: Object as PropType<PlanDiff>, required: true } },
  setup(props) {
    return () => {
      const { diff } = props;
      const line = (sign: '+' | '−', text: string, key: string) => (
        <li key={key} class={sign === '+' ? 'diff__added' : 'diff__removed'}>
          <span class="diff__sign" aria-hidden="true">
            {sign}
          </span>
          <span class="sr-only">{sign === '+' ? 'added: ' : 'removed: '}</span>
          {text}
        </li>
      );
      return (
        <section class="plan-diff">
          <h3>
            <Emoji symbol={EMOJI.plan} />
            Plan v{diff.from} → v{diff.to}
          </h3>
          {isEmptyDiff(diff) && <p class="muted">No differences in what you review.</p>}
          {diff.document === 'added' && <p>The full plan document was added; v{diff.from} had only a scope.</p>}
          {diff.document === 'removed' && (
            <p class="attention">
              <Emoji symbol={EMOJI.warning} />
              The full plan document was removed; v{diff.to} has only a scope.
            </p>
          )}
          {diff.scope.added.length + diff.scope.removed.length > 0 && (
            <div class="diff__section">
              <h4>Scope (what JERRY checks edits against)</h4>
              <ul class="diff">
                {diff.scope.added.map((glob, index) => line('+', glob, `sa${index}`))}
                {diff.scope.removed.map((glob, index) => line('−', glob, `sr${index}`))}
              </ul>
            </div>
          )}
          {diff.sections.map((section) => (
            <div class="diff__section" key={section.section}>
              <h4>{section.section}</h4>
              <ul class="diff">
                {section.before !== undefined && section.before !== '' && line('−', section.before, 'before')}
                {section.after !== undefined && section.after !== '' && line('+', section.after, 'after')}
                {section.added.map((item, index) => line('+', item, `a${index}`))}
                {section.removed.map((item, index) => line('−', item, `r${index}`))}
              </ul>
            </div>
          ))}
        </section>
      );
    };
  },
});
