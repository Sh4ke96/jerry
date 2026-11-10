import { defineComponent, type PropType } from 'vue';
import { classProp, cn } from '../lib/utils';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

export interface FilterTab {
  value: string;
  label: string;
  count: number;
}

/**
 * A row of filter tabs (shadcn tabs) where each tab is clearly a button: a hover state, a pointer
 * cursor, and its count as a separate badge that takes the primary colour on the active tab.
 * `marker` names the data attribute each tab carries with its value (e.g. data-filter="active").
 */
export const FilterTabs = defineComponent({
  name: 'FilterTabs',
  props: {
    modelValue: { type: String, required: true },
    tabs: { type: Array as PropType<FilterTab[]>, required: true },
    label: { type: String, required: true },
    marker: { type: String, required: true },
    class: classProp,
  },
  emits: { 'update:modelValue': (value: string) => typeof value === 'string' },
  setup(props, { emit }) {
    return () => (
      <Tabs modelValue={props.modelValue} onUpdate:modelValue={(value: string) => emit('update:modelValue', value)}>
        <TabsList aria-label={props.label} class={cn('filter-tabs h-10 max-w-full justify-start gap-1 overflow-x-auto', props.class)}>
          {props.tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              {...{ [`data-${props.marker}`]: tab.value }}
              class="group hover:bg-background/60 hover:text-foreground data-[state=active]:hover:bg-background flex-none cursor-pointer gap-2 px-3"
            >
              <span>{tab.label}</span>
              <span
                data-count={tab.count}
                class="bg-background text-muted-foreground group-data-[state=active]:bg-primary group-data-[state=active]:text-primary-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums transition-colors"
              >
                {tab.count}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    );
  },
});
