// Tabs, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { TabsContent as TabsContentRoot, TabsList as TabsListRoot, TabsRoot, TabsTrigger as TabsTriggerRoot, type TabsContentProps, type TabsRootProps, type TabsTriggerProps } from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export type TabsProps = ElementProps & TabsRootProps<string> & { 'onUpdate:modelValue'?: (value: string) => void };

export const Tabs = defineComponent(
  (props: TabsProps, { slots }) =>
    () => (
      <TabsRoot data-slot="tabs" class={cn('flex flex-col gap-2', props.class)}>
        {slots.default?.()}
      </TabsRoot>
    ),
  { name: 'Tabs', props: ['class'] },
);

export const TabsList = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <TabsListRoot data-slot="tabs-list" class={cn('bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-0.75', props.class)}>
        {slots.default?.()}
      </TabsListRoot>
    ),
  { name: 'TabsList', props: ['class'] },
);

export const TabsTrigger = defineComponent(
  (props: ElementProps & TabsTriggerProps, { slots }) =>
    () => (
      <TabsTriggerRoot
        data-slot="tabs-trigger"
        value={props.value}
        class={cn(
          "data-[state=active]:bg-background dark:data-[state=active]:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:data-[state=active]:border-input dark:data-[state=active]:bg-input/30 text-foreground dark:text-muted-foreground inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-3 focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          props.class,
        )}
      >
        {slots.default?.()}
      </TabsTriggerRoot>
    ),
  { name: 'TabsTrigger', props: ['value', 'class'] },
);

export const TabsContent = defineComponent(
  (props: ElementProps & TabsContentProps, { slots }) =>
    () => (
      <TabsContentRoot data-slot="tabs-content" value={props.value} class={cn('flex-1 outline-none', props.class)}>
        {slots.default?.()}
      </TabsContentRoot>
    ),
  { name: 'TabsContent', props: ['value', 'class'] },
);
