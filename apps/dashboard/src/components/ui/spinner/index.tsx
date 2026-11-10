// Spinner, in the shape of shadcn-vue's spinner (new-york-v4): a turning LoaderCircle that announces itself.
import { LoaderCircle } from '@lucide/vue';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

/**
 * A spinning circle. It spins only when the user allows motion (motion-safe); with reduced motion it
 * stands still and the text next to it says what is happening.
 */
export const Spinner = defineComponent(
  (props: ElementProps & { label?: string }) => () => <LoaderCircle role="status" aria-label={props.label ?? 'Loading'} data-slot="spinner" class={cn('size-4 shrink-0 motion-safe:animate-spin', props.class)} />,
  { name: 'Spinner', props: ['class', 'label'] },
);

/** What is loading, in words, with the spinner in front: the dashboard's inline loading state. */
export const Loading = defineComponent(
  (props: ElementProps & { text?: string }, { slots }) =>
    () => (
      <p data-slot="loading" class={cn('text-muted-foreground flex items-center gap-2 text-sm', props.class)} aria-live="polite">
        <Spinner label={props.text ?? 'Loading…'} />
        <span>{slots.default?.() ?? props.text ?? 'Loading…'}</span>
      </p>
    ),
  { name: 'Loading', props: ['class', 'text'] },
);
