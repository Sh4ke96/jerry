// Button, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { cva, type VariantProps } from 'class-variance-authority';
import { Primitive } from 'reka-ui';
import { defineComponent, type ButtonHTMLAttributes } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

export type ButtonProps = ElementProps<ButtonHTMLAttributes> & {
  variant?: ButtonVariants['variant'];
  size?: ButtonVariants['size'];
  /** The element to render (default `button`). */
  as?: string;
  /** Renders the only child with the button's attributes instead of an own element. */
  asChild?: boolean;
};

export const Button = defineComponent(
  (props: ButtonProps, { slots }) =>
    () => (
      <Primitive data-slot="button" data-variant={props.variant} data-size={props.size} as={props.as ?? 'button'} asChild={props.asChild} class={cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)}>
        {slots.default?.()}
      </Primitive>
    ),
  { name: 'Button', props: ['variant', 'size', 'as', 'asChild', 'class'] },
);
