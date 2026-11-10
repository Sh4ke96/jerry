import type { Workspace } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { ArrowLeft, Pencil, Plus, Trash2 } from '@lucide/vue';
import { computed, defineComponent, onMounted, ref } from 'vue';
import { api, HttpError } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Emoji } from '../components/Emoji';
import { StatusBadge } from '../components/StatusBadge';
import { TaskTile } from '../components/TaskTile';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Loading } from '../components/ui/spinner';
import { workspaceSummary } from '../components/WorkspacesCard';
import { insideRoot, projectName, taskTouches } from '../lib/tasks';
import { isTerminal } from '@jerry/workflow';
import { linkTo, navigate, projectHref } from '../router';
import { handleError, refresh, state } from '../state';

/** The workspace on screen, for the header's page title. */
export const shownWorkspace = ref<Workspace | null>(null);

type Pending = { kind: 'add'; path: string } | { kind: 'remove'; path: string } | { kind: 'rename'; name: string } | { kind: 'delete' };

/**
 * One workspace: its repositories (each a project with its own page), the open tasks of all of
 * them, the links JERRY found between them, and the user's changes (add or remove a repository,
 * rename, delete), each confirmed as the Settings option says. Removing a repository or deleting
 * the workspace keeps the projects.
 */
export const WorkspacePage = defineComponent({
  name: 'WorkspacePage',
  props: { id: { type: Number, required: true } },
  setup(props) {
    const workspace = ref<Workspace | null>(null);
    const missing = ref(false);
    const newPath = ref('');
    const newName = ref('');
    const renaming = ref(false);
    const pending = ref<Pending | null>(null);
    const busy = ref(false);

    const load = async (): Promise<void> => {
      try {
        workspace.value = await api.workspace(props.id);
        shownWorkspace.value = workspace.value;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) missing.value = true;
        else handleError(error);
      }
    };
    onMounted(() => void load());

    const tasks = computed(() => {
      const current = workspace.value;
      if (current === null) return [];
      // Each task once, also one across several of the workspace's repositories.
      return [...state.tasks].reverse().filter((task) => !isTerminal(task.state) && current.repos.some((repo) => taskTouches(task, repo.repoRoot)));
    });
    /** Links JERRY found between the workspace's repositories (from their profiles). */
    const links = computed(() => {
      const current = workspace.value;
      if (current === null) return [];
      const inside = (root: string): boolean => current.repos.some((repo) => insideRoot(root, repo.repoRoot) && insideRoot(repo.repoRoot, root));
      return state.graph.edges.filter((edge) => inside(edge.from) && inside(edge.to));
    });

    const decide = async (typed: string): Promise<void> => {
      const current = workspace.value;
      const change = pending.value;
      if (current === null || change === null) return;
      busy.value = true;
      try {
        if (change.kind === 'delete') {
          await api.deleteWorkspace(current.id, typed);
          state.notice = `Deleted the workspace ${current.name}; its repositories stay projects.`;
          pending.value = null;
          navigate('#/projects');
          return;
        }
        const result =
          change.kind === 'add' ? await api.addWorkspaceRepo(current.id, change.path, typed) : change.kind === 'remove' ? await api.removeWorkspaceRepo(current.id, change.path, typed) : await api.renameWorkspace(current.id, change.name, typed);
        workspace.value = result.workspace;
        shownWorkspace.value = result.workspace;
        state.notice =
          change.kind === 'add'
            ? `Added ${change.path}${result.addedProjects.length > 0 ? '; JERRY monitors it now' : ''}.`
            : change.kind === 'remove'
              ? `${change.path} is no longer in ${current.name}; it stays a project.`
              : `Renamed to ${change.name}.`;
        pending.value = null;
        newPath.value = '';
        renaming.value = false;
        await refresh();
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    const back = () => (
      <a class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm" {...linkTo('#/projects')}>
        <ArrowLeft class="size-4" />
        Projects
      </a>
    );

    const dialog = (current: Workspace) => {
      const change = pending.value;
      if (change === null) return null;
      const titles: Record<Pending['kind'], string> = { add: `Add a repository to ${current.name}?`, remove: `Remove it from ${current.name}?`, rename: `Rename ${current.name}?`, delete: `Delete the workspace ${current.name}?` };
      return (
        <ConfirmDialog
          title={titles[change.kind]}
          expected={current.name}
          confirmLabel={change.kind === 'delete' ? 'Delete workspace' : change.kind === 'remove' ? 'Remove from workspace' : change.kind === 'rename' ? 'Rename' : 'Add repository'}
          tone={change.kind === 'delete' || change.kind === 'remove' ? 'danger' : 'primary'}
          busy={busy.value}
          onConfirm={(typed: string) => void decide(typed)}
          onCancel={() => (pending.value = null)}
        >
          {change.kind === 'add' && <p>{change.path} becomes part of the workspace and a JERRY project, if it is not one yet.</p>}
          {change.kind === 'remove' && <p>{change.path} leaves the workspace but stays a project: JERRY keeps checking edits there.</p>}
          {change.kind === 'rename' && <p>New name: {change.name}</p>}
          {change.kind === 'delete' && <p>Only the grouping goes: every repository stays a JERRY project with its tasks.</p>}
        </ConfirmDialog>
      );
    };

    return () => {
      if (missing.value) {
        return (
          <div class="workspace-page flex flex-col gap-4">
            {back()}
            <Card>
              <CardHeader>
                <CardTitle>There is no such workspace</CardTitle>
                <CardDescription>It may have been deleted, or the address is mistyped.</CardDescription>
              </CardHeader>
            </Card>
          </div>
        );
      }
      const current = workspace.value;
      if (current === null) return <Loading class="workspace-page" />;
      return (
        <div class="workspace-page flex flex-col gap-4 md:gap-6" data-workspace-page={current.name}>
          {back()}
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.repository} />
                {current.name}
              </CardTitle>
              <CardDescription>{workspaceSummary(current)}. Each repository keeps its own plans and tasks; a Claude Code session in one of them, or in their common folder, knows the workspace.</CardDescription>
              <CardAction class="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  data-rename-workspace
                  onClick={() => {
                    newName.value = current.name;
                    renaming.value = !renaming.value;
                  }}
                >
                  <Pencil />
                  Rename
                </Button>
                <Button size="sm" variant="ghost" class="text-destructive hover:text-destructive" data-delete-workspace onClick={() => (pending.value = { kind: 'delete' })}>
                  <Trash2 />
                  Delete
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent class="grid gap-4">
              {renaming.value && (
                <form
                  class="flex flex-wrap items-end gap-2"
                  onSubmit={(event: Event) => {
                    event.preventDefault();
                    if (newName.value.trim() !== '' && newName.value.trim() !== current.name) pending.value = { kind: 'rename', name: newName.value.trim() };
                  }}
                >
                  <div class="grid gap-1.5">
                    <Label for="workspace-new-name">New name</Label>
                    <Input id="workspace-new-name" maxlength={60} modelValue={newName.value} onUpdate:modelValue={(value: string) => (newName.value = value)} />
                  </div>
                  <Button type="submit" size="sm">
                    Rename…
                  </Button>
                </form>
              )}
              <ul class="workspace-repos grid grid-cols-1 gap-2">
                {current.repos.map((repo) => (
                  <li key={repo.repoRoot} class="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3" data-workspace-repo={repo.repoRoot}>
                    <div class="grid min-w-0 gap-0.5">
                      <div class="flex flex-wrap items-center gap-2">
                        <a class="font-medium hover:underline" {...linkTo(projectHref(repo.repoRoot))}>
                          {projectName(repo.repoRoot)}
                        </a>
                        {!repo.project && <StatusBadge tone="warn">not monitored</StatusBadge>}
                        {!repo.present && <StatusBadge tone="deny">folder missing</StatusBadge>}
                        {repo.waiting > 0 && (
                          <StatusBadge tone="warn" emoji={EMOJI.waiting}>
                            {repo.waiting} waiting
                          </StatusBadge>
                        )}
                      </div>
                      <code class="text-muted-foreground font-mono text-xs break-all">{repo.repoRoot}</code>
                      <span class="text-muted-foreground text-xs">{repo.openTasks} open task(s)</span>
                    </div>
                    <Button size="sm" variant="ghost" data-remove-repo={repo.repoRoot} onClick={() => (pending.value = { kind: 'remove', path: repo.repoRoot })}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
              <form
                class="flex flex-wrap items-end gap-2"
                onSubmit={(event: Event) => {
                  event.preventDefault();
                  if (newPath.value.trim() !== '') pending.value = { kind: 'add', path: newPath.value.trim() };
                }}
              >
                <div class="grid min-w-0 flex-1 gap-1.5">
                  <Label for="workspace-add-path">Add a repository</Label>
                  <Input id="workspace-add-path" class="font-mono" placeholder={'D:\\Work\\admin'} autocomplete="off" spellcheck={false} modelValue={newPath.value} onUpdate:modelValue={(value: string) => (newPath.value = value)} />
                </div>
                <Button type="submit" size="sm" variant="outline" data-add-repo disabled={newPath.value.trim() === ''}>
                  <Plus />
                  Add…
                </Button>
              </form>
              {links.value.length > 0 && (
                <div class="grid gap-1 text-sm">
                  <p class="font-medium">Links between them</p>
                  <ul class="text-muted-foreground grid gap-0.5 text-xs">
                    {links.value.map((edge, index) => (
                      <li key={index}>
                        {projectName(edge.from)} → {projectName(edge.to)}: {edge.kind}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.task} />
                Open tasks
              </CardTitle>
              <CardDescription>Of every repository in the workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              {tasks.value.length === 0 ? <p class="text-muted-foreground text-sm">No open task in these repositories.</p> : <div class="task-grid grid grid-cols-1 gap-3">{tasks.value.map((task) => <TaskTile key={task.taskId} task={task} />)}</div>}
            </CardContent>
          </Card>
          {dialog(current)}
        </div>
      );
    };
  },
});
