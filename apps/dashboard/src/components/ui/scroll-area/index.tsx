// ScrollArea, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
// reka-ui's viewport adds an inline style element that the dashboard's CSP refuses; styles.css carries
// the same scrollbar rules, so the area looks the same.
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaScrollbar, ScrollAreaThumb, ScrollAreaViewport, type ScrollAreaRootProps } from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const ScrollBar = defineComponent(
  (props: ElementProps & { orientation?: 'vertical' | 'horizontal' }) => () => {
    const orientation = props.orientation ?? 'vertical';
    return (
      <ScrollAreaScrollbar
        data-slot="scroll-area-scrollbar"
        orientation={orientation}
        class={cn('flex touch-none p-px transition-colors select-none', orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent', orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent', props.class)}
      >
        <ScrollAreaThumb data-slot="scroll-area-thumb" class="bg-border relative flex-1 rounded-full" />
      </ScrollAreaScrollbar>
    );
  },
  { name: 'ScrollBar', props: ['class', 'orientation'] },
);

export const ScrollArea = defineComponent(
  (props: ElementProps & ScrollAreaRootProps, { slots }) =>
    () => (
      <ScrollAreaRoot data-slot="scroll-area" class={cn('relative', props.class)}>
        <ScrollAreaViewport data-slot="scroll-area-viewport" class="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-3 focus-visible:outline-1">
          {slots.default?.()}
        </ScrollAreaViewport>
        <ScrollBar />
        <ScrollAreaCorner />
      </ScrollAreaRoot>
    ),
  { name: 'ScrollArea', props: ['class'] },
);
