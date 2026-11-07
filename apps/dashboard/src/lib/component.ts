import { defineComponent, h, type HTMLAttributes } from 'vue';
import { cn, type ClassValue } from './utils';

/** Props of a ui component that renders one element: its HTML attributes, with a mergeable class. */
export type ElementProps<A = HTMLAttributes> = Omit<A, 'class'> & { class?: ClassValue };

/**
 * A ui part that is one element with fixed classes and a `data-slot` name, like most shadcn-vue
 * parts (CardHeader, TableRow, SidebarMenu…). Other attributes and listeners fall through to it.
 */
export function slotted<A = HTMLAttributes>(name: string, tag: string, slot: string, classes: string, extra: Record<string, string> = {}) {
  return defineComponent((props: ElementProps<A>, { slots }) => () => h(tag, { 'data-slot': slot, ...extra, class: cn(classes, props.class) }, slots.default?.()), { name, props: ['class'] });
}
