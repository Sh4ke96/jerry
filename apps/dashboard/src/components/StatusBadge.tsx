import { defineComponent, type PropType } from 'vue';
import { classProp } from '../lib/utils';
import { Badge, type BadgeVariants } from './ui/badge';
import { Emoji } from './Emoji';

/** What a state, verdict or severity means for the user; each tone has one badge variant. */
export type Tone = 'pass' | 'warn' | 'deny' | 'neutral' | 'accent';

const VARIANT: Record<Tone, NonNullable<BadgeVariants['variant']>> = {
  // Waiting for the user, or a deviation: the strongest neutral emphasis.
  warn: 'default',
  deny: 'destructive',
  pass: 'secondary',
  accent: 'outline',
  neutral: 'outline',
};

const VERDICT_TONE: Record<string, Tone> = { PASS: 'pass', WARN: 'warn', DENY: 'deny' };

export function toneOf(verdict: string | null): Tone {
  return verdict === null ? 'neutral' : (VERDICT_TONE[verdict] ?? 'neutral');
}

/** A badge for a state, verdict, severity or count, with its emoji before the label. */
export const StatusBadge = defineComponent({
  name: 'StatusBadge',
  props: {
    tone: { type: String as PropType<Tone>, default: 'neutral' },
    title: { type: String, default: undefined },
    /** Shown before the label, hidden from assistive technology: the label says the same. */
    emoji: { type: String, default: undefined },
    class: classProp,
  },
  setup(props, { slots }) {
    return () => (
      <Badge variant={VARIANT[props.tone]} title={props.title} data-tone={props.tone} class={props.class}>
        {props.emoji !== undefined && props.emoji !== '' && <Emoji symbol={props.emoji} class="mr-0" />}
        {slots.default?.()}
      </Badge>
    );
  },
});
