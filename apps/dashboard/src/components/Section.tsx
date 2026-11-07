import { ChevronDown } from '@lucide/vue';
import { defineComponent } from 'vue';
import { classProp, cn } from '../lib/utils';
import { Emoji } from './Emoji';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';

/**
 * A part of a plan, report or task that folds away, styled like shadcn's accordion item. Folded
 * content stays in the page (hidden until found), so the browser's search still finds it.
 */
export const Section = defineComponent({
  name: 'Section',
  props: {
    title: { type: String, default: undefined },
    emoji: { type: String, default: undefined },
    defaultOpen: { type: Boolean, default: false },
    class: classProp,
  },
  emits: { toggle: (open: boolean) => typeof open === 'boolean' },
  setup(props, { slots, emit }) {
    return () => (
      <Collapsible defaultOpen={props.defaultOpen} unmountOnHide={false} class={cn('border-b last:border-b-0', props.class)} onUpdate:open={(open: boolean) => emit('toggle', open)}>
        <CollapsibleTrigger class="focus-visible:border-ring focus-visible:ring-ring/50 flex w-full flex-1 items-center justify-between gap-4 rounded-md py-3 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180">
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            {props.emoji !== undefined && <Emoji symbol={props.emoji} class="mr-0" />}
            {slots.title?.() ?? props.title}
          </span>
          <ChevronDown class="text-muted-foreground pointer-events-none size-4 shrink-0 transition-transform duration-200" />
        </CollapsibleTrigger>
        <CollapsibleContent class="pb-4 text-sm">{slots.default?.()}</CollapsibleContent>
      </Collapsible>
    );
  },
});
