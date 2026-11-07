import { computed, defineComponent, nextTick, ref, type ComponentPublicInstance, type PropType } from 'vue';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

/**
 * A decision is a deliberate gesture. In typed mode (the default, and always for irreversible
 * actions) the confirm button stays disabled until the user types the expected text (the task ID,
 * "delete", a repository root), exactly like the CLI prompt. In click mode (reversible decisions,
 * when the user chose one-click decisions in Settings) the dialog shows the same details and the
 * decision button is ready at once: it takes the focus, Enter confirms and Escape cancels; the
 * expected text is still emitted, so Core receives the task ID. The `controls` slot holds choices
 * that belong to the decision; they never replace the confirmation.
 */
export const ConfirmDialog = defineComponent({
  name: 'ConfirmDialog',
  props: {
    title: { type: String, required: true },
    expected: { type: String, required: true },
    confirmLabel: { type: String, required: true },
    tone: { type: String as PropType<'primary' | 'danger'>, default: 'primary' },
    busy: { type: Boolean, default: false },
    /** click: no typing, the decision button is enabled at once; typed: the expected text must be typed. */
    mode: { type: String as PropType<'click' | 'typed'>, default: 'typed' },
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
    const confirmButton = ref<ComponentPublicInstance | null>(null);
    const commentField = ref<ComponentPublicInstance | null>(null);
    const typing = computed(() => props.mode !== 'click');
    const ready = computed(() => (!typing.value || typed.value.trim() === props.expected) && (!props.commentRequired || comment.value.trim() !== ''));

    const submit = (event: Event): void => {
      event.preventDefault();
      if (ready.value && !props.busy) emit('confirm', typing.value ? typed.value.trim() : props.expected, comment.value.trim());
    };

    // The dialog opens on what the user acts on first: the field to type into, the required comment
    // (click mode), or the decision button. reka-ui's alert dialog moves the focus to its Cancel
    // button on the next tick, so the target takes it one tick later.
    const focusFirst = (event: Event): void => {
      event.preventDefault();
      void nextTick(() =>
        nextTick(() => {
          const target = typing.value ? input.value : props.commentRequired ? commentField.value : confirmButton.value;
          (target?.$el as HTMLElement | undefined)?.focus();
        }),
      );
    };

    return () => (
      <AlertDialog open={true} onUpdate:open={(open: boolean) => !open && emit('cancel')}>
        <AlertDialogContent onOpenAutoFocus={focusFirst} data-confirm-mode={typing.value ? 'typed' : 'click'}>
          <form class="dialog grid gap-4" onSubmit={submit}>
            <AlertDialogHeader>
              <AlertDialogTitle>{props.title}</AlertDialogTitle>
              <AlertDialogDescription as="div" class="grid gap-2">
                {slots.default?.()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {/* Choices that belong to the decision (e.g. sending the task to independent review). */}
            {slots.controls?.()}
            {props.commentLabel !== undefined && (
              <div class="grid gap-2">
                <Label for="confirm-comment">{props.commentLabel}</Label>
                <Textarea
                  ref={commentField}
                  id="confirm-comment"
                  modelValue={comment.value}
                  onUpdate:modelValue={(value: string) => (comment.value = value)}
                  rows={3}
                  maxlength={2000}
                  required={props.commentRequired}
                />
              </div>
            )}
            {typing.value && (
              <div class="grid gap-2">
                <Label for="confirm-typed">
                  Type <code class="bg-muted rounded px-1 py-0.5 text-xs">{props.expected}</code> to confirm
                </Label>
                <Input ref={input} id="confirm-typed" class="font-mono" modelValue={typed.value} onUpdate:modelValue={(value: string) => (typed.value = value)} autocomplete="off" spellcheck={false} />
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button ref={confirmButton} type="submit" variant={props.tone === 'danger' ? 'destructive' : 'default'} disabled={!ready.value || props.busy}>
                {props.busy ? 'Working…' : props.confirmLabel}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    );
  },
});
