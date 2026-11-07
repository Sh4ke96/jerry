import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, onMounted, ref } from 'vue';
import { api, SignedOutError } from '../api';
import { showsUsageBar } from '../settings';
import { handleError, loadUsage, renderTime, state } from '../state';
import { clockTime, collecting, entrypointLabel, readCollection, readProblems, type UsageSource } from '../usage';
import { Emoji } from './Emoji';
import { StatusBadge, type Tone } from './StatusBadge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Skeleton } from './ui/skeleton';
import { Switch } from './ui/switch';

const STATUSLINE: Record<string, { label: string; tone: Tone }> = {
  on: { label: 'On', tone: 'pass' },
  off: { label: 'Off', tone: 'neutral' },
  'not-jerry': { label: 'Your own status line (kept)', tone: 'warn' },
};

const TELEMETRY: Record<string, { label: string; tone: Tone }> = {
  on: { label: 'On', tone: 'pass' },
  off: { label: 'Off', tone: 'neutral' },
  clash: { label: 'Your own OpenTelemetry settings (kept)', tone: 'warn' },
};

/** "Terminal 14:02 · VS Code Mon 09:12", newest first; "no data yet" without any. */
function lastData(source: UsageSource, now: Date): string {
  const entries = Object.entries(source.byEntrypoint).sort(([, a], [, b]) => b.localeCompare(a));
  if (entries.length === 0) return source.lastAt === null ? 'no data yet' : `last data ${clockTime(source.lastAt, now)}`;
  return entries.map(([entrypoint, at]) => `${entrypointLabel(entrypoint)} ${clockTime(at, now)}`).join(' · ');
}

/**
 * Settings › Usage: whether JERRY collects Claude Code's usage (it edits Claude's user settings, so
 * the change is confirmed first), whether the usage bar shows, and what each source last sent.
 */
export const UsageSettings = defineComponent({
  name: 'UsageSettings',
  setup() {
    /** The collection change waiting for confirmation: true to turn on, false to turn off. */
    const pending = ref<boolean | null>(null);
    const busy = ref(false);
    const error = ref<string | null>(null);
    onMounted(() => void loadUsage(true));

    const setCollection = async (enabled: boolean): Promise<void> => {
      busy.value = true;
      error.value = null;
      try {
        const answer = await api.setUsageCollection(enabled);
        const collection = readCollection(answer);
        if (state.usage !== null) state.usage.collection = collection;
        const problems = readProblems(answer);
        const done = enabled ? 'Usage collection is on. New Claude Code sessions report to JERRY.' : 'Usage collection is off. Your previous Claude Code settings are restored.';
        state.notice = problems.length === 0 ? done : `${done} Not changed: ${problems.join('; ')}`;
        pending.value = null;
        await loadUsage(true);
      } catch (failure) {
        pending.value = null;
        if (failure instanceof SignedOutError) handleError(failure);
        else error.value = failure instanceof Error ? failure.message : String(failure);
      } finally {
        busy.value = false;
      }
    };

    const saveShowBar = async (usageShowBar: boolean): Promise<void> => {
      busy.value = true;
      error.value = null;
      try {
        state.settings = await api.saveSettings({ usageShowBar });
        state.notice = usageShowBar ? 'Saved: the usage bar shows in the top bar.' : 'Saved: the usage bar is hidden.';
      } catch (failure) {
        error.value = failure instanceof Error ? failure.message : String(failure);
      } finally {
        busy.value = false;
      }
    };

    const confirmation = () => {
      const enabling = pending.value;
      if (enabling === null) return null;
      return (
        <AlertDialog open={true} onUpdate:open={(open: boolean) => !open && !busy.value && (pending.value = null)}>
          <AlertDialogContent class="usage-collection-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{enabling ? 'Collect usage from Claude Code?' : 'Stop collecting usage?'}</AlertDialogTitle>
              <AlertDialogDescription as="div" class="grid gap-2">
                {enabling ? (
                  <>
                    <p>
                      JERRY edits your Claude Code user settings, <code class="text-foreground font-mono text-xs">~/.claude/settings.json</code>: it sets its status line (<code class="font-mono text-xs">statusLine</code>) and a few <code class="font-mono text-xs">env</code> keys that send Claude Code's token metrics to JERRY Core on this computer.
                    </p>
                    <p>A backup of the file is taken first. A status line or OpenTelemetry setup of your own is kept as it is. Turning collection off restores the keys JERRY changed.</p>
                    <p>JERRY never reads transcripts or Claude's login. New Claude Code sessions pick the change up.</p>
                  </>
                ) : (
                  <>
                    <p>
                      JERRY restores the <code class="font-mono text-xs">statusLine</code> and the <code class="font-mono text-xs">env</code> keys it changed in <code class="text-foreground font-mono text-xs">~/.claude/settings.json</code> to what they were before.
                    </p>
                    <p>Usage already collected stays until you delete it in Data.</p>
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={busy.value}>
                Cancel
              </AlertDialogCancel>
              <Button type="button" data-confirm-collection disabled={busy.value} onClick={() => void setCollection(enabling)}>
                {busy.value ? 'Working…' : enabling ? 'Turn on' : 'Turn off'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );
    };

    const body = () => {
      if (state.usageState === 'unavailable') {
        return <p class="text-muted-foreground text-sm usage-unavailable">This JERRY Core does not collect usage yet. Update JERRY and restart Core.</p>;
      }
      const usage = state.usage;
      if (usage === null) {
        if (state.usageState === 'error') return <p class="text-destructive text-sm">Usage could not be read: {state.usageError}</p>;
        return <Skeleton class="h-24" />;
      }
      const now = renderTime();
      const statusline = STATUSLINE[usage.collection.statusline] ?? STATUSLINE['off']!;
      const telemetry = TELEMETRY[usage.collection.telemetry] ?? TELEMETRY['off']!;
      return (
        <div class="grid gap-6">
          <div class="flex items-start justify-between gap-4">
            <div class="grid gap-1">
              <Label for="usage-collect">Collect usage from Claude Code</Label>
              <p class="text-muted-foreground text-sm">Plan limits through JERRY's status line, tokens and cost through Claude Code's telemetry, both kept on this computer.</p>
            </div>
            <Switch id="usage-collect" class="usage-collect mt-0.5" modelValue={collecting(usage.collection)} disabled={busy.value} onUpdate:modelValue={(value: boolean) => (pending.value = value)} />
          </div>
          <div class="flex items-start justify-between gap-4">
            <div class="grid gap-1">
              <Label for="usage-show-bar">Show the usage bar</Label>
              <p class="text-muted-foreground text-sm">The 5-hour and weekly limits in the top bar of every view and in the Jerry tray icon's tooltip.</p>
            </div>
            <Switch id="usage-show-bar" class="usage-show-bar mt-0.5" modelValue={showsUsageBar(state.settings)} disabled={busy.value || state.settings === null} onUpdate:modelValue={(value: boolean) => void saveShowBar(value)} />
          </div>
          <Separator />
          <dl class="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6" data-usage-sources>
            <dt class="font-medium">Status line</dt>
            <dd class="grid gap-1" data-source="statusline">
              <span>
                <StatusBadge tone={statusline.tone}>{statusline.label}</StatusBadge>
              </span>
              <span class="text-muted-foreground text-xs">{lastData(usage.sources.statusline, now)}</span>
            </dd>
            <dt class="font-medium">Telemetry</dt>
            <dd class="grid gap-1" data-source="telemetry">
              <span>
                <StatusBadge tone={telemetry.tone}>{telemetry.label}</StatusBadge>
              </span>
              <span class="text-muted-foreground text-xs">{lastData(usage.sources.telemetry, now)}</span>
            </dd>
          </dl>
          <p class="text-muted-foreground text-xs">
            Plan limits come from terminal sessions; the VS Code extension does not pass them. In a terminal: <code class="bg-muted rounded px-1 py-0.5">jerry usage status</code>.
          </p>
        </div>
      );
    };

    return () => (
      <Card class="settings-usage">
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.evals} />
            Usage
          </CardTitle>
          <CardDescription>Claude Code's plan limits, tokens and estimated cost, shown on the Overview.</CardDescription>
        </CardHeader>
        <CardContent class="grid gap-4">
          {body()}
          {error.value !== null && (
            <Alert variant="destructive" class="usage-settings-error">
              <AlertTitle>
                <Emoji symbol={EMOJI.fail} />
                Not changed
              </AlertTitle>
              <AlertDescription>
                <p>{error.value}</p>
              </AlertDescription>
            </Alert>
          )}
          {confirmation()}
        </CardContent>
      </Card>
    );
  },
});
