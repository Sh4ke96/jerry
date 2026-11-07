import { defineComponent, type PropType } from 'vue';
import { classProp, cn } from '../lib/utils';

export interface SegmentedOption {
  value: string;
  label: string;
  /** Shown under the control while this option is chosen. */
  hint?: string;
}

/**
 * One choice out of a few, as a row of buttons in the look of shadcn's tabs list. A radio group for
 * assistive technology: arrow keys move between the options.
 */
export const Segmented = defineComponent({
  name: 'Segmented',
  props: {
    modelValue: { type: String, required: true },
    options: { type: Array as PropType<SegmentedOption[]>, required: true },
    label: { type: String, required: true },
    disabled: { type: Boolean, default: false },
    class: classProp,
  },
  emits: { 'update:modelValue': (value: string) => typeof value === 'string' },
  setup(props, { emit }) {
    const choose = (value: string): void => {
      if (!props.disabled && value !== props.modelValue) emit('update:modelValue', value);
    };
    const onKeydown = (event: KeyboardEvent): void => {
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const index = props.options.findIndex((option) => option.value === props.modelValue);
      const next = props.options[(index + step + props.options.length) % props.options.length];
      if (next === undefined) return;
      choose(next.value);
      const group = event.currentTarget as HTMLElement | null;
      for (const button of Array.from(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])) if (button.dataset['value'] === next.value) button.focus();
    };
    return () => (
      <div role="radiogroup" aria-label={props.label} data-slot="segmented" class={cn('bg-muted text-muted-foreground inline-flex h-9 w-fit max-w-full items-center rounded-lg p-0.75', props.class)} onKeydown={onKeydown}>
        {props.options.map((option) => {
          const checked = option.value === props.modelValue;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={checked ? 'true' : 'false'}
              tabindex={checked ? 0 : -1}
              disabled={props.disabled}
              data-value={option.value}
              data-state={checked ? 'active' : 'inactive'}
              class="data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm"
              onClick={() => choose(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  },
});
