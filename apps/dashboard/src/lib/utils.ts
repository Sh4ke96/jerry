// The `cn` helper of shadcn-vue 2.9.0 (https://github.com/unovue/shadcn-vue, MIT License,
// Copyright (c) 2023 unovue): joins class names and lets later Tailwind classes win.
import { clsx, type ClassValue } from 'clsx';
import type { PropType } from 'vue';
import { twMerge } from 'tailwind-merge';

export type { ClassValue };

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** The `class` prop every ui component accepts and merges with its own classes. */
export const classProp = { type: [String, Array, Object] as PropType<ClassValue>, default: undefined };
