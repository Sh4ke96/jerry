// Card, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
import { slotted } from '../../../lib/component';

export const Card = slotted('Card', 'div', 'card', 'bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm');

export const CardHeader = slotted('CardHeader', 'div', 'card-header', '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6');

export const CardTitle = slotted('CardTitle', 'h3', 'card-title', 'leading-none font-semibold');

export const CardDescription = slotted('CardDescription', 'p', 'card-description', 'text-muted-foreground text-sm');

export const CardAction = slotted('CardAction', 'div', 'card-action', 'col-start-2 row-span-2 row-start-1 self-start justify-self-end');

export const CardContent = slotted('CardContent', 'div', 'card-content', 'px-6');

export const CardFooter = slotted('CardFooter', 'div', 'card-footer', 'flex items-center px-6 [.border-t]:pt-6');
