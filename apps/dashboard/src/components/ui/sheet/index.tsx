// Sheet, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
// The sidebar shows itself in a sheet on narrow windows.
import { X } from '@lucide/vue';
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, type DialogContentProps, type DialogRootProps } from 'reka-ui';
import { defineComponent } from 'vue';
import { slotted, type ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const Sheet = defineComponent((_props: DialogRootProps & { 'onUpdate:open'?: (open: boolean) => void }, { slots }) => () => <DialogRoot>{slots.default?.()}</DialogRoot>, { name: 'Sheet', props: [] });

export type SheetContentProps = ElementProps & DialogContentProps & { side?: 'top' | 'right' | 'bottom' | 'left' };

const SIDE: Record<NonNullable<SheetContentProps['side']>, string> = {
  right: 'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm',
  left: 'data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm',
  top: 'data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top inset-x-0 top-0 h-auto border-b',
  bottom: 'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 h-auto border-t',
};

export const SheetContent = defineComponent(
  (props: SheetContentProps, { slots, attrs }) =>
    () => (
      <DialogPortal>
        <DialogOverlay data-slot="sheet-overlay" class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/80" />
        <DialogContent
          data-slot="sheet-content"
          {...attrs}
          class={cn('bg-background data-[state=open]:animate-in data-[state=closed]:animate-out fixed z-50 flex flex-col gap-4 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500', SIDE[props.side ?? 'right'], props.class)}
        >
          {slots.default?.()}
          <DialogClose class="ring-offset-background focus:ring-ring data-[state=open]:bg-secondary absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none">
            <X class="size-4" />
            <span class="sr-only">Close</span>
          </DialogClose>
        </DialogContent>
      </DialogPortal>
    ),
  { name: 'SheetContent', props: ['class', 'side'], inheritAttrs: false },
);

export const SheetHeader = slotted('SheetHeader', 'div', 'sheet-header', 'flex flex-col gap-1.5 p-4');

export const SheetTitle = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <DialogTitle data-slot="sheet-title" class={cn('text-foreground font-semibold', props.class)}>
        {slots.default?.()}
      </DialogTitle>
    ),
  { name: 'SheetTitle', props: ['class'] },
);

export const SheetDescription = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <DialogDescription data-slot="sheet-description" class={cn('text-muted-foreground text-sm', props.class)}>
        {slots.default?.()}
      </DialogDescription>
    ),
  { name: 'SheetDescription', props: ['class'] },
);
