// Label, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { Label as LabelRoot } from 'reka-ui';
import { defineComponent, type LabelHTMLAttributes } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const Label = defineComponent(
  (props: ElementProps<LabelHTMLAttributes>, { slots }) =>
    () => (
      <LabelRoot
        data-slot="label"
        class={cn(
          'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
          props.class,
        )}
      >
        {slots.default?.()}
      </LabelRoot>
    ),
  { name: 'Label', props: ['class'] },
);
