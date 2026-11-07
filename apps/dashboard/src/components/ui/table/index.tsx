// Table, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { defineComponent, type TdHTMLAttributes, type ThHTMLAttributes } from 'vue';
import { slotted, type ElementProps } from '../../../lib/component';
import { cn } from '../../../lib/utils';

export const Table = defineComponent(
  (props: ElementProps, { slots }) =>
    () => (
      <div data-slot="table-container" class="relative w-full overflow-auto">
        <table data-slot="table" class={cn('w-full caption-bottom text-sm', props.class)}>
          {slots.default?.()}
        </table>
      </div>
    ),
  { name: 'Table', props: ['class'] },
);

export const TableHeader = slotted('TableHeader', 'thead', 'table-header', '[&_tr]:border-b');

export const TableBody = slotted('TableBody', 'tbody', 'table-body', '[&_tr:last-child]:border-0');

export const TableFooter = slotted('TableFooter', 'tfoot', 'table-footer', 'bg-muted/50 border-t font-medium [&>tr]:last:border-b-0');

export const TableRow = slotted('TableRow', 'tr', 'table-row', 'hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors');

export const TableHead = slotted<ThHTMLAttributes>('TableHead', 'th', 'table-head', 'text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 *:[[role=checkbox]]:translate-y-0.5');

export const TableCell = slotted<TdHTMLAttributes>('TableCell', 'td', 'table-cell', 'p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 *:[[role=checkbox]]:translate-y-0.5');

export const TableCaption = slotted('TableCaption', 'caption', 'table-caption', 'text-muted-foreground mt-4 text-sm');

/** A row spanning the table, for "nothing to show". */
export const TableEmpty = defineComponent(
  (props: ElementProps & { colspan?: number }, { slots }) =>
    () => (
      <TableRow>
        <TableCell class={cn('p-4 whitespace-nowrap align-middle text-sm text-foreground', props.class)} colspan={props.colspan ?? 1}>
          <div class="flex items-center justify-center py-10">{slots.default?.()}</div>
        </TableCell>
      </TableRow>
    ),
  { name: 'TableEmpty', props: ['class', 'colspan'] },
);
