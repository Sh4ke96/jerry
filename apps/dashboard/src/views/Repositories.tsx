import { defineComponent, ref } from 'vue';
import { api } from '../api';
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

    return () => (
      <div class="stack">
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
