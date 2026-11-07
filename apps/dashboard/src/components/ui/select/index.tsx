// Select, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
// reka-ui's viewport adds an inline style element that the dashboard's CSP refuses; styles.css carries
// the same scrollbar rules, so the list looks the same.
import { Check, ChevronDown, ChevronUp } from '@lucide/vue';
import {
  SelectContent as SelectContentRoot,
  SelectGroup as SelectGroupRoot,
  SelectIcon,
  SelectItem as SelectItemRoot,
  SelectItemIndicator,
  SelectItemText,
  SelectLabel as SelectLabelRoot,
  SelectPortal,
  SelectRoot,
  SelectScrollDownButton as SelectScrollDownButtonRoot,
  SelectScrollUpButton as SelectScrollUpButtonRoot,
  SelectSeparator as SelectSeparatorRoot,
  SelectTrigger as SelectTriggerRoot,
  SelectValue as SelectValueRoot,
  SelectViewport,
  type SelectContentProps,
  type SelectItemProps,
  type SelectRootProps,
  type SelectValueProps,
} from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const Select = defineComponent((_props: SelectRootProps<string> & { 'onUpdate:modelValue'?: (value: string) => void }, { slots }) => () => <SelectRoot>{slots.default?.()}</SelectRoot>, { name: 'Select', props: [] });

export const SelectGroup = defineComponent((_props: ElementProps, { slots }) => () => <SelectGroupRoot data-slot="select-group">{slots.default?.()}</SelectGroupRoot>, { name: 'SelectGroup', props: [] });

export const SelectValue = defineComponent((_props: SelectValueProps, { slots }) => () => <SelectValueRoot data-slot="select-value">{slots.default?.()}</SelectValueRoot>, { name: 'SelectValue', props: [] });

export const SelectTrigger = defineComponent(
  (props: ElementProps & { size?: 'sm' | 'default'; disabled?: boolean }, { slots }) =>
    () => (
      <SelectTriggerRoot
        data-slot="select-trigger"
        data-size={props.size ?? 'default'}
        class={cn(
          "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          props.class,
        )}
      >
        {slots.default?.()}
        <SelectIcon asChild>
          <ChevronDown class="size-4 opacity-50" />
        </SelectIcon>
      </SelectTriggerRoot>
    ),
  { name: 'SelectTrigger', props: ['class', 'size'] },
);

export const SelectScrollUpButton = defineComponent(
  (props: ElementProps) => () => (
    <SelectScrollUpButtonRoot data-slot="select-scroll-up-button" class={cn('flex cursor-default items-center justify-center py-1', props.class)}>
      <ChevronUp class="size-4" />
    </SelectScrollUpButtonRoot>
  ),
  { name: 'SelectScrollUpButton', props: ['class'] },
);

export const SelectScrollDownButton = defineComponent(
  (props: ElementProps) => () => (
    <SelectScrollDownButtonRoot data-slot="select-scroll-down-button" class={cn('flex cursor-default items-center justify-center py-1', props.class)}>
      <ChevronDown class="size-4" />
    </SelectScrollDownButtonRoot>
  ),
  { name: 'SelectScrollDownButton', props: ['class'] },
);

export const SelectContent = defineComponent(
  (props: ElementProps & SelectContentProps, { slots, attrs }) =>
    () => {
      const position = props.position ?? 'popper';
      return (
        <SelectPortal>
          <SelectContentRoot
            data-slot="select-content"
            position={position}
            {...attrs}
            class={cn(
              'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--reka-select-content-available-height) min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-md border shadow-md',
              position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
              props.class,
            )}
          >
            <SelectScrollUpButton />
            <SelectViewport class={cn('p-1', position === 'popper' && 'h-(--reka-select-trigger-height) w-full min-w-(--reka-select-trigger-width) scroll-my-1')}>{slots.default?.()}</SelectViewport>
            <SelectScrollDownButton />
          </SelectContentRoot>
        </SelectPortal>
      );
    },
  { name: 'SelectContent', props: ['class', 'position'], inheritAttrs: false },
);

export const SelectLabel = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <SelectLabelRoot data-slot="select-label" class={cn('text-muted-foreground px-2 py-1.5 text-xs', props.class)}>
        {slots.default?.()}
      </SelectLabelRoot>
    ),
  { name: 'SelectLabel', props: ['class'] },
);

export const SelectItem = defineComponent(
  (props: ElementProps & SelectItemProps<string>, { slots }) =>
    () => (
      <SelectItemRoot
        data-slot="select-item"
        value={props.value}
        class={cn(
          "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
          props.class,
        )}
      >
        <span class="absolute right-2 flex size-3.5 items-center justify-center">
          <SelectItemIndicator>
            <Check class="size-4" />
          </SelectItemIndicator>
        </span>
        <SelectItemText>{slots.default?.()}</SelectItemText>
      </SelectItemRoot>
    ),
  { name: 'SelectItem', props: ['class', 'value'] },
);

export const SelectSeparator = defineComponent((props: ElementProps) => () => <SelectSeparatorRoot data-slot="select-separator" class={cn('bg-border pointer-events-none -mx-1 my-1 h-px', props.class)} />, { name: 'SelectSeparator', props: ['class'] });
