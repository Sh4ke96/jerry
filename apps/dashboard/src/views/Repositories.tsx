import type { RepositorySummary } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent } from 'vue';
import { api } from '../api';
import { Emoji } from '../components/Emoji';
import { Fact, Facts } from '../components/Facts';
import { ProjectsCard } from '../components/ProjectsCard';
import { StatusBadge } from '../components/StatusBadge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatTime } from '../format';
import { ATTENTION } from '../lib/classes';
import { perform, state } from '../state';

/** Not a project the user added (an older Core only says whether it is excluded). */
function notAdded(repository: RepositorySummary): boolean {
  return repository.project === undefined ? repository.excluded : !repository.project;
}

export const Repositories = defineComponent({
  name: 'Repositories',
  setup() {
    const rescan = (repoRoot: string): Promise<boolean> => perform(() => api.scanRepository(repoRoot), `Rescanned ${repoRoot}.`);

    const profileCard = (repository: RepositorySummary) => {
      const profile = repository.profile;
      return (
        <Card class="repository" key={repository.repoRoot}>
          <CardHeader>
            <CardTitle class="flex min-w-0 items-center">
              <Emoji symbol={EMOJI.repository} />
              <code class="truncate font-mono text-sm">{repository.repoRoot}</code>
              {notAdded(repository) && (
                <StatusBadge class="ml-2" title="Not a project: JERRY does not monitor it">
                  not added
                </StatusBadge>
              )}
            </CardTitle>
            <CardDescription>
              {repository.openTasks} open task(s){notAdded(repository) && ' · not added — only hard rules apply'}
              {profile !== null && ` · scanned ${formatTime(profile.scannedAt)}`}
              {profile !== null && profile.stale.length > 0 && <span class={ATTENTION}> · out of date: {profile.stale.join(', ')}</span>}
            </CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" onClick={() => rescan(repository.repoRoot)}>
                {profile === null ? 'Scan' : 'Rescan'}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {profile === null ? (
              <p class="text-muted-foreground text-sm">Not scanned yet. JERRY scans a repository when a Claude Code session starts in it.</p>
            ) : (
              <Facts>
                <Fact label="Stack">{[...profile.languages.slice(0, 5).map((language) => language.name), ...profile.frameworks.map((framework) => framework.name)].join(', ') || 'unknown'}</Fact>
                <Fact label="Commands">
                  {profile.commands.length === 0 ? (
                    'none found'
                  ) : (
                    <div class="grid gap-1">
                      {profile.commands.map((command) => (
                        <div key={`${command.kind}${command.run}`} class="flex flex-wrap items-center gap-2">
                          <StatusBadge>{command.kind}</StatusBadge> <code class="font-mono text-xs">{command.run}</code>
                        </div>
                      ))}
                    </div>
                  )}
                  {profile.environment.missingRunners.length > 0 && (
                    <div class={['mt-1', ATTENTION]}>
                      <Emoji symbol={EMOJI.warning} />
                      Not installed: {profile.environment.missingRunners.join(', ')}
                    </div>
                  )}
                </Fact>
                {profile.ci.length > 0 && <Fact label="CI">{profile.ci.map((entry) => entry.path).join(', ')}</Fact>}
                {profile.apiSchemas.length > 0 && <Fact label="API schemas">{profile.apiSchemas.map((entry) => `${entry.path} (${entry.kind})`).join(', ')}</Fact>}
                {profile.migrations.length > 0 && <Fact label="Migrations">{profile.migrations.map((entry) => `${entry.path} (${entry.kind}, ${entry.files})`).join(', ')}</Fact>}
                <Fact label="Docs">{profile.docs.length} indexed</Fact>
                <Fact label="Instructions">
                  {profile.instructions.length === 0
                    ? 'none'
                    : profile.instructions.map((entry) => (
                        <div key={entry.path}>
                          <code class="font-mono text-xs">{entry.path}</code> <span class="text-muted-foreground">{entry.role}</span>
                          {entry.notes.length > 0 && <span class={ATTENTION}> · {entry.notes.join('; ')}</span>}
                        </div>
                      ))}
                </Fact>
                <Fact label="Suspicious text">
                  {profile.injection.findings.length === 0 ? (
                    'none found'
                  ) : (
                    <ul class="grid gap-1.5">
                      {profile.injection.findings.slice(0, 20).map((finding) => (
                        <li key={`${finding.path}:${finding.line}`} class="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <code class="font-mono text-xs">
                            {finding.path}:{finding.line}
                          </code>{' '}
                          <StatusBadge tone="warn" emoji={EMOJI.warning}>
                            {finding.rule}
                          </StatusBadge>{' '}
                          <span class="text-muted-foreground">{finding.excerpt}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Fact>
              </Facts>
            )}
          </CardContent>
        </Card>
      );
    };

    return () => (
      <div class="flex flex-col gap-4 md:gap-6">
        <ProjectsCard />
        {state.graph.edges.length > 0 && (
          <Card>
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
                  {state.graph.edges.map((edge) => (
                    <TableRow key={`${edge.from}|${edge.to}|${edge.kind}`}>
                      <TableCell class="font-mono text-xs">{edge.from}</TableCell>
                      <TableCell class="font-mono text-xs">→ {edge.to}</TableCell>
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
        )}
        {state.repositories.map(profileCard)}
      </div>
    );
  },
});
