import type { ForgetPreview, ForgetResult } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { ref } from 'vue';
import { api } from '../api';
import { formatBytes } from '../format';
import { handleError, refresh, state } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/**
 * Forgetting a repository: everything JERRY stores about it is previewed first, deleted only after
 * its root is typed, and Core takes a backup right before. Used by the Data view and the project page.
 */
export function useForget(afterForget: () => Promise<unknown> | void = () => undefined) {
  const forgetting = ref<ForgetPreview | null>(null);
  const forgotten = ref<ForgetResult | null>(null);
  const busy = ref(false);

  const askForget = async (repoRoot: string): Promise<void> => {
    try {
      forgetting.value = await api.previewForget(repoRoot);
    } catch (error) {
      handleError(error);
    }
  };

  const forget = async (typed: string): Promise<void> => {
    const plan = forgetting.value;
    if (plan === null) return;
    busy.value = true;
    try {
      forgotten.value = await api.forget(plan.repoRoot, typed);
      state.notice = `JERRY forgot ${plan.repoRoot}: ${forgotten.value.totalRows} row(s) deleted.`;
      forgetting.value = null;
      await Promise.all([afterForget(), refresh()]);
    } catch (error) {
      handleError(error);
    } finally {
      busy.value = false;
    }
  };

  const forgetButton = (repoRoot: string, openTasks: number) => {
    if (openTasks === 0) {
      return (
        <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" onClick={() => void askForget(repoRoot)}>
          Forget
        </Button>
      );
    }
    // A disabled button gets no pointer events: the tooltip hangs on a focusable wrapper.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabindex={0} class="inline-flex" data-forget-blocked>
            <Button variant="ghost" size="sm" disabled>
              Forget
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Finish or cancel its {openTasks} open task(s) first.</TooltipContent>
      </Tooltip>
    );
  };

  const result = () =>
    forgotten.value !== null && (
      <Alert role="status" class="forget-result">
        <AlertTitle>
          <Emoji symbol={EMOJI.pass} />
          JERRY forgot {forgotten.value.repoRoot}
        </AlertTitle>
        <AlertDescription>
          <p>
            {forgotten.value.totalRows} row(s) deleted; freed {formatBytes(Math.max(0, forgotten.value.databaseBytesBefore - forgotten.value.databaseBytesAfter))}. Backup taken before: <code class="font-mono text-xs break-all">{forgotten.value.backupFile}</code>
          </p>
        </AlertDescription>
      </Alert>
    );

  const dialog = () =>
    forgetting.value !== null && (
      <ConfirmDialog title="Forget this repository?" expected={forgetting.value.repoRoot} confirmLabel="Forget repository" tone="danger" busy={busy.value} onConfirm={forget} onCancel={() => (forgetting.value = null)}>
        <p>
          <code class="text-foreground font-mono">{forgetting.value.repoRoot}</code>
        </p>
        <p>
          Deletes {forgetting.value.totalRows} row(s){forgetting.value.tasks.length > 0 && `, including ${forgetting.value.tasks.join(', ')}`}
          {forgetting.value.project && '; the project is removed too'}.
        </p>
        <p class="text-xs">The repository itself is not touched. Core keeps a backup of the database taken right before deleting.</p>
      </ConfirmDialog>
    );

  return { askForget, forgetButton, result, dialog, forgotten };
}
