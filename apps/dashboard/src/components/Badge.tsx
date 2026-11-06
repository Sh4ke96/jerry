import { defineComponent, type PropType } from 'vue';
import { Emoji } from './Emoji';

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
    /** Shown before the label, hidden from assistive technology: the label says the same. */
    emoji: { type: String, default: undefined },
  },
  setup(props, { slots }) {
    return () => (
      <span class={['badge', `badge--${props.tone}`]} title={props.title}>
        {props.emoji !== undefined && props.emoji !== '' && <Emoji symbol={props.emoji} />}
        {slots.default?.()}
      </span>
    );
  },
});
