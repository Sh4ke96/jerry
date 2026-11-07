// Input, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { defineComponent, type InputHTMLAttributes } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export type InputProps = ElementProps<Omit<InputHTMLAttributes, 'value'>> & { modelValue?: string };

export const Input = defineComponent(
  (props: InputProps, { emit }) =>
    () => (
      <input
        data-slot="input"
        {...(props.modelValue === undefined ? {} : { value: props.modelValue })}
        onInput={(event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)}
        class={cn(
          'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3',
          'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
          props.class,
        )}
      />
    ),
  { name: 'Input', props: ['modelValue', 'class'], emits: ['update:modelValue'] },
);
