import { EMOJI } from '@jerry/contracts/emoji';
import { ArrowLeft, Plus } from '@lucide/vue';
import { computed, defineComponent, ref } from 'vue';
import { api } from '../api';
import { Emoji } from '../components/Emoji';
import { Fact, Facts } from '../components/Facts';
import { useForget } from '../components/ForgetRepository';
import { ADDED_BY, reviewModeText, useProjectActions } from '../components/ProjectsCard';
import { RepositoryProfileFacts } from '../components/RepositoryProfile';
import { Segmented } from '../components/Segmented';
import { StatusBadge } from '../components/StatusBadge';
import { TaskTile } from '../components/TaskTile';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatTime, isOpen } from '../format';
import { ATTENTION } from '../lib/classes';
import { insideRoot, projectName, repositoryOf, sameRoot, tasksOf } from '../lib/tasks';
import { linkTo, navigate, projectHref } from '../router';
import { projectOwnReviewMode, REVIEW_MODE_LABEL, type ProjectReviewMode } from '../settings';
import { perform, refresh, state } from '../state';
import { useDataUsage } from './Projects';

const INHERIT = 'inherit';

const REVIEW_OPTIONS = [
  { value: INHERIT, label: 'Inherit' },
  { value: 'optional', label: 'Optional' },
  { value: 'required', label: 'Required' },
];

/** One project (or another repository JERRY has seen): its profile, tasks, links, data and settings. */
export const ProjectPage = defineComponent({
  name: 'ProjectPage',
  props: { repoRoot: { type: String, required: true } },
  setup(props) {
    const { usage, load } = useDataUsage();
    const project = computed(() => state.projects.find((candidate) => sameRoot(candidate.repoRoot, props.repoRoot)));
    const repository = computed(() => repositoryOf(props.repoRoot, state.repositories));
    /** The root as Core spells it. */
    const root = computed(() => project.value?.repoRoot ?? repository.value?.repoRoot ?? props.repoRoot);
    const actions = useProjectActions(() => undefined);
    const forgetting = useForget(async () => {
      await load();
      navigate({ section: 'projects' });
    });
    const saving = ref(false);
    const reviewError = ref<string | null>(null);

    const setReview = async (value: string): Promise<void> => {
      const current = project.value;
      if (current === undefined) return;
      const mode: ProjectReviewMode = value === 'optional' || value === 'required' ? value : null;
      saving.value = true;
      reviewError.value = null;
      try {
        await api.setProjectReviewMode(current.repoRoot, mode);
        state.notice = mode === null ? `Review for ${projectName(current.repoRoot)} follows Settings again.` : `Review for ${projectName(current.repoRoot)} is ${mode} now.`;
        await refresh();
      } catch (error) {
        reviewError.value = error instanceof Error ? error.message : String(error);
      } finally {
        saving.value = false;
      }
    };

    const rescan = (): Promise<boolean> => perform(() => api.scanRepository(root.value), `Rescanned ${root.value}.`);

    const header = () => {
      const current = project.value;
      return (
        <Card class="project-page__header gap-4">
          <CardHeader>
            <CardTitle class="flex flex-wrap items-center gap-2 text-xl">
              <Emoji symbol={EMOJI.repository} class="mr-0" />
              {projectName(root.value)}
              {current === undefined ? <StatusBadge title="Not a project: JERRY does not monitor it">not added</StatusBadge> : <StatusBadge tone="pass">project</StatusBadge>}
              {current !== undefined && !current.exists && (
                <StatusBadge tone="warn" emoji={EMOJI.warning} title="The directory no longer exists on disk">
                  missing
                </StatusBadge>
              )}
            </CardTitle>
            <CardDescription class="grid gap-1">
              <code class="font-mono text-xs break-all">{root.value}</code>
              {current !== undefined ? (
                <span>
                  {current.openTasks} of {current.tasks} task(s) open · added {formatTime(current.addedAt)} {ADDED_BY[current.addedBy] ?? current.addedBy}
                  {current.lastActivityAt !== null && ` · last activity ${formatTime(current.lastActivityAt)}`}
                </span>
              ) : (
                <span class={ATTENTION}>Not a project: only the hard rules apply here.</span>
              )}
              {current?.note != null && current.note !== '' && <span>{current.note}</span>}
            </CardDescription>
            <CardAction class="flex flex-wrap justify-end gap-2">
              {current === undefined ? (
                <Button size="sm" onClick={() => actions.addRoot(root.value)}>
                  <Plus />
                  Add project
                </Button>
              ) : (
                <Button variant="ghost" size="sm" class="text-destructive hover:text-destructive" onClick={() => actions.askRemove(current)}>
                  Remove
                </Button>
              )}
            </CardAction>
          </CardHeader>
        </Card>
      );
    };

    const reviewCard = () => {
      const current = project.value;
      if (current === undefined) return null;
      const own = projectOwnReviewMode(current);
      const text = reviewModeText(current);
      return (
        <Card class="project-review">
          <CardHeader>
            <CardTitle class="flex items-center">
              <Emoji symbol={EMOJI.review} />
              Review
            </CardTitle>
            <CardDescription>Whether accepted work in this project goes to the independent review. Inherit follows the global setting{state.settings !== null && ` (${REVIEW_MODE_LABEL[state.settings.reviewMode].toLowerCase()})`}.</CardDescription>
          </CardHeader>
          <CardContent class="grid gap-3">
            <Segmented label="Review for this project" options={REVIEW_OPTIONS} modelValue={own === null || own === undefined ? INHERIT : own} disabled={own === undefined || saving.value} onUpdate:modelValue={(value: string) => void setReview(value)} />
            {own === undefined ? <p class="text-muted-foreground text-xs">This JERRY Core has no review setting per project.</p> : text !== null && <p class="text-muted-foreground text-xs">Now: {text}.</p>}
            {reviewError.value !== null && (
              <Alert variant="destructive">
                <AlertDescription>
                  <p>
                    <Emoji symbol={EMOJI.fail} />
                    The setting was not saved: {reviewError.value}
                  </p>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      );
    };

    const profileCard = () => {
      const profile = repository.value?.profile ?? null;
      return (
        <Card class="repository-profile">
          <CardHeader>
            <CardTitle class="flex items-center">
              <Emoji symbol={EMOJI.analysis} />
              Profile
            </CardTitle>
            <CardDescription>
              What JERRY detected in the repository{profile !== null && `, scanned ${formatTime(profile.scannedAt)}`}
              {profile !== null && profile.stale.length > 0 && <span class={ATTENTION}> · out of date: {profile.stale.join(', ')}</span>}
            </CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => void rescan()}>
                {profile === null ? 'Scan' : 'Rescan'}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>{profile === null ? <p class="text-muted-foreground text-sm">Not scanned yet. JERRY scans a repository when a Claude Code session starts in it.</p> : <RepositoryProfileFacts profile={profile} />}</CardContent>
        </Card>
      );
    };

    const tasksCard = () => {
      const tasks = [...tasksOf(root.value, state.tasks)].reverse();
      const open = tasks.filter(isOpen);
      return (
        <Card class="project-tasks">
          <CardHeader>
            <CardTitle class="flex items-center">
              <Emoji symbol={EMOJI.task} />
              Tasks
            </CardTitle>
            <CardDescription>
              {open.length} open of {tasks.length}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {tasks.length === 0 ? (
              <p class="text-muted-foreground text-sm">No tasks in this repository yet.</p>
            ) : (
              <div class="task-grid grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                {tasks.map((task) => (
                  <TaskTile key={task.taskId} task={task} hideProject />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      );
    };

    const linksCard = () => {
      const edges = state.graph.edges.filter((edge) => insideRoot(edge.from, root.value) || insideRoot(edge.to, root.value));
      if (edges.length === 0) return null;
      return (
        <Card class="project-links">
          <CardHeader>
            <CardTitle class="flex items-center">
              <Emoji symbol={EMOJI.repository} />
              Links between repositories
            </CardTitle>
            <CardDescription>From manifests and code-generation configs; each link shows its evidence.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {edges.map((edge) => (
                  <TableRow key={`${edge.from}|${edge.to}|${edge.kind}`}>
                    <TableCell class="font-mono text-xs">
                      <a class="hover:underline" {...linkTo(projectHref(edge.from))}>
                        {edge.from}
                      </a>
                    </TableCell>
                    <TableCell class="font-mono text-xs">
                      →{' '}
                      <a class="hover:underline" {...linkTo(projectHref(edge.to))}>
                        {edge.to}
                      </a>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone="accent">{edge.kind}</StatusBadge>
                    </TableCell>
                    <TableCell class="text-muted-foreground whitespace-normal">{edge.evidence}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      );
    };

    const dataCard = () => {
      const stored = usage.value?.projects.find((entry) => sameRoot(entry.repoRoot, root.value));
      return (
        <Card class="project-data">
          <CardHeader>
            <CardTitle class="flex items-center">
              <Emoji symbol={EMOJI.checkpoint} />
              Data
            </CardTitle>
            <CardDescription>What JERRY stores about this repository. Forgetting deletes all of it after a backup; the repository itself is not touched.</CardDescription>
            {stored !== undefined && <CardAction>{forgetting.forgetButton(stored.repoRoot, stored.openTasks)}</CardAction>}
          </CardHeader>
          <CardContent>
            {usage.value === null ? (
              <p class="text-muted-foreground text-sm">Loading…</p>
            ) : stored === undefined ? (
              <p class="text-muted-foreground text-sm">JERRY stores nothing about this repository.</p>
            ) : (
              <Facts>
                <Fact label="Tasks">
                  {stored.tasks} ({stored.openTasks} open)
                </Fact>
                <Fact label="Events">{stored.events}</Fact>
                <Fact label="Last activity">{stored.lastActivityAt === null ? 'none' : formatTime(stored.lastActivityAt)}</Fact>
              </Facts>
            )}
          </CardContent>
        </Card>
      );
    };

    return () => {
      if (project.value === undefined && repository.value === undefined && tasksOf(props.repoRoot, state.tasks).length === 0) {
        return (
          <div class="flex flex-col gap-4">
            {forgetting.result()}
            <Card class="project-missing">
              <CardHeader>
                <CardTitle>No project or repository at {props.repoRoot}</CardTitle>
                <CardDescription>It may have been removed or forgotten, or the address is mistyped.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" size="sm" as="a" {...linkTo({ section: 'projects' })}>
                  <ArrowLeft />
                  All projects
                </Button>
              </CardContent>
            </Card>
          </div>
        );
      }
      return (
        <div class="project-page flex flex-col gap-4 md:gap-6" data-project={root.value}>
          {header()}
          {forgetting.result()}
          {reviewCard()}
          {tasksCard()}
          {profileCard()}
          {linksCard()}
          {dataCard()}
          {actions.dialogs()}
          {forgetting.dialog()}
        </div>
      );
    };
  },
});
