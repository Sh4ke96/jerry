// Tooltip, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { TooltipArrow, TooltipContent as TooltipContentRoot, TooltipPortal, TooltipProvider as TooltipProviderRoot, TooltipRoot, TooltipTrigger as TooltipTriggerRoot, type TooltipContentProps, type TooltipProviderProps, type TooltipRootProps } from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const TooltipProvider = defineComponent(
  (props: TooltipProviderProps, { slots }) =>
    () => <TooltipProviderRoot delayDuration={props.delayDuration ?? 0}>{slots.default?.()}</TooltipProviderRoot>,
  { name: 'TooltipProvider', props: ['delayDuration'] },
);

export const Tooltip = defineComponent((_props: TooltipRootProps, { slots }) => () => <TooltipRoot>{slots.default?.()}</TooltipRoot>, { name: 'Tooltip', props: [] });

export const TooltipTrigger = defineComponent((_props: { asChild?: boolean }, { slots }) => () => <TooltipTriggerRoot data-slot="tooltip-trigger">{slots.default?.()}</TooltipTriggerRoot>, { name: 'TooltipTrigger', props: [] });

export const TooltipContent = defineComponent(
  (props: ElementProps & TooltipContentProps, { slots, attrs }) =>
    () => (
      <TooltipPortal>
        <TooltipContentRoot
          data-slot="tooltip-content"
          sideOffset={props.sideOffset ?? 4}
          {...attrs}
          class={cn(
            'bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit rounded-md px-3 py-1.5 text-xs text-balance',
            props.class,
          )}
        >
          {slots.default?.()}
          <TooltipArrow class="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-xs" />
        </TooltipContentRoot>
      </TooltipPortal>
    ),
  { name: 'TooltipContent', props: ['class', 'sideOffset'], inheritAttrs: false },
);
