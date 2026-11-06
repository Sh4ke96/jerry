import { computed, defineComponent, ref } from 'vue';
import { taskStatus } from './format';
import { signOut, state } from './state';
import { Overview } from './views/Overview';
import { Repositories } from './views/Repositories';
import { Tasks } from './views/Tasks';
import { Timeline } from './views/Timeline';

type Tab = 'overview' | 'tasks' | 'timeline' | 'repositories';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Plans' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'repositories', label: 'Repositories' },
];

export const App = defineComponent({
  name: 'App',
  setup() {
    const tab = ref<Tab>('overview');
    const waiting = computed(() => state.tasks.filter((task) => taskStatus(task) === 'WAITING').length);

    const view = () => {
      switch (tab.value) {
        case 'overview':
          return <Overview onNavigate={(target: Tab) => (tab.value = target)} />;
        case 'tasks':
          return <Tasks />;
        case 'timeline':
          return <Timeline />;
        case 'repositories':
          return <Repositories />;
      }
    };

    return () => {
      if (state.phase === 'loading') return <div class="centered muted">Connecting to JERRY Core…</div>;
      if (state.phase === 'signed-out') {
        return (
          <div class="centered">
            <div class="panel narrow">
              <h1>JERRY Control Center</h1>
              <p>The dashboard session ended. Run <code>jerry ui</code> in a terminal to open it again.</p>
            </div>
          </div>
        );
      }
      if (state.phase === 'error') {
        return (
          <div class="centered">
            <div class="panel narrow">
              <h1>JERRY Control Center</h1>
              <p>JERRY Core did not answer: {state.error}</p>
            </div>
          </div>
        );
      }
      return (
        <div class="app">
          <header class="topbar">
            <div class="brand">
              <img src="/icons/icon.svg" alt="" width="28" height="28" />
              <span>JERRY</span>
            </div>
            <nav class="tabs" aria-label="Sections">
              {TABS.map((item) => (
                <button key={item.id} class={['tab', tab.value === item.id && 'tab--active']} aria-current={tab.value === item.id ? 'page' : undefined} onClick={() => (tab.value = item.id)}>
                  {item.label}
                  {item.id === 'tasks' && waiting.value > 0 && <span class="count">{waiting.value}</span>}
                </button>
              ))}
            </nav>
            <button class="button button--quiet" onClick={() => void signOut()}>
              Sign out
            </button>
          </header>
          {state.notice !== null && (
            <div class="notice" role="status">
              <span>{state.notice}</span>
              <button class="button button--quiet" aria-label="Dismiss" onClick={() => (state.notice = null)}>
                ×
              </button>
            </div>
          )}
          <main class="content">{view()}</main>
        </div>
      );
    };
  },
});
