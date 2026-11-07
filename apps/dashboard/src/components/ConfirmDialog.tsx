import { computed, defineComponent, nextTick, ref, type ComponentPublicInstance, type PropType } from 'vue';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

/**
 * A decision is a deliberate gesture: the confirm button stays disabled until the user types the
 * expected text (the task ID, or "exclude"), exactly like the CLI prompt.
 */
export const ConfirmDialog = defineComponent({
  name: 'ConfirmDialog',
  props: {
    title: { type: String, required: true },
    expected: { type: String, required: true },
    confirmLabel: { type: String, required: true },
    tone: { type: String as PropType<'primary' | 'danger'>, default: 'primary' },
    busy: { type: Boolean, default: false },
    /** Shows a comment field with this label (e.g. what Claude should change). */
    commentLabel: { type: String, default: undefined },
    /** The comment must not be empty (e.g. the reason for dismissing a finding). */
    commentRequired: { type: Boolean, default: false },
  },
  emits: {
    confirm: (typed: string, _comment: string) => typeof typed === 'string',
    cancel: () => true,
  },
  setup(props, { emit, slots }) {
    const typed = ref('');
    const comment = ref('');
    const input = ref<ComponentPublicInstance | null>(null);
    const matches = computed(() => typed.value.trim() === props.expected && (!props.commentRequired || comment.value.trim() !== ''));

    const submit = (event: Event): void => {
      event.preventDefault();
      if (matches.value && !props.busy) emit('confirm', typed.value.trim(), comment.value.trim());
    };

    // The dialog opens on the field to type into. reka-ui's alert dialog moves the focus to its
    // Cancel button on the next tick, so the field takes it one tick later.
    const focusInput = (event: Event): void => {
      event.preventDefault();
      void nextTick(() => nextTick(() => (input.value?.$el as HTMLInputElement | undefined)?.focus()));
    };

    return () => (
      <AlertDialog open={true} onUpdate:open={(open: boolean) => !open && emit('cancel')}>
        <AlertDialogContent onOpenAutoFocus={focusInput}>
          <form class="dialog grid gap-4" onSubmit={submit}>
            <AlertDialogHeader>
              <AlertDialogTitle>{props.title}</AlertDialogTitle>
              <AlertDialogDescription as="div" class="grid gap-2">
                {slots.default?.()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {props.commentLabel !== undefined && (
              <div class="grid gap-2">
                <Label for="confirm-comment">{props.commentLabel}</Label>
                <Textarea id="confirm-comment" modelValue={comment.value} onUpdate:modelValue={(value: string) => (comment.value = value)} rows={3} maxlength={2000} required={props.commentRequired} />
              </div>
            )}
            <div class="grid gap-2">
              <Label for="confirm-typed">
                Type <code class="bg-muted rounded px-1 py-0.5 text-xs">{props.expected}</code> to confirm
              </Label>
              <Input ref={input} id="confirm-typed" class="font-mono" modelValue={typed.value} onUpdate:modelValue={(value: string) => (typed.value = value)} autocomplete="off" spellcheck={false} />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" variant={props.tone === 'danger' ? 'destructive' : 'default'} disabled={!matches.value || props.busy}>
                {props.busy ? 'Working…' : props.confirmLabel}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    );
  },
});
