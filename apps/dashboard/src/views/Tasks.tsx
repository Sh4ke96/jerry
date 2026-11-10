import type { ArtifactDecision, Workspace } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { ChevronDown, FolderGit2, Search } from '@lucide/vue';
import { computed, defineComponent, onMounted, reactive, ref } from 'vue';
import { api } from '../api';
import { Emoji } from '../components/Emoji';
import { ArtifactsList } from '../components/FinalReport';
import { TaskTile } from '../components/TaskTile';
import { Button } from '../components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { FilterTabs } from '../components/FilterTabs';
import { CHIP } from '../lib/classes';
import { insideRoot, projectName, TASK_FILTERS, taskTouches, type TaskFilter } from '../lib/tasks';
import { handleError, state } from '../state';

/** All projects in the project filter. */
const ANY_PROJECT = '*';
/** A workspace in the project filter: "workspace:<id>". */
const WORKSPACE_PREFIX = 'workspace:';

/** The filters outlive the view: back from a task page, the list looks as it was left. */
export const taskFilters = reactive<{ filter: TaskFilter; project: string; search: string }>({ filter: 'active', project: ANY_PROJECT, search: '' });

/** The tasks as full-width bars, one per row, filtered at the top by state, project and a search. */
export const Tasks = defineComponent({
  name: 'Tasks',
  setup() {
    const artifacts = ref<ArtifactDecision[]>([]);
    onMounted(() => void api.artifacts().then((list) => (artifacts.value = list), handleError));

    const workspaces = ref<Workspace[]>([]);
    onMounted(() => void api.workspaces().then((list) => (workspaces.value = list), () => undefined));
    const chosenWorkspace = computed(() => (taskFilters.project.startsWith(WORKSPACE_PREFIX) ? workspaces.value.find((workspace) => `${WORKSPACE_PREFIX}${workspace.id}` === taskFilters.project) : undefined));

    const newestFirst = computed(() => [...state.tasks].reverse());
    const inProject = computed(() => {
      if (taskFilters.project === ANY_PROJECT) return newestFirst.value;
      // A workspace: the tasks of any of its repositories.
      if (taskFilters.project.startsWith(WORKSPACE_PREFIX)) {
        const repos = chosenWorkspace.value?.repos ?? [];
        return newestFirst.value.filter((task) => repos.some((repo) => taskTouches(task, repo.repoRoot)));
      }
      // Its own tasks and tasks across several repositories that cover it.
      return newestFirst.value.filter((task) => taskTouches(task, taskFilters.project));
    });
    const searched = computed(() => {
      const query = taskFilters.search.trim().toLowerCase();
      return query === '' ? inProject.value : inProject.value.filter((task) => task.taskId.toLowerCase().includes(query) || task.title.toLowerCase().includes(query));
    });
    const count = (filter: TaskFilter): number => searched.value.filter(TASK_FILTERS.find((entry) => entry.id === filter)!.matches).length;
    const shown = computed(() => searched.value.filter(TASK_FILTERS.find((entry) => entry.id === taskFilters.filter)!.matches));
    /** Projects, and the other repositories that have tasks. */
    const roots = computed(() => {
      const list = state.projects.map((project) => project.repoRoot);
      for (const task of state.tasks) if (!list.some((root) => insideRoot(task.repoRoot, root))) list.push(task.repoRoot);
      return list;
    });

    const projectFilter = () => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" class="project-filter max-w-full" data-project-filter>
            <FolderGit2 />
            <span class="truncate">{taskFilters.project === ANY_PROJECT ? 'All projects' : taskFilters.project.startsWith(WORKSPACE_PREFIX) ? (chosenWorkspace.value?.name ?? 'Workspace') : projectName(taskFilters.project)}</span>
            <ChevronDown class="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-64">
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup modelValue={taskFilters.project} onUpdate:modelValue={(value: string) => (taskFilters.project = value)}>
            <DropdownMenuRadioItem value={ANY_PROJECT}>All projects</DropdownMenuRadioItem>
            {workspaces.value.length > 0 && <DropdownMenuLabel class="text-muted-foreground text-xs font-normal">Workspaces</DropdownMenuLabel>}
            {workspaces.value.map((workspace) => (
              <DropdownMenuRadioItem key={`workspace-${workspace.id}`} value={`${WORKSPACE_PREFIX}${workspace.id}`} data-workspace-filter={workspace.name}>
                <span class="truncate">{workspace.name}</span>
              </DropdownMenuRadioItem>
            ))}
            {workspaces.value.length > 0 && <DropdownMenuLabel class="text-muted-foreground text-xs font-normal">Projects</DropdownMenuLabel>}
            {roots.value.map((root) => (
              <DropdownMenuRadioItem key={root} value={root} title={root}>
                <span class="truncate">{projectName(root)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const empty = () => {
      if (state.tasks.length === 0) {
        return (
          <Card>
            <CardHeader>
              <CardTitle class="flex items-center">
                <Emoji symbol={EMOJI.task} />
                No tasks yet
              </CardTitle>
              <CardDescription>
                Ask Claude for a plan with <code class={CHIP}>/jerry:plan</code>, or create one with <code class={CHIP}>jerry task create --repo &lt;path&gt; --title &lt;text&gt; --scope &lt;glob&gt;</code>.
              </CardDescription>
            </CardHeader>
          </Card>
        );
      }
      return <p class="tasks-empty text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">No task matches these filters.</p>;
    };

    return () => (
      <div class="flex flex-col gap-4 md:gap-6">
        <div class="flex flex-col gap-3">
          <FilterTabs
            class="task-filters"
            label="Filter tasks"
            marker="filter"
            modelValue={taskFilters.filter}
            tabs={TASK_FILTERS.map((option) => ({ value: option.id, label: option.label, count: count(option.id) }))}
            onUpdate:modelValue={(value: string) => (taskFilters.filter = value as TaskFilter)}
          />
          <div class="flex flex-wrap items-center gap-2">
            {projectFilter()}
            <div class="relative w-full max-w-xs">
              <Search class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <Input type="search" class="task-search h-8 pl-8" placeholder="Search ID or title" aria-label="Search tasks by ID or title" modelValue={taskFilters.search} onUpdate:modelValue={(value: string) => (taskFilters.search = value)} />
            </div>
          </div>
        </div>
        {shown.value.length === 0 ? (
          empty()
        ) : (
          <div class="task-grid grid grid-cols-1 gap-3">
            {shown.value.map((task) => (
              <TaskTile key={task.taskId} task={task} />
            ))}
          </div>
        )}
        <ArtifactsList decisions={artifacts.value} />
      </div>
    );
  },
});
