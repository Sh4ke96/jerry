import { RESULT_EMOJI } from '@jerry/contracts/emoji';
import { defineComponent } from 'vue';
import { classProp, cn } from '../lib/utils';

/**
 * An emoji from JERRY's shared vocabulary, always next to the text label that carries the same
 * meaning. Hidden from assistive technology, so the meaning never depends on the emoji alone. The
 * dashboard always shows emoji; JERRY_NO_EMOJI only concerns terminals.
 */
export const Emoji = defineComponent({
  name: 'Emoji',
  props: { symbol: { type: String, required: true }, class: classProp },
  setup(props) {
    return () => (
      <span class={cn('emoji mr-1.5 inline-block font-normal not-italic leading-none tracking-normal normal-case', props.class)} aria-hidden="true">
        {props.symbol}
      </span>
    );
  },
});

/** The emoji of a check or gate result (PASS, WARN, DENY, FAIL, NOT_RUN); none for other values. */
export function resultEmoji(result: string | null | undefined): string | undefined {
  return result == null ? undefined : (RESULT_EMOJI as Record<string, string>)[result];
}
