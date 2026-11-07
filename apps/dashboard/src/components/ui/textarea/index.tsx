// Textarea, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { defineComponent, type TextareaHTMLAttributes } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export type TextareaProps = ElementProps<Omit<TextareaHTMLAttributes, 'value'>> & { modelValue?: string };

export const Textarea = defineComponent(
  (props: TextareaProps, { emit }) =>
    () => (
      <textarea
        data-slot="textarea"
        {...(props.modelValue === undefined ? {} : { value: props.modelValue })}
        onInput={(event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value)}
        class={cn(
          'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          props.class,
        )}
      />
    ),
  { name: 'Textarea', props: ['modelValue', 'class'], emits: ['update:modelValue'] },
);
