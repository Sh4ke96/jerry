// Dialog, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { X } from '@lucide/vue';
import {
  DialogClose as DialogCloseRoot,
  DialogContent as DialogContentRoot,
  DialogDescription as DialogDescriptionRoot,
  DialogOverlay as DialogOverlayRoot,
  DialogPortal,
  DialogRoot,
  DialogTitle as DialogTitleRoot,
  DialogTrigger as DialogTriggerRoot,
  type DialogContentProps,
  type DialogRootProps,
} from 'reka-ui';
import { defineComponent } from 'vue';
import { slotted, type ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const Dialog = defineComponent((_props: DialogRootProps & { 'onUpdate:open'?: (open: boolean) => void }, { slots }) => () => <DialogRoot>{slots.default?.()}</DialogRoot>, { name: 'Dialog', props: [] });

export const DialogTrigger = defineComponent((_props: { asChild?: boolean }, { slots }) => () => <DialogTriggerRoot data-slot="dialog-trigger">{slots.default?.()}</DialogTriggerRoot>, { name: 'DialogTrigger', props: [] });

export const DialogClose = defineComponent((_props: { asChild?: boolean }, { slots }) => () => <DialogCloseRoot data-slot="dialog-close">{slots.default?.()}</DialogCloseRoot>, { name: 'DialogClose', props: [] });

export const DialogOverlay = defineComponent(
  (props: ElementProps) => () => <DialogOverlayRoot data-slot="dialog-overlay" class={cn('data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/80', props.class)} />,
  { name: 'DialogOverlay', props: ['class'] },
);

export type DialogContentAllProps = ElementProps &
  DialogContentProps & {
    showCloseButton?: boolean;
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
  };

export const DialogContent = defineComponent(
  (props: DialogContentAllProps, { slots, attrs }) =>
    () => (
      <DialogPortal>
        <DialogOverlay />
        <DialogContentRoot
          data-slot="dialog-content"
          {...attrs}
          class={cn(
            'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg',
            props.class,
          )}
        >
          {slots.default?.()}
          {props.showCloseButton !== false && (
            <DialogCloseRoot
              data-slot="dialog-close"
              class="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <X />
              <span class="sr-only">Close</span>
            </DialogCloseRoot>
          )}
        </DialogContentRoot>
      </DialogPortal>
    ),
  { name: 'DialogContent', props: ['class', 'showCloseButton'], inheritAttrs: false },
);

export const DialogHeader = slotted('DialogHeader', 'div', 'dialog-header', 'flex flex-col gap-2 text-center sm:text-left');

export const DialogFooter = slotted('DialogFooter', 'div', 'dialog-footer', 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end');

export const DialogTitle = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <DialogTitleRoot data-slot="dialog-title" class={cn('text-lg leading-none font-semibold', props.class)}>
        {slots.default?.()}
      </DialogTitleRoot>
    ),
  { name: 'DialogTitle', props: ['class'] },
);

export const DialogDescription = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <DialogDescriptionRoot data-slot="dialog-description" class={cn('text-muted-foreground text-sm', props.class)}>
        {slots.default?.()}
      </DialogDescriptionRoot>
    ),
  { name: 'DialogDescription', props: ['class'] },
);
