// Progress, after shadcn-vue 2.9.0, style "new-york-v4" (its classes)
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
// shadcn moves the indicator with an inline transform; the dashboard's CSP allows no inline style,
// so the indicator is an SVG rectangle whose width is an attribute.
import { defineComponent } from 'vue';
import { classProp, cn } from '../../../lib/utils';

export const Progress = defineComponent({
  name: 'Progress',
  props: {
    /** 0–100; anything outside is clamped. */
    modelValue: { type: Number, default: 0 },
    /** Accessible name of the bar. */
    label: { type: String, default: undefined },
    class: classProp,
    /** Classes of the filled part (an SVG rect: use fill-* colours). */
    indicatorClass: classProp,
  },
  setup(props) {
    return () => {
      const value = Math.min(100, Math.max(0, Number.isFinite(props.modelValue) ? props.modelValue : 0));
      return (
        <div
          data-slot="progress"
          role="progressbar"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(value)}
          class={cn('bg-primary/20 relative h-2 w-full overflow-hidden rounded-full', props.class)}
        >
          <svg data-slot="progress-indicator" class="block size-full" viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="0" width={value} height="1" class={cn('fill-primary transition-all', props.indicatorClass)} />
          </svg>
        </div>
      );
    };
  },
});
