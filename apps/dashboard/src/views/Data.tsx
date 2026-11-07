import type { DataCategory, DataUsage, ForgetPreview, ForgetResult, PruneOptions, PrunePreview, PruneResult } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { computed, defineComponent, onMounted, reactive, ref, watch } from 'vue';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Emoji } from '../components/Emoji';
import { Fact, Facts } from '../components/Facts';
import { StatusBadge } from '../components/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Skeleton } from '../components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { formatBytes, formatTime } from '../format';
import { CHIP, LIST } from '../lib/classes';
import { handleError, refresh, state } from '../state';

const CATEGORY: Record<DataCategory, { label: string; emoji: string }> = {
  tasks: { label: 'Tasks, plans and approvals', emoji: EMOJI.task },
  analysis: { label: 'Analysis reports', emoji: EMOJI.analysis },
  review: { label: 'Reviews', emoji: EMOJI.review },
  quality: { label: 'Quality findings and test runs', emoji: EMOJI.finding },
  events: { label: 'Events (the timeline)', emoji: EMOJI.info },
  sessions: { label: 'Sessions and subagent runs', emoji: EMOJI.session },
  git: { label: 'Git snapshots', emoji: EMOJI.implementation },
  projects: { label: 'Projects', emoji: EMOJI.repository },
  evals: { label: 'Evals', emoji: EMOJI.evals },
  system: { label: 'Audit log and settings', emoji: EMOJI.jerry },
};

/** The clean-up options as typed; empty means "not this kind of data". */
type Field = 'doneOlderThanDays' | 'eventsOlderThanDays' | 'evalsOlderThanDays' | 'backupsKeep';

const FIELDS: Array<{ id: Field; label: string; unit: string }> = [
  { id: 'doneOlderThanDays', label: 'Finished and cancelled tasks older than', unit: 'days' },
  { id: 'eventsOlderThanDays', label: 'Events and sessions older than', unit: 'days' },
  { id: 'evalsOlderThanDays', label: 'Eval runs older than', unit: 'days (baselines stay)' },
  { id: 'backupsKeep', label: 'Keep the newest', unit: 'backups' },
];

/**
 * What JERRY stores on this computer, and deleting old data. Every deletion is previewed first,
 * needs a typed confirmation, and Core takes a backup right before it.
 */
export const Data = defineComponent({
  name: 'Data',
  setup() {
    const usage = ref<DataUsage | null>(null);
    const fields = reactive<Record<Field, string>>({ doneOlderThanDays: '', eventsOlderThanDays: '', evalsOlderThanDays: '', backupsKeep: '' });
    const preview = ref<PrunePreview | null>(null);
    const pruned = ref<PruneResult | null>(null);
    const deleting = ref(false);
    const forgetting = ref<ForgetPreview | null>(null);
    const forgotten = ref<ForgetResult | null>(null);
    const busy = ref(false);

    const load = async (): Promise<void> => {
      try {
        usage.value = await api.dataUsage();
      } catch (error) {
        handleError(error);
      }
    };
    onMounted(() => void load());

    const options = computed((): PruneOptions | null => {
      const chosen: PruneOptions = {};
      for (const field of FIELDS) {
        const text = fields[field.id].trim();
        if (text === '') continue;
        const value = Number(text);
        if (!Number.isInteger(value) || value < 0) return null;
        chosen[field.id] = value;
      }
      return Object.keys(chosen).length === 0 ? null : chosen;
    });
    // A preview shows exactly what one set of options deletes; another set needs its own.
    watch(options, () => (preview.value = null), { deep: true });

    const showPreview = async (): Promise<void> => {
      if (options.value === null) return;
      busy.value = true;
      try {
        preview.value = await api.previewPrune(options.value);
        pruned.value = null;
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    const prune = async (typed: string): Promise<void> => {
      const chosen = preview.value?.options;
      if (chosen === undefined) return;
      busy.value = true;
      try {
        pruned.value = await api.prune(chosen, typed);
        state.notice = `Deleted ${pruned.value.totalRows} row(s) and ${pruned.value.backups.count} backup file(s).`;
        deleting.value = false;
        preview.value = null;
        await Promise.all([load(), refresh()]);
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

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
        await Promise.all([load(), refresh()]);
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    /** Rows per table, largest first; tables without rows are left out. */
    const rowsTable = (rows: Record<string, number>, total: number) => (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Table</TableHead>
            <TableHead class="text-right">Rows</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(rows)
            .filter(([, count]) => count > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([table, count]) => (
              <TableRow key={table}>
                <TableCell class="font-mono text-xs">{table}</TableCell>
                <TableCell class="text-right tabular-nums">{count}</TableCell>
              </TableRow>
            ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell>Total</TableCell>
            <TableCell class="text-right tabular-nums">{total}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    );

    const summary = (data: DataUsage) => (
      <Card class="data-usage">
        <CardHeader>
          <CardDescription class="flex items-center">
            <Emoji symbol={EMOJI.checkpoint} />
            Data
          </CardDescription>
          <CardTitle class="text-2xl font-semibold tabular-nums">JERRY stores {formatBytes(data.totalBytes)} on this computer</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts>
            <Fact label="Database">
              {formatBytes(data.database.bytes)} <code class="text-muted-foreground font-mono text-xs break-all">{data.database.file}</code>
            </Fact>
            <Fact label="Backups">
              {data.backups.count} file(s), {formatBytes(data.backups.bytes)}
              {data.backups.newestAt !== null && <span class="text-muted-foreground"> · newest {formatTime(data.backups.newestAt)}</span>} <code class="text-muted-foreground font-mono text-xs break-all">{data.backups.dir}</code>
            </Fact>
            <Fact label="Logs">
              {formatBytes(data.logs.bytes)} <code class="text-muted-foreground font-mono text-xs break-all">{data.logs.dir}</code>
            </Fact>
            <Fact label="Retention">Events and sessions older than {data.retentionDays} days are removed automatically.</Fact>
          </Facts>
        </CardContent>
      </Card>
    );

    const categories = (data: DataUsage) => (
      <Card>
        <CardHeader>
          <CardTitle>What is stored</CardTitle>
          <CardDescription>Sizes are SQLite's estimate, indexes included.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table class="data-categories">
            <TableHeader>
              <TableRow>
                <TableHead>Kind of data</TableHead>
                <TableHead class="text-right">Rows</TableHead>
                <TableHead class="text-right">Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.categories.map((entry) => (
                <TableRow key={entry.category} title={entry.tables.map((table) => `${table.table}: ${table.rows}`).join(', ')}>
                  <TableCell>
                    <Emoji symbol={CATEGORY[entry.category].emoji} />
                    {CATEGORY[entry.category].label}
                  </TableCell>
                  <TableCell class="text-right tabular-nums">{entry.rows}</TableCell>
                  <TableCell class="text-right tabular-nums">{formatBytes(entry.bytes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    );

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

    const repositories = (data: DataUsage) => (
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.repository} />
            By repository
          </CardTitle>
          <CardDescription>Projects, and every other repository JERRY has data of. Forgetting deletes everything JERRY stores about one repository.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.projects.length === 0 ? (
            <p class="text-muted-foreground text-sm">JERRY has no data of any repository yet.</p>
          ) : (
            <Table class="data-repositories">
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead class="text-right">Tasks (open)</TableHead>
                  <TableHead class="text-right">Events</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>
                    <span class="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.projects.map((entry) => (
                  <TableRow key={entry.repoRoot} data-repository={entry.repoRoot}>
                    <TableCell class="whitespace-normal">
                      <code class="font-mono text-xs break-all">{entry.repoRoot}</code>{' '}
                      {entry.project ? <StatusBadge tone="pass">project</StatusBadge> : <StatusBadge>not added</StatusBadge>}
                    </TableCell>
                    <TableCell class="text-right tabular-nums">
                      {entry.tasks} ({entry.openTasks})
                    </TableCell>
                    <TableCell class="text-right tabular-nums">{entry.events}</TableCell>
                    <TableCell class="text-muted-foreground">{entry.lastActivityAt === null ? 'none' : formatTime(entry.lastActivityAt)}</TableCell>
                    <TableCell class="text-right">{forgetButton(entry.repoRoot, entry.openTasks)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    );

    const cleanUp = () => (
      <Card class="clean-up">
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.cancelled} />
            Clean up
          </CardTitle>
          <CardDescription>Fill in what to delete, preview it, then delete. Core takes a backup of the database right before deleting.</CardDescription>
        </CardHeader>
        <CardContent class="grid gap-4">
          <form
            class="grid gap-4 sm:grid-cols-2"
            onSubmit={(event: Event) => {
              event.preventDefault();
              void showPreview();
            }}
          >
            {FIELDS.map((field) => (
              <div key={field.id} class="grid gap-2">
                <Label for={`prune-${field.id}`}>{field.label}</Label>
                <div class="flex items-center gap-2">
                  <Input id={`prune-${field.id}`} type="number" min={0} step={1} inputmode="numeric" class="w-28 tabular-nums" modelValue={fields[field.id]} onUpdate:modelValue={(value: string) => (fields[field.id] = value)} />
                  <span class="text-muted-foreground text-sm">{field.unit}</span>
                </div>
              </div>
            ))}
            <div class="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" variant="outline" disabled={options.value === null || busy.value}>
                Preview
              </Button>
              <Button type="button" variant="destructive" disabled={preview.value === null || preview.value.totalRows + preview.value.backups.count === 0 || busy.value} onClick={() => (deleting.value = true)}>
                Delete
              </Button>
            </div>
          </form>
          {preview.value !== null && (
            <div class="prune-preview grid gap-3 rounded-lg border p-4 text-sm">
              <h3 class="font-medium">
                {preview.value.totalRows + preview.value.backups.count === 0 ? 'Nothing to delete with these settings.' : `Would delete ${preview.value.totalRows} row(s) and ${preview.value.backups.count} backup file(s) (${formatBytes(preview.value.backups.bytes)}).`}
              </h3>
              {preview.value.tasks.length > 0 && (
                <p class="flex flex-wrap items-center gap-1.5">
                  Tasks:{' '}
                  {preview.value.tasks.map((taskId) => (
                    <code key={taskId} class={CHIP}>
                      {taskId}
                    </code>
                  ))}
                </p>
              )}
              {preview.value.totalRows > 0 && rowsTable(preview.value.rows, preview.value.totalRows)}
              {preview.value.backups.files.length > 0 && (
                <ul class={[LIST, 'font-mono text-xs']}>
                  {preview.value.backups.files.map((file) => (
                    <li key={file} class="break-all">
                      {file}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
        {pruned.value !== null && (
          <CardFooter>
            <Alert role="status" class="prune-result">
              <AlertTitle>
                <Emoji symbol={EMOJI.pass} />
                Deleted {pruned.value.totalRows} row(s) and {pruned.value.backups.count} backup file(s)
              </AlertTitle>
              <AlertDescription>
                <p>Freed {formatBytes(Math.max(0, pruned.value.databaseBytesBefore - pruned.value.databaseBytesAfter))} in the database.</p>
                <p>
                  Backup taken before deleting: <code class="font-mono text-xs break-all">{pruned.value.backupFile}</code>
                </p>
              </AlertDescription>
            </Alert>
          </CardFooter>
        )}
      </Card>
    );

    return () => {
      const data = usage.value;
      return (
        <div class="data flex flex-col gap-4 md:gap-6">
          {data === null ? (
            <div class="grid gap-4">
              <span class="sr-only">Loading…</span>
              <Skeleton class="h-36" />
              <Skeleton class="h-64" />
            </div>
          ) : (
            [summary(data), categories(data), repositories(data)]
          )}
          {forgotten.value !== null && (
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
          )}
          {cleanUp()}

          {deleting.value && preview.value !== null && (
            <ConfirmDialog title="Delete this data?" expected="delete" confirmLabel="Delete data" tone="danger" busy={busy.value} onConfirm={prune} onCancel={() => (deleting.value = false)}>
              <p>
                {preview.value.totalRows} row(s) and {preview.value.backups.count} backup file(s), exactly as previewed.
              </p>
              <p class="text-xs">This cannot be undone from the dashboard; Core keeps a backup of the database taken right before deleting.</p>
            </ConfirmDialog>
          )}
          {forgetting.value !== null && (
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
          )}
        </div>
      );
    };
  },
});
