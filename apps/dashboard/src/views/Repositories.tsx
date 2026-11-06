import type { RepositorySummary } from '@jerry/contracts';
import { defineComponent, ref } from 'vue';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { formatTime } from '../format';
import { perform, state } from '../state';

export const Repositories = defineComponent({
  name: 'Repositories',
  setup() {
    const path = ref('');
    const confirming = ref(false);
    const busy = ref(false);

    const exclude = async (typed: string): Promise<void> => {
      busy.value = true;
      const done = await perform(() => api.setExcluded(path.value.trim(), true, typed), `JERRY no longer monitors ${path.value.trim()}. Hard rules still apply there.`);
      busy.value = false;
      if (done) {
        confirming.value = false;
        path.value = '';
      }
    };

    const rescan = (repoRoot: string): Promise<boolean> => perform(() => api.scanRepository(repoRoot), `Rescanned ${repoRoot}.`);

    const profileCard = (repository: RepositorySummary) => {
      const profile = repository.profile;
      return (
        <article class="panel repository" key={repository.repoRoot}>
          <header class="task__header">
            <div>
              <h2>
                <code>{repository.repoRoot}</code>
              </h2>
              <p class="muted">
                {repository.openTasks} open task(s){repository.excluded && ' · excluded from monitoring'}
                {profile !== null && ` · scanned ${formatTime(profile.scannedAt)}`}
                {profile !== null && profile.stale.length > 0 && <span class="attention"> · out of date: {profile.stale.join(', ')}</span>}
              </p>
            </div>
            <button class="button" onClick={() => rescan(repository.repoRoot)}>
              {profile === null ? 'Scan' : 'Rescan'}
            </button>
          </header>
          {profile === null ? (
            <p class="muted">Not scanned yet. JERRY scans a repository when a Claude Code session starts in it.</p>
          ) : (
            <dl class="facts">
              <dt>Stack</dt>
              <dd>{[...profile.languages.slice(0, 5).map((language) => language.name), ...profile.frameworks.map((framework) => framework.name)].join(', ') || 'unknown'}</dd>
              <dt>Commands</dt>
              <dd>
                {profile.commands.length === 0
                  ? 'none found'
                  : profile.commands.map((command) => (
                      <div key={`${command.kind}${command.run}`}>
                        <Badge>{command.kind}</Badge> <code>{command.run}</code>
                      </div>
                    ))}
                {profile.environment.missingRunners.length > 0 && <div class="attention">Not installed: {profile.environment.missingRunners.join(', ')}</div>}
              </dd>
              {profile.ci.length > 0 && [<dt key="ci">CI</dt>, <dd key="ci-v">{profile.ci.map((entry) => entry.path).join(', ')}</dd>]}
              {profile.apiSchemas.length > 0 && [<dt key="api">API schemas</dt>, <dd key="api-v">{profile.apiSchemas.map((entry) => `${entry.path} (${entry.kind})`).join(', ')}</dd>]}
              {profile.migrations.length > 0 && [<dt key="mig">Migrations</dt>, <dd key="mig-v">{profile.migrations.map((entry) => `${entry.path} (${entry.kind}, ${entry.files})`).join(', ')}</dd>]}
              <dt>Docs</dt>
              <dd>{profile.docs.length} indexed</dd>
              <dt>Instructions</dt>
              <dd>
                {profile.instructions.length === 0
                  ? 'none'
                  : profile.instructions.map((entry) => (
                      <div key={entry.path}>
                        <code>{entry.path}</code> <span class="muted">{entry.role}</span>
                        {entry.notes.length > 0 && <span class="attention"> · {entry.notes.join('; ')}</span>}
                      </div>
                    ))}
              </dd>
              <dt>Suspicious text</dt>
              <dd>
                {profile.injection.findings.length === 0 ? (
                  'none found'
                ) : (
                  <ul class="list small">
                    {profile.injection.findings.slice(0, 20).map((finding) => (
                      <li key={`${finding.path}:${finding.line}`}>
                        <code>
                          {finding.path}:{finding.line}
                        </code>{' '}
                        <Badge tone="warn">{finding.rule}</Badge> <span class="muted">{finding.excerpt}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          )}
        </article>
      );
    };

    return () => (
      <div class="stack">
        {state.graph.edges.length > 0 && (
          <section class="panel">
            <h2>Links between repositories</h2>
            <p class="muted small">From manifests and code-generation configs; each link shows its evidence.</p>
            <ul class="list">
              {state.graph.edges.map((edge) => (
                <li key={`${edge.from}|${edge.to}|${edge.kind}`}>
                  <code>{edge.from}</code> → <code>{edge.to}</code> <Badge tone="accent">{edge.kind}</Badge> <span class="muted small">{edge.evidence}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {state.repositories.map(profileCard)}
        <section class="panel">
          <h2>Monitored repositories</h2>
          <p class="muted">JERRY monitors every Git repository except the ones below. Hard rules (no Git changes, no writes inside .git, no tampering with JERRY) apply everywhere.</p>
          {state.exclusions.length === 0 ? (
            <p>No repository is excluded.</p>
          ) : (
            <ul class="list">
              {state.exclusions.map((exclusion) => (
                <li key={exclusion.repoRoot} class="row">
                  <span>
                    <code>{exclusion.repoRoot}</code> <span class="muted">excluded {formatTime(exclusion.excludedAt)}</span>
                  </span>
                  <button class="button" onClick={() => perform(() => api.setExcluded(exclusion.repoRoot, false), `JERRY monitors ${exclusion.repoRoot} again.`)}>
                    Monitor again
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section class="panel">
          <h2>Exclude a repository</h2>
          <form
            class="inline-form"
            onSubmit={(event: Event) => {
              event.preventDefault();
              if (path.value.trim() !== '') confirming.value = true;
            }}
          >
            <input class="grow" aria-label="Repository path" placeholder={'D:\\Projects\\my-repo'} value={path.value} onInput={(event: Event) => (path.value = (event.target as HTMLInputElement).value)} />
            <button class="button" type="submit" disabled={path.value.trim() === ''}>
              Exclude…
            </button>
          </form>
        </section>

        {confirming.value && (
          <ConfirmDialog title="Stop monitoring this repository?" expected="exclude" confirmLabel="Exclude repository" tone="danger" busy={busy.value} onConfirm={exclude} onCancel={() => (confirming.value = false)}>
            <p>
              <code>{path.value.trim()}</code>
            </p>
            <p class="muted small">Edits there will no longer be checked against plans. Hard rules stay in force.</p>
          </ConfirmDialog>
        )}
      </div>
    );
  },
});
