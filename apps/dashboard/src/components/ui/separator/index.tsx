// Separator, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { Separator as SeparatorRoot } from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export type SeparatorProps = ElementProps & { orientation?: 'horizontal' | 'vertical'; decorative?: boolean };

export const Separator = defineComponent(
  (props: SeparatorProps) => () => (
    <SeparatorRoot
      data-slot="separator"
      orientation={props.orientation ?? 'horizontal'}
      decorative={props.decorative ?? true}
      class={cn('bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px', props.class)}
    />
  ),
  { name: 'Separator', props: ['orientation', 'decorative', 'class'] },
);
