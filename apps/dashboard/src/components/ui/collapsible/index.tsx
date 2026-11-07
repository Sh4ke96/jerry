// Collapsible, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { CollapsibleContent as CollapsibleContentRoot, CollapsibleRoot, CollapsibleTrigger as CollapsibleTriggerRoot, type CollapsibleRootProps } from 'reka-ui';
import { defineComponent } from 'vue';
import type { ElementProps } from '../../../lib/component';

export const Collapsible = defineComponent(
  (_props: ElementProps & CollapsibleRootProps & { 'onUpdate:open'?: (open: boolean) => void }, { slots }) => () => <CollapsibleRoot data-slot="collapsible">{slots.default?.()}</CollapsibleRoot>,
  { name: 'Collapsible', props: [] },
);

export const CollapsibleTrigger = defineComponent(
  (_props: ElementProps & { asChild?: boolean }, { slots }) => () => <CollapsibleTriggerRoot data-slot="collapsible-trigger">{slots.default?.()}</CollapsibleTriggerRoot>,
  { name: 'CollapsibleTrigger', props: [] },
);

export const CollapsibleContent = defineComponent(
  (_props: ElementProps, { slots }) => () => <CollapsibleContentRoot data-slot="collapsible-content">{slots.default?.()}</CollapsibleContentRoot>,
  { name: 'CollapsibleContent', props: [] },
);
