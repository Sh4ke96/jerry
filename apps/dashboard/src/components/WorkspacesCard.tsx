import type { Workspace, WorkspaceScan } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { Plus, Search } from '@lucide/vue';
import { defineComponent, onMounted, ref } from 'vue';
import { api, HttpError } from '../api';
import { projectName } from '../lib/tasks';
import { linkTo, navigate, workspaceHref } from '../router';
import { handleError, refresh, state } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { StatusBadge } from './StatusBadge';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

/** Clicks on these do their own thing; elsewhere on a workspace's row a click opens its page. */
const INTERACTIVE = 'a, button';

/** One path per line (blank lines and surrounding quotes ignored). */
export function pathsOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["']|["']$/g, ''))
    .filter((line) => line !== '');
}

/** A workspace in one line: its repositories and what waits in them. */
export function workspaceSummary(workspace: Workspace): string {
  const open = distinctCount(workspace, 'open');
  return `${workspace.repos.length} repositor${workspace.repos.length === 1 ? 'y' : 'ies'} · ${open} open task(s)`;
}

/**
 * Open or waiting tasks over a workspace, each once: a task across several of its repositories is
 * counted in each repository. An older Core sends no IDs; then the counts are summed.
 */
export function distinctCount(workspace: Workspace, kind: 'open' | 'waiting'): number {
  const count = (repo: Workspace['repos'][number]): number => (kind === 'open' ? repo.openTasks : repo.waiting);
  const ids = (repo: Workspace['repos'][number]): string[] | undefined => (kind === 'open' ? repo.openTaskIds : repo.waitingTaskIds);
  // IDs only count when every repository sent all of them.
  const complete = workspace.repos.every((repo) => ids(repo)?.length === count(repo));
  if (complete) return new Set(workspace.repos.flatMap((repo) => ids(repo) ?? [])).size;
  return workspace.repos.reduce((sum, repo) => sum + count(repo), 0);
}

/**
 * The New workspace dialog: a name and the repositories, pasted as paths or found in a folder
 * (checkboxes); creating it, confirmed as the Settings option says, adds them as projects.
 */
export function useNewWorkspace(afterCreate: (workspace: Workspace) => void) {
  const open = ref(false);
  const name = ref('');
  const pasted = ref('');
  const folder = ref('');
  const scan = ref<WorkspaceScan | null>(null);
  const chosen = ref<Set<string>>(new Set());
  const confirming = ref(false);
  const busy = ref(false);
  const problem = ref<string | null>(null);

  const reset = (): void => {
    name.value = '';
    pasted.value = '';
    folder.value = '';
    scan.value = null;
    chosen.value = new Set();
    problem.value = null;
  };
  const paths = (): string[] => [...new Set([...pathsOf(pasted.value), ...chosen.value])];

  const findRepos = async (): Promise<void> => {
    if (folder.value.trim() === '') return;
    busy.value = true;
    problem.value = null;
    try {
      scan.value = await api.scanWorkspaceFolder(folder.value.trim());
      // Free ones are chosen at once; ones in another workspace cannot be.
      chosen.value = new Set(scan.value.repos.filter((repo) => repo.workspace === null).map((repo) => repo.repoRoot));
    } catch (error) {
      problem.value = error instanceof Error ? error.message : String(error);
    } finally {
      busy.value = false;
    }
  };

  const toggle = (repoRoot: string, on: boolean): void => {
    const next = new Set(chosen.value);
    if (on) next.add(repoRoot);
    else next.delete(repoRoot);
    chosen.value = next;
  };

  const create = async (typed: string): Promise<void> => {
    busy.value = true;
    try {
      const result = await api.createWorkspace(name.value.trim(), paths(), typed);
      confirming.value = false;
      open.value = false;
      state.notice = `Created workspace ${result.workspace!.name}${result.addedProjects.length > 0 ? `; JERRY monitors ${result.addedProjects.length} more project(s) now` : ''}.`;
      reset();
      await refresh();
      afterCreate(result.workspace!);
    } catch (error) {
      // Back to the form, which shows why.
      confirming.value = false;
      problem.value = error instanceof Error ? error.message : String(error);
    } finally {
      busy.value = false;
    }
  };

  const dialogs = () => [
    <Dialog key="new-workspace" open={open.value && !confirming.value} onUpdate:open={(value: boolean) => (open.value = value)}>
      <DialogContent class="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form
          class="new-workspace grid gap-4"
          onSubmit={(event: Event) => {
            event.preventDefault();
            if (name.value.trim() !== '' && paths().length > 0) confirming.value = true;
          }}
        >
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>Several repositories under one name. Each one becomes a JERRY project (if it is not one yet) and keeps its own plans and tasks.</DialogDescription>
          </DialogHeader>
          {problem.value !== null && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{problem.value}</AlertDescription>
            </Alert>
          )}
          <div class="grid gap-2">
            <Label for="workspace-name">Name</Label>
            <Input id="workspace-name" placeholder="e.g. Shop" autocomplete="off" maxlength={60} modelValue={name.value} onUpdate:modelValue={(value: string) => (name.value = value)} />
          </div>
          <div class="grid gap-2">
            <Label for="workspace-folder">Find repositories in a folder</Label>
            <div class="flex gap-2">
              <Input
                id="workspace-folder"
                class="font-mono"
                placeholder={'D:\\Work'}
                autocomplete="off"
                spellcheck={false}
                modelValue={folder.value}
                onUpdate:modelValue={(value: string) => (folder.value = value)}
                onKeydown={(event: KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void findRepos();
                  }
                }}
              />
              <Button type="button" variant="outline" data-scan-folder disabled={busy.value || folder.value.trim() === ''} onClick={() => void findRepos()}>
                <Search />
                Find
              </Button>
            </div>
            {scan.value !== null &&
              (scan.value.repos.length === 0 ? (
                <p class="text-muted-foreground text-sm">No Git repositories in {scan.value.folder} (two levels deep).</p>
              ) : (
                <ul class="workspace-scan grid gap-1.5 rounded-md border p-2 text-sm">
                  {scan.value.repos.map((repo) => {
                    const id = `scan-${repo.repoRoot}`;
                    return (
                      <li key={repo.repoRoot} class="flex items-center gap-2" data-scan-repo={repo.repoRoot}>
                        <input id={id} type="checkbox" class="size-4" checked={chosen.value.has(repo.repoRoot)} disabled={repo.workspace !== null} onChange={(event: Event) => toggle(repo.repoRoot, (event.target as HTMLInputElement).checked)} />
                        <label for={id} class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
                          <span class="font-medium">{projectName(repo.repoRoot)}</span>
                          <code class="text-muted-foreground truncate font-mono text-xs">{repo.repoRoot}</code>
                          {repo.project && <StatusBadge>project</StatusBadge>}
                          {repo.workspace !== null && <StatusBadge tone="warn">in {repo.workspace}</StatusBadge>}
                        </label>
                      </li>
                    );
                  })}
                  {scan.value.truncated && <li class="text-muted-foreground text-xs">The folder is large; the search stopped early. Paste the missing ones below.</li>}
                </ul>
              ))}
          </div>
          <div class="grid gap-2">
            <Label for="workspace-paths">Or paste repository folders (one per line)</Label>
            <Textarea id="workspace-paths" class="font-mono text-xs" rows={3} placeholder={'D:\\Work\\api\nD:\\Work\\shop'} modelValue={pasted.value} onUpdate:modelValue={(value: string) => (pasted.value = value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => (open.value = false)}>
              Cancel
            </Button>
            <Button type="submit" data-create-workspace disabled={busy.value || name.value.trim() === '' || paths().length === 0}>
              Create with {paths().length} repositor{paths().length === 1 ? 'y' : 'ies'}…
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>,
    confirming.value && (
      <ConfirmDialog key="confirm-workspace" title={`Create the workspace ${name.value.trim()}?`} expected={name.value.trim()} confirmLabel="Create workspace" busy={busy.value} onConfirm={(typed: string) => void create(typed)} onCancel={() => (confirming.value = false)}>
        <ul class="grid gap-0.5">
          {paths().map((repo) => (
            <li key={repo}>
              <code class="text-foreground font-mono text-xs">{repo}</code>
            </li>
          ))}
        </ul>
        <p class="text-xs">Each becomes a JERRY project if it is not one yet: JERRY then checks Claude's edits there against approved plans. Deleting the workspace later keeps them as projects.</p>
      </ConfirmDialog>
    ),
  ];

  return {
    openNew: () => {
      reset();
      open.value = true;
    },
    dialogs,
  };
}

/** Projects page: the workspaces as full-width rows, and New workspace. */
export const WorkspacesCard = defineComponent({
  name: 'WorkspacesCard',
  setup() {
    const list = ref<Workspace[] | null>(null);
    const load = async (): Promise<void> => {
      try {
        list.value = await api.workspaces();
      } catch (error) {
        // An older Core has no workspaces: the card simply shows none.
        if (error instanceof HttpError && error.status === 404) list.value = [];
        else handleError(error);
      }
    };
    onMounted(() => void load());
    const creator = useNewWorkspace((workspace) => navigate(workspaceHref(workspace.id)));

    const row = (workspace: Workspace) => {
      const waiting = distinctCount(workspace, 'waiting');
      return (
        <li
          key={workspace.id}
          class="workspace-row bg-card hover:bg-muted/40 grid cursor-pointer gap-2 rounded-xl border p-4 transition-colors"
          data-workspace={workspace.name}
          onClick={(event: MouseEvent) => {
            if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
            navigate(workspaceHref(workspace.id));
          }}
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <a class="font-semibold hover:underline" {...linkTo(workspaceHref(workspace.id))}>
                {workspace.name}
              </a>
              <span class="text-muted-foreground text-xs">{workspaceSummary(workspace)}</span>
            </div>
            {waiting > 0 && (
              <StatusBadge tone="warn" emoji={EMOJI.waiting}>
                {waiting} waiting for you
              </StatusBadge>
            )}
          </div>
          <div class="flex flex-wrap gap-1.5">
            {workspace.repos.map((repo) => (
              <code key={repo.repoRoot} class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs" title={repo.repoRoot}>
                {projectName(repo.repoRoot)}
              </code>
            ))}
          </div>
        </li>
      );
    };

    return () => (
      <Card class="workspaces">
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.repository} />
            Workspaces
          </CardTitle>
          <CardDescription>Several repositories under one name, like a VS Code workspace. Each stays its own project with its own plans and tasks.</CardDescription>
          <CardAction>
            <Button size="sm" data-new-workspace onClick={creator.openNew}>
              <Plus />
              New workspace
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {list.value === null ? (
            <p class="text-muted-foreground text-sm">Loading…</p>
          ) : list.value.length === 0 ? (
            <p class="text-muted-foreground text-sm">No workspaces yet. Group the repositories you work on together, e.g. api, shop and admin.</p>
          ) : (
            <ul class="workspace-list grid grid-cols-1 gap-3">{list.value.map(row)}</ul>
          )}
        </CardContent>
        {creator.dialogs()}
      </Card>
    );
  },
});
