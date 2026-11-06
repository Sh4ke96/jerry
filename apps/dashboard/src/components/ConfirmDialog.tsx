import { computed, defineComponent, nextTick, onMounted, ref, type PropType } from 'vue';

/**
 * A decision is a deliberate gesture: the confirm button stays disabled until the user types the
 * expected text (the task ID, or "exclude"), exactly like the CLI prompt (ADR 0007).
 */
export const ConfirmDialog = defineComponent({
  name: 'ConfirmDialog',
  props: {
    title: { type: String, required: true },
    expected: { type: String, required: true },
    confirmLabel: { type: String, required: true },
    tone: { type: String as PropType<'primary' | 'danger'>, default: 'primary' },
    busy: { type: Boolean, default: false },
  },
  emits: {
    confirm: (typed: string) => typeof typed === 'string',
    cancel: () => true,
  },
  setup(props, { emit, slots }) {
    const typed = ref('');
    const input = ref<HTMLInputElement | null>(null);
    const matches = computed(() => typed.value.trim() === props.expected);
    onMounted(() => nextTick(() => input.value?.focus()));

    const submit = (event: Event): void => {
      event.preventDefault();
      if (matches.value && !props.busy) emit('confirm', typed.value.trim());
    };

    return () => (
      <div class="overlay" role="presentation" onClick={(event: MouseEvent) => event.target === event.currentTarget && emit('cancel')}>
        <form class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onSubmit={submit} onKeydown={(event: KeyboardEvent) => event.key === 'Escape' && emit('cancel')}>
          <h2 id="dialog-title">{props.title}</h2>
          <div class="dialog__body">{slots.default?.()}</div>
          <label class="field">
            <span>
              Type <code>{props.expected}</code> to confirm
            </span>
            <input ref={input} value={typed.value} onInput={(event: Event) => (typed.value = (event.target as HTMLInputElement).value)} autocomplete="off" spellcheck={false} />
          </label>
          <div class="dialog__actions">
            <button type="button" class="button" onClick={() => emit('cancel')}>
              Cancel
            </button>
            <button type="submit" class={['button', props.tone === 'danger' ? 'button--danger' : 'button--primary']} disabled={!matches.value || props.busy}>
              {props.busy ? 'Working…' : props.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    );
  },
});
