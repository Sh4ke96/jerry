// DropdownMenu, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { Circle } from '@lucide/vue';
import {
  DropdownMenuContent as DropdownMenuContentRoot,
  DropdownMenuGroup as DropdownMenuGroupRoot,
  DropdownMenuItem as DropdownMenuItemRoot,
  DropdownMenuItemIndicator,
  DropdownMenuLabel as DropdownMenuLabelRoot,
  DropdownMenuPortal,
  DropdownMenuRadioGroup as DropdownMenuRadioGroupRoot,
  DropdownMenuRadioItem as DropdownMenuRadioItemRoot,
  DropdownMenuRoot,
  DropdownMenuSeparator as DropdownMenuSeparatorRoot,
  DropdownMenuTrigger as DropdownMenuTriggerRoot,
  type DropdownMenuContentProps,
  type DropdownMenuItemProps,
  type DropdownMenuRadioGroupProps,
  type DropdownMenuRadioItemProps,
  type DropdownMenuRootProps,
} from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const DropdownMenu = defineComponent((_props: DropdownMenuRootProps & { 'onUpdate:open'?: (open: boolean) => void }, { slots }) => () => <DropdownMenuRoot>{slots.default?.()}</DropdownMenuRoot>, { name: 'DropdownMenu', props: [] });

export const DropdownMenuTrigger = defineComponent((_props: { asChild?: boolean }, { slots }) => () => <DropdownMenuTriggerRoot data-slot="dropdown-menu-trigger">{slots.default?.()}</DropdownMenuTriggerRoot>, { name: 'DropdownMenuTrigger', props: [] });

export const DropdownMenuContent = defineComponent(
  (props: ElementProps & DropdownMenuContentProps, { slots, attrs }) =>
    () => (
      <DropdownMenuPortal>
        <DropdownMenuContentRoot
          data-slot="dropdown-menu-content"
          sideOffset={props.sideOffset ?? 4}
          {...attrs}
          class={cn(
            'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--reka-dropdown-menu-content-available-height) min-w-[8rem] origin-(--reka-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md',
            props.class,
          )}
        >
          {slots.default?.()}
        </DropdownMenuContentRoot>
      </DropdownMenuPortal>
    ),
  { name: 'DropdownMenuContent', props: ['class', 'sideOffset'], inheritAttrs: false },
);

export const DropdownMenuGroup = defineComponent((_props: ElementProps, { slots }) => () => <DropdownMenuGroupRoot data-slot="dropdown-menu-group">{slots.default?.()}</DropdownMenuGroupRoot>, { name: 'DropdownMenuGroup', props: [] });

export const DropdownMenuLabel = defineComponent(
  (props: ElementProps & { inset?: boolean }, { slots }) =>
    () => (
      <DropdownMenuLabelRoot data-slot="dropdown-menu-label" data-inset={props.inset ? '' : undefined} class={cn('px-2 py-1.5 text-sm font-medium data-[inset]:pl-8', props.class)}>
        {slots.default?.()}
      </DropdownMenuLabelRoot>
    ),
  { name: 'DropdownMenuLabel', props: ['class', 'inset'] },
);

export type DropdownMenuItemAllProps = ElementProps & DropdownMenuItemProps & { inset?: boolean; variant?: 'default' | 'destructive'; onSelect?: (event: Event) => void };

export const DropdownMenuItem = defineComponent(
  (props: DropdownMenuItemAllProps, { slots }) =>
    () => (
      <DropdownMenuItemRoot
        data-slot="dropdown-menu-item"
        data-inset={props.inset ? '' : undefined}
        data-variant={props.variant ?? 'default'}
        class={cn(
          "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:*:[svg]:text-destructive!",
          props.class,
        )}
      >
        {slots.default?.()}
      </DropdownMenuItemRoot>
    ),
  { name: 'DropdownMenuItem', props: ['class', 'inset', 'variant'] },
);

export const DropdownMenuSeparator = defineComponent((props: ElementProps) => () => <DropdownMenuSeparatorRoot data-slot="dropdown-menu-separator" class={cn('bg-border -mx-1 my-1 h-px', props.class)} />, { name: 'DropdownMenuSeparator', props: ['class'] });

export const DropdownMenuRadioGroup = defineComponent(
  (_props: DropdownMenuRadioGroupProps & { 'onUpdate:modelValue'?: (value: string) => void }, { slots }) =>
    () => <DropdownMenuRadioGroupRoot data-slot="dropdown-menu-radio-group">{slots.default?.()}</DropdownMenuRadioGroupRoot>,
  { name: 'DropdownMenuRadioGroup', props: [] },
);

export const DropdownMenuRadioItem = defineComponent(
  (props: ElementProps & DropdownMenuRadioItemProps & { onSelect?: (event: Event) => void }, { slots }) =>
    () => (
      <DropdownMenuRadioItemRoot
        data-slot="dropdown-menu-radio-item"
        value={props.value}
        class={cn(
          "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          props.class,
        )}
      >
        <span class="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
          <DropdownMenuItemIndicator>
            <Circle class="size-2 fill-current" />
          </DropdownMenuItemIndicator>
        </span>
        {slots.default?.()}
      </DropdownMenuRadioItemRoot>
    ),
  { name: 'DropdownMenuRadioItem', props: ['class', 'value'] },
);
