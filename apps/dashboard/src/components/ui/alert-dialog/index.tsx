// AlertDialog, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import {
  AlertDialogAction as AlertDialogActionRoot,
  AlertDialogCancel as AlertDialogCancelRoot,
  AlertDialogContent as AlertDialogContentRoot,
  AlertDialogDescription as AlertDialogDescriptionRoot,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle as AlertDialogTitleRoot,
  AlertDialogTrigger as AlertDialogTriggerRoot,
  type AlertDialogContentProps,
  type AlertDialogProps,
} from 'reka-ui';
import { defineComponent, type ButtonHTMLAttributes } from 'vue';
import { slotted, type ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';
import { buttonVariants } from '../button';

export const AlertDialog = defineComponent((_props: AlertDialogProps & { 'onUpdate:open'?: (open: boolean) => void }, { slots }) => () => <AlertDialogRoot>{slots.default?.()}</AlertDialogRoot>, { name: 'AlertDialog', props: [] });

export const AlertDialogTrigger = defineComponent((_props: { asChild?: boolean }, { slots }) => () => <AlertDialogTriggerRoot data-slot="alert-dialog-trigger">{slots.default?.()}</AlertDialogTriggerRoot>, { name: 'AlertDialogTrigger', props: [] });

export type AlertDialogContentAllProps = ElementProps &
  AlertDialogContentProps & {
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
  };

export const AlertDialogContent = defineComponent(
  (props: AlertDialogContentAllProps, { slots, attrs }) =>
    () => (
      <AlertDialogPortal>
        <AlertDialogOverlay data-slot="alert-dialog-overlay" class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/80" />
        <AlertDialogContentRoot
          data-slot="alert-dialog-content"
          {...attrs}
          class={cn(
            'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg',
            props.class,
          )}
        >
          {slots.default?.()}
        </AlertDialogContentRoot>
      </AlertDialogPortal>
    ),
  { name: 'AlertDialogContent', props: ['class'], inheritAttrs: false },
);

export const AlertDialogHeader = slotted('AlertDialogHeader', 'div', 'alert-dialog-header', 'flex flex-col gap-2 text-center sm:text-left');

export const AlertDialogFooter = slotted('AlertDialogFooter', 'div', 'alert-dialog-footer', 'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end');

export const AlertDialogTitle = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <AlertDialogTitleRoot data-slot="alert-dialog-title" class={cn('text-lg font-semibold', props.class)}>
        {slots.default?.()}
      </AlertDialogTitleRoot>
    ),
  { name: 'AlertDialogTitle', props: ['class'] },
);

export const AlertDialogDescription = defineComponent(
  (props: ElementProps & { asChild?: boolean; as?: string }, { slots }) =>
    () => (
      <AlertDialogDescriptionRoot data-slot="alert-dialog-description" class={cn('text-muted-foreground text-sm', props.class)}>
        {slots.default?.()}
      </AlertDialogDescriptionRoot>
    ),
  { name: 'AlertDialogDescription', props: ['class'] },
);

export const AlertDialogAction = defineComponent(
  (props: ElementProps<ButtonHTMLAttributes>, { slots }) =>
    () => <AlertDialogActionRoot class={cn(buttonVariants(), props.class)}>{slots.default?.()}</AlertDialogActionRoot>,
  { name: 'AlertDialogAction', props: ['class'] },
);

export const AlertDialogCancel = defineComponent(
  (props: ElementProps<ButtonHTMLAttributes>, { slots }) =>
    () => <AlertDialogCancelRoot class={cn(buttonVariants({ variant: 'outline' }), 'mt-2 sm:mt-0', props.class)}>{slots.default?.()}</AlertDialogCancelRoot>,
  { name: 'AlertDialogCancel', props: ['class'] },
);
