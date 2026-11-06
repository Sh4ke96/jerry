import { defineComponent, type PropType } from 'vue';

export type Tone = 'pass' | 'warn' | 'deny' | 'neutral' | 'accent';

const VERDICT_TONE: Record<string, Tone> = { PASS: 'pass', WARN: 'warn', DENY: 'deny' };

export function toneOf(verdict: string | null): Tone {
  return verdict === null ? 'neutral' : (VERDICT_TONE[verdict] ?? 'neutral');
}

export const Badge = defineComponent({
  name: 'Badge',
  props: {
    tone: { type: String as PropType<Tone>, default: 'neutral' },
    title: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () => (
      <span class={['badge', `badge--${props.tone}`]} title={props.title}>
        {slots.default?.()}
      </span>
    );
  },
});
