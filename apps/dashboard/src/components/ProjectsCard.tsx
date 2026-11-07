import type { ProjectSummary } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { Plus } from '@lucide/vue';
import { defineComponent, ref } from 'vue';
import { api } from '../api';
import { formatTime } from '../format';
import { ATTENTION } from '../lib/classes';
import { handleError, refresh, state } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { StatusBadge } from './StatusBadge';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

const ADDED_BY: Record<string, string> = { cli: 'in a terminal', dashboard: 'in the dashboard', migration: 'when projects were introduced' };

/**
 * The repositories the user added. JERRY monitors only these; elsewhere only the hard rules apply.
 * Adding and removing are decisions: the repository root is typed, as in the CLI.
 */
export const ProjectsCard = defineComponent({
  name: 'ProjectsCard',
  setup() {
    /** The add dialog is open; then `path` is what the user entered. */
    const asking = ref(false);
    const path = ref('');
    /** The path to add, waiting for its typed confirmation. */
    const adding = ref<string | null>(null);
    const removing = ref<ProjectSummary | null>(null);
    const busy = ref(false);

    const add = async (typed: string): Promise<void> => {
      const target = adding.value;
      if (target === null) return;
      busy.value = true;
      try {
        const result = await api.addProject(target, typed);
        state.notice = result.added ? `JERRY monitors ${result.project.repoRoot} now.` : `${result.project.repoRoot} is already a project.`;
        adding.value = null;
        path.value = '';
        await refresh();
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    const remove = async (typed: string): Promise<void> => {
      const project = removing.value;
      if (project === null) return;
      busy.value = true;
      try {
        const result = await api.removeProject(project.repoRoot, typed);
        state.notice = result.warning ?? `JERRY no longer monitors ${result.repoRoot}; only hard rules apply there.`;
        removing.value = null;
        await refresh();
      } catch (error) {
        handleError(error);
      } finally {
        busy.value = false;
      }
    };

    const proceed = (event: Event): void => {
      event.preventDefault();
      if (path.value.trim() === '') return;
      asking.value = false;
      adding.value = path.value.trim();
    };

    return () => (
      <Card class="projects">
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.repository} />
            Projects
          </CardTitle>
          <CardDescription>JERRY monitors only the repositories added here. Everywhere else only the hard rules apply: no Git changes, no writes inside .git, no tampering with JERRY.</CardDescription>
          <CardAction>
            <Button size="sm" onClick={() => (asking.value = true)}>
              <Plus />
              Add project
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {state.projects.length === 0 ? (
            <p class="text-muted-foreground text-sm">
              No projects yet. Add one here, or run <code class="font-mono text-xs">jerry project add &lt;path&gt;</code> in a terminal.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>Open tasks</TableHead>
                  <TableHead>Last activity</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>
                    <span class="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.projects.map((project) => (
                  <TableRow key={project.repoRoot} data-project={project.repoRoot}>
                    <TableCell class="font-mono text-xs whitespace-normal break-all">
                      {project.repoRoot}
                      {!project.exists && (
                        <StatusBadge tone="warn" emoji={EMOJI.warning} class="ml-2" title="The directory no longer exists on disk">
                          missing
                        </StatusBadge>
                      )}
                      {project.note !== null && project.note !== '' && <div class="text-muted-foreground font-sans">{project.note}</div>}
                    </TableCell>
                    <TableCell class={project.openTasks > 0 ? 'font-medium' : 'text-muted-foreground'}>
                      {project.openTasks} of {project.tasks}
                    </TableCell>
                    <TableCell class="text-muted-foreground">{project.lastActivityAt === null ? 'none yet' : formatTime(project.lastActivityAt)}</TableCell>
                    <TableCell class="text-muted-foreground">
                      {formatTime(project.addedAt)} · {ADDED_BY[project.addedBy] ?? project.addedBy}
                    </TableCell>
                    <TableCell class="text-right">
                      <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" onClick={() => (removing.value = project)}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>

        <Dialog open={asking.value} onUpdate:open={(open: boolean) => (asking.value = open)}>
          <DialogContent>
            <form class="add-project grid gap-4" onSubmit={proceed}>
              <DialogHeader>
                <DialogTitle>Add a project</DialogTitle>
                <DialogDescription>The root of a Git repository. JERRY then checks Claude's edits there against approved plans.</DialogDescription>
              </DialogHeader>
              <div class="grid gap-2">
                <Label for="project-path">Repository root</Label>
                <Input id="project-path" class="font-mono" placeholder={'D:\\Projects\\my-repo'} autocomplete="off" spellcheck={false} modelValue={path.value} onUpdate:modelValue={(value: string) => (path.value = value)} />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => (asking.value = false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={path.value.trim() === ''}>
                  Continue
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {adding.value !== null && (
          <ConfirmDialog title="Add this project?" expected={adding.value} confirmLabel="Add project" busy={busy.value} onConfirm={add} onCancel={() => (adding.value = null)}>
            <p>
              <code class="text-foreground font-mono">{adding.value}</code>
            </p>
            <p class="text-xs">JERRY monitors the repository from now on: edits outside an approved plan are recorded as deviations. Hard rules apply as everywhere.</p>
          </ConfirmDialog>
        )}
        {removing.value !== null && (
          <ConfirmDialog title="Remove this project?" expected={removing.value.repoRoot} confirmLabel="Remove project" tone="danger" busy={busy.value} onConfirm={remove} onCancel={() => (removing.value = null)}>
            <p>
              <code class="text-foreground font-mono">{removing.value.repoRoot}</code>
            </p>
            {removing.value.openTasks > 0 && (
              <p class={ATTENTION}>
                <Emoji symbol={EMOJI.warning} />
                {removing.value.openTasks} open task(s) stay open, but nothing checks edits against their plans until you add the project again.
              </p>
            )}
            <p class="text-xs">JERRY stops monitoring it; only hard rules apply there. Its tasks and history stay on record.</p>
          </ConfirmDialog>
        )}
      </Card>
    );
  },
});
