import type { DataUsage, RepositorySummary } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { Plus } from '@lucide/vue';
import { defineComponent, onMounted, ref } from 'vue';
import { api, SignedOutError } from '../api';
import { Emoji } from '../components/Emoji';
import { ProjectsCard, useProjectActions } from '../components/ProjectsCard';
import { stackText } from '../components/RepositoryProfile';
import { StatusBadge } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { formatTime } from '../format';
import { ATTENTION } from '../lib/classes';
import { projectName } from '../lib/tasks';
import { linkTo, projectHref } from '../router';
import { handleError, state } from '../state';

/** Not a project the user added (an older Core only says whether it is excluded). */
export function notAdded(repository: RepositorySummary): boolean {
  return repository.project === undefined ? repository.excluded : !repository.project;
}

/** What JERRY stores per repository, for the tiles; the view works without it. */
export function useDataUsage() {
  const usage = ref<DataUsage | null>(null);
  const load = async (): Promise<void> => {
    try {
      usage.value = await api.dataUsage();
    } catch (error) {
      if (error instanceof SignedOutError) handleError(error);
    }
  };
  onMounted(() => void load());
  return { usage, load };
}

/** The projects as tiles, and the other repositories JERRY has seen, each with a way to add it. */
export const Projects = defineComponent({
  name: 'Projects',
  setup() {
    const { usage } = useDataUsage();
    const actions = useProjectActions();

    const other = (repository: RepositorySummary) => {
      const profile = repository.profile;
      return (
        <li key={repository.repoRoot} class="repository flex flex-wrap items-center gap-x-3 gap-y-2 py-3" data-repository={repository.repoRoot}>
          <div class="grid min-w-0 flex-1 gap-0.5">
            <div class="flex flex-wrap items-center gap-2">
              <a class="font-medium hover:underline" {...linkTo(projectHref(repository.repoRoot))}>
                {projectName(repository.repoRoot)}
              </a>
              <StatusBadge title="Not a project: JERRY does not monitor it">not added</StatusBadge>
            </div>
            <code class="text-muted-foreground font-mono text-xs break-all">{repository.repoRoot}</code>
            <p class="text-muted-foreground text-xs">
              {repository.openTasks} open task(s) · not added — only hard rules apply
              {profile !== null && ` · scanned ${formatTime(profile.scannedAt)}`}
              {profile !== null && stackText(profile, 3) !== '' && ` · ${stackText(profile, 3)}`}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => actions.addRoot(repository.repoRoot)}>
            <Plus />
            Add project
          </Button>
        </li>
      );
    };

    return () => {
      const others = state.repositories.filter(notAdded);
      return (
        <div class="flex flex-col gap-4 md:gap-6">
          <ProjectsCard usage={usage.value} />
          {others.length > 0 && (
            <Card class="other-repositories">
              <CardHeader>
                <CardTitle class="flex items-center">
                  <Emoji symbol={EMOJI.repository} />
                  Other repositories
                </CardTitle>
                <CardDescription>
                  Claude Code worked here, but they are not projects: <span class={ATTENTION}>JERRY checks only its hard rules there</span>. Add one to have its edits checked against approved plans.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul class="divide-y">{others.map(other)}</ul>
              </CardContent>
            </Card>
          )}
          {actions.dialogs()}
        </div>
      );
    };
  },
});
