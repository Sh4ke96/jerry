// Switch, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { SwitchRoot, SwitchThumb, type SwitchRootProps } from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export type SwitchProps = ElementProps & SwitchRootProps & { 'onUpdate:modelValue'?: (value: boolean) => void };

export const Switch = defineComponent(
  (props: SwitchProps) => () => (
    <SwitchRoot
      data-slot="switch"
      class={cn(
        'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 dark:data-[state=unchecked]:bg-input/80 inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )}
    >
      <SwitchThumb
        data-slot="switch-thumb"
        class="bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground pointer-events-none block size-4 rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0"
      />
    </SwitchRoot>
  ),
  { name: 'Switch', props: ['class'] },
);
