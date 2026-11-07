import { EMOJI } from '@jerry/contracts/emoji';
import { isEmptyDiff, type PlanDiff } from '@jerry/workflow';
import { defineComponent, type PropType } from 'vue';
import { ATTENTION } from '../lib/classes';
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
        <li
          key={key}
          data-change={sign === '+' ? 'added' : 'removed'}
          class={[
            'rounded-md px-2 py-0.5 break-words',
            sign === '+' ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300' : 'bg-destructive/10 text-destructive decoration-destructive/40 line-through',
          ]}
        >
          <span class="inline-block w-5 font-mono font-semibold" aria-hidden="true">
            {sign}
          </span>
          <span class="sr-only">{sign === '+' ? 'added: ' : 'removed: '}</span>
          {text}
        </li>
      );
      return (
        <section class="plan-diff grid gap-3 rounded-lg border p-4 text-sm">
          <h3 class="flex items-center font-semibold">
            <Emoji symbol={EMOJI.plan} />
            Plan v{diff.from} → v{diff.to}
          </h3>
          {isEmptyDiff(diff) && <p class="text-muted-foreground">No differences in what you review.</p>}
          {diff.document === 'added' && <p>The full plan document was added; v{diff.from} had only a scope.</p>}
          {diff.document === 'removed' && (
            <p class={ATTENTION}>
              <Emoji symbol={EMOJI.warning} />
              The full plan document was removed; v{diff.to} has only a scope.
            </p>
          )}
          {diff.scope.added.length + diff.scope.removed.length > 0 && (
            <div class="grid gap-1">
              <h4 class="font-medium">Scope (what JERRY checks edits against)</h4>
              <ul class="grid gap-1 font-mono text-xs">
                {diff.scope.added.map((glob, index) => line('+', glob, `sa${index}`))}
                {diff.scope.removed.map((glob, index) => line('−', glob, `sr${index}`))}
              </ul>
            </div>
          )}
          {diff.sections.map((section) => (
            <div class="grid gap-1" key={section.section}>
              <h4 class="font-medium">{section.section}</h4>
              <ul class="grid gap-1">
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
