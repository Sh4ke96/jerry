import { defineComponent } from 'vue';
import { slotted } from '../lib/component';

/** Label and value pairs (a task's plan, a repository's profile). */
export const Facts = slotted('Facts', 'dl', 'facts', 'grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm');

export const Fact = defineComponent({
  name: 'Fact',
  props: { label: { type: String, required: true } },
  setup(props, { slots }) {
    return () => [
      <dt class="text-muted-foreground">{props.label}</dt>,
      <dd class="min-w-0">{slots.default?.()}</dd>,
    ];
  },
});
