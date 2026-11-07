import type { DataUsage, ProjectSummary, RepositorySummary } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { ChevronDown, Plus } from '@lucide/vue';
import { defineComponent, ref, type PropType } from 'vue';
import { api } from '../api';
import { formatTime, waitsForUser } from '../format';
import { ATTENTION } from '../lib/classes';
import { projectName, repositoryOf, tasksOf } from '../lib/tasks';
import { cn } from '../lib/utils';
import { linkTo, navigate, projectHref } from '../router';
import { projectOwnReviewMode, projectReviewMode, REVIEW_MODE_LABEL } from '../settings';
import { handleError, refresh, state } from '../state';
import { ConfirmDialog } from './ConfirmDialog';
import { Emoji } from './Emoji';
import { Fact, Facts } from './Facts';
import { ProfileCommands, stackText } from './RepositoryProfile';
import { StatusBadge } from './StatusBadge';
import { WaitingMarker } from './TaskTile';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

export const ADDED_BY: Record<string, string> = { cli: 'in a terminal', dashboard: 'in the dashboard', migration: 'when projects were introduced' };

/**
 * Adding and removing projects. Both are decisions: the repository root is typed, as in the CLI.
 * The Projects view and the project page each hold one instance.
 */
export function useProjectActions(afterRemove: () => void = () => undefined) {
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
      afterRemove();
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

  const dialogs = () => [
    <Dialog key="add-path" open={asking.value} onUpdate:open={(open: boolean) => (asking.value = open)}>
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
    </Dialog>,
    adding.value !== null && (
      <ConfirmDialog key="add" title="Add this project?" expected={adding.value} confirmLabel="Add project" busy={busy.value} onConfirm={add} onCancel={() => (adding.value = null)}>
        <p>
          <code class="text-foreground font-mono">{adding.value}</code>
        </p>
        <p class="text-xs">JERRY monitors the repository from now on: edits outside an approved plan are recorded as deviations. Hard rules apply as everywhere.</p>
      </ConfirmDialog>
    ),
    removing.value !== null && (
      <ConfirmDialog key="remove" title="Remove this project?" expected={removing.value.repoRoot} confirmLabel="Remove project" tone="danger" busy={busy.value} onConfirm={remove} onCancel={() => (removing.value = null)}>
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
    ),
  ];

  return {
    /** Opens the dialog for a path typed by the user. */
    askPath: () => (asking.value = true),
    /** A known repository: straight to the typed confirmation of its root. */
    addRoot: (repoRoot: string) => (adding.value = repoRoot),
    askRemove: (project: ProjectSummary) => (removing.value = project),
    dialogs,
  };
}

/** The review mode of a project in words: its own setting, or the global one it inherits. */
export function reviewModeText(project: ProjectSummary): string | null {
  const own = projectOwnReviewMode(project);
  const effective = projectReviewMode(project);
  if (effective === null) return own === undefined || own === null ? null : REVIEW_MODE_LABEL[own];
  return own === null || own === undefined ? `${REVIEW_MODE_LABEL[effective]} (inherited from Settings)` : `${REVIEW_MODE_LABEL[effective]} (set for this project)`;
}

/** Clicks on these do their own thing; elsewhere in the tile header a click opens the project page. */
const INTERACTIVE = 'a, button, input, [role="menuitem"]';

/** A project as a tile: name, root, tasks and stack; the chevron unfolds commands, CI, review mode and data. */
export const ProjectTile = defineComponent({
  name: 'ProjectTile',
  props: {
    project: { type: Object as PropType<ProjectSummary>, required: true },
    usage: { type: Object as PropType<DataUsage | null>, default: null },
  },
  setup(props) {
    const open = ref(false);
    const openPage = (event: MouseEvent): void => {
      if ((event.target as Element | null)?.closest(INTERACTIVE)) return;
      navigate(projectHref(props.project.repoRoot));
    };
    return () => {
      const project = props.project;
      const repository: RepositorySummary | undefined = repositoryOf(project.repoRoot, state.repositories);
      const profile = repository?.profile ?? null;
      const waiting = tasksOf(project.repoRoot, state.tasks).filter(waitsForUser).length;
      const stored = props.usage?.projects.find((entry) => entry.repoRoot === project.repoRoot);
      const review = reviewModeText(project);
      return (
        <Card class={cn('project gap-0 py-0 transition-[border-color,box-shadow] hover:shadow-md', waiting > 0 && 'border-amber-500/50')} data-project={project.repoRoot}>
          <Collapsible open={open.value} onUpdate:open={(value: boolean) => (open.value = value)}>
            <div class="grid cursor-pointer gap-2 p-4" onClick={openPage}>
              <div class="flex items-start gap-2">
                <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <Emoji symbol={EMOJI.repository} class="mr-0" />
                  <a class="truncate font-semibold hover:underline" {...linkTo(projectHref(project.repoRoot))}>
                    {projectName(project.repoRoot)}
                  </a>
                  {!project.exists && (
                    <StatusBadge tone="warn" emoji={EMOJI.warning} title="The directory no longer exists on disk">
                      missing
                    </StatusBadge>
                  )}
                  {waiting > 0 && <WaitingMarker />}
                </div>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="icon-sm" class="-mt-1 -mr-2 [&[data-state=open]>svg]:rotate-180" aria-label={open.value ? `Fold ${projectName(project.repoRoot)}` : `Unfold ${projectName(project.repoRoot)}`} data-expand>
                    <ChevronDown class="transition-transform duration-200" />
                  </Button>
                </CollapsibleTrigger>
              </div>
              <code class="text-muted-foreground font-mono text-xs break-all">{project.repoRoot}</code>
              {project.note !== null && project.note !== '' && <p class="text-muted-foreground text-xs">{project.note}</p>}
              <p class="flex flex-wrap gap-x-1.5 text-xs">
                <span class={project.openTasks > 0 ? 'font-medium' : 'text-muted-foreground'}>
                  {project.openTasks} of {project.tasks} task(s) open
                </span>
                {waiting > 0 && <span class={ATTENTION}>· {waiting} waiting for you</span>}
                <span class="text-muted-foreground">· {project.lastActivityAt === null ? 'no activity yet' : `last activity ${formatTime(project.lastActivityAt)}`}</span>
              </p>
              {profile !== null && stackText(profile, 3) !== '' && <p class="text-muted-foreground truncate text-xs">{stackText(profile, 3)}</p>}
            </div>
            <CollapsibleContent>
              <div class="border-t p-4">
                <Facts class="gap-x-4 text-xs sm:text-sm">
                  <Fact label="Commands">{profile === null ? <span class="text-muted-foreground">not scanned yet</span> : <ProfileCommands profile={profile} />}</Fact>
                  {profile !== null && <Fact label="CI">{profile.ci.length === 0 ? 'none found' : profile.ci.map((entry) => entry.path).join(', ')}</Fact>}
                  {review !== null && <Fact label="Review">{review}</Fact>}
                  {stored !== undefined && (
                    <Fact label="Data">
                      {stored.tasks} task(s), {stored.events} event(s) stored
                    </Fact>
                  )}
                  <Fact label="Added">
                    {formatTime(project.addedAt)} · {ADDED_BY[project.addedBy] ?? project.addedBy}
                  </Fact>
                </Facts>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      );
    };
  },
});

/**
 * The repositories the user added, as tiles. JERRY monitors only these; elsewhere only the hard rules
 * apply. Adding is a decision: the repository root is typed, as in the CLI.
 */
export const ProjectsCard = defineComponent({
  name: 'ProjectsCard',
  props: { usage: { type: Object as PropType<DataUsage | null>, default: null } },
  setup(props) {
    const actions = useProjectActions();
    return () => (
      <Card class="projects">
        <CardHeader>
          <CardTitle class="flex items-center">
            <Emoji symbol={EMOJI.repository} />
            Projects
          </CardTitle>
          <CardDescription>JERRY monitors only the repositories added here. Everywhere else only the hard rules apply: no Git changes, no writes inside .git, no tampering with JERRY.</CardDescription>
          <CardAction>
            <Button size="sm" onClick={actions.askPath}>
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
            <div class="project-grid grid grid-cols-1 items-start gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {state.projects.map((project) => (
                <ProjectTile key={project.repoRoot} project={project} usage={props.usage} />
              ))}
            </div>
          )}
        </CardContent>
        {actions.dialogs()}
      </Card>
    );
  },
});
