// Alert, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { cva, type VariantProps } from 'class-variance-authority';
import { defineComponent } from 'vue';
import { slotted, type ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const alertVariants = cva(
  'relative w-full rounded-lg border px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive: 'text-destructive bg-card [&>svg]:text-current *:data-[slot=alert-description]:text-destructive/90',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type AlertVariants = VariantProps<typeof alertVariants>;

/** `role="alert"` by default; pass another role (e.g. `status`) for news that is not an error. */
export const Alert = defineComponent(
  (props: ElementProps & { variant?: AlertVariants['variant'] }, { slots }) =>
    () => (
      <div data-slot="alert" role="alert" class={cn(alertVariants({ variant: props.variant }), props.class)}>
        {slots.default?.()}
      </div>
    ),
  { name: 'Alert', props: ['variant', 'class'] },
);

export const AlertTitle = slotted('AlertTitle', 'div', 'alert-title', 'col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight');

export const AlertDescription = slotted('AlertDescription', 'div', 'alert-description', 'text-muted-foreground col-start-2 text-sm [&_p]:leading-relaxed');
