// @vitest-environment happy-dom
import type { DataUsage, ForgetPreview, PrunePreview, ProjectSummary, RepositorySummary, TaskSummary } from '@jerry/contracts';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { theme } from '../src/lib/theme';
import { route } from '../src/router';
import type { WorkflowSettings } from '../src/settings';
import { startDashboard, state } from '../src/state';

const CSRF = 'c'.repeat(64);
const NOW = new Date().toISOString();
const SHOP = 'D:\\Work\\shop';
const SITE = 'D:\\Old\\site';

const shopProject: ProjectSummary = { repoRoot: SHOP, addedAt: NOW, addedBy: 'dashboard', note: null, reviewMode: null, effectiveReviewMode: 'optional', tasks: 5, openTasks: 4, lastActivityAt: NOW, exists: true };
const shopTask = (taskId: string, title: string, taskState: TaskSummary['state']): TaskSummary => ({
  taskId,
  title,
  repoRoot: SHOP,
  createdAt: NOW,
  state: taskState,
  plan: { version: 1, contentHash: `sha256:${'a'.repeat(64)}`, scope: ['src/**'], createdAt: NOW },
  planDecision: null,
  activity: { sessionCount: 0, lastSessionId: null, lastActivityAt: null, lastSessionEndedAt: null },
  lastCheckpoint: null,
  lastReport: null,
  reportDecision: null,
  finalCheck: null,
  analyses: [],
  agentRuns: [],
  findings: null,
  lastTestRun: null,
  planGrade: null,
  reviewRequested: null,
  effectiveReviewMode: 'optional',
});
const tasks = [shopTask('JRY-0001', 'Checkout', 'IMPLEMENTATION'), shopTask('JRY-0002', 'Coupons', 'WAIT_PLAN_APPROVAL')];
const repositories: RepositorySummary[] = [
  {
    repoRoot: SHOP,
    excluded: false,
    project: true,
    openTasks: 4,
    profile: {
      repoRoot: SHOP,
      scannedAt: NOW,
      checkedAt: NOW,
      stale: [],
      files: 120,
      truncated: false,
      languages: [{ name: 'TypeScript', files: 80 }],
      packageManager: 'pnpm',
      frameworks: [{ name: 'Vue', evidence: 'vue in package.json' }],
      manifests: [{ path: 'package.json', kind: 'npm', lockfile: 'pnpm-lock.yaml' }],
      commands: [{ kind: 'test', command: 'pnpm run test', run: 'corepack pnpm run test', source: 'package.json scripts.test' }],
      environment: { missingRunners: [], notes: [] },
      ci: [{ path: '.github/workflows/ci.yml', kind: 'github-actions' }],
      containers: [],
      apiSchemas: [],
      migrations: [],
      docs: [],
      instructions: [],
      injection: { findings: [], scannedFiles: 50, complete: true },
      skippedDirectories: [],
      formatVersion: 2,
      packages: [],
      contractReferences: [],
    },
  },
  { repoRoot: SITE, excluded: true, project: false, openTasks: 0, profile: null },
];
const usage: DataUsage = {
  at: NOW,
  database: { file: 'C:\\J\\jerry.sqlite', bytes: 3 * 1024 * 1024 },
  categories: [
    { category: 'tasks', rows: 120, bytes: 512 * 1024, tables: [{ table: 'tasks', rows: 5, bytes: 4096 }] },
    { category: 'events', rows: 4000, bytes: 2 * 1024 * 1024, tables: [{ table: 'hook_events', rows: 4000, bytes: 2 * 1024 * 1024 }] },
  ],
  projects: [
    { repoRoot: SHOP, project: true, tasks: 5, openTasks: 4, events: 3900, lastActivityAt: NOW },
    { repoRoot: SITE, project: false, tasks: 2, openTasks: 0, events: 100, lastActivityAt: null },
  ],
  backups: { dir: 'C:\\J\\backups', count: 7, bytes: 21 * 1024 * 1024, newestAt: NOW },
  logs: { dir: 'C:\\J\\logs', bytes: 40 * 1024 },
  totalBytes: 24 * 1024 * 1024,
  retentionDays: 90,
};
const prunePreview: PrunePreview = {
  options: { eventsOlderThanDays: 30 },
  cutoffs: { done: null, events: NOW, evals: null },
  tasks: [],
  rows: { hook_events: 3800, sessions: 12, agent_runs: 0 },
  totalRows: 3812,
  backups: { count: 0, bytes: 0, files: [] },
};
const forgetPreview: ForgetPreview = { repoRoot: SITE, project: false, tasks: ['JRY-0020', 'JRY-0021'], openTasks: [], rows: { tasks: 2, hook_events: 100 }, totalRows: 102 };

type Call = { url: string; method: string; body: Record<string, unknown> | null; csrf: string | undefined };

describe('Projects and data in the dashboard', () => {
  let calls: Call[];
  let settings: WorkflowSettings;
  let project: ProjectSummary;

  beforeEach(() => {
    calls = [];
    // One-click decisions: the irreversible actions below must still ask for their typed confirmation.
    settings = { reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' };
    project = { ...shopProject };
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], projects: [], repositories: [], graph: { nodes: [], edges: [] }, settings: null, refreshedAt: null });
    window.location.hash = '';
    route.value = { section: 'overview' };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>), csrf: (init?.headers as Record<string, string> | undefined)?.['x-jerry-csrf'] });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.1.0', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 5, sessionCount: 1, database: { file: 'db', migration: '0009' } });
      if (url === '/api/v1/tasks') return json(tasks);
      if (url.startsWith('/api/v1/events') || url === '/api/v1/artifacts') return json([]);
      if (url === '/api/v1/repositories') return json(repositories);
      if (url === '/api/v1/workspace/graph') return json({ nodes: [], edges: [] });
      if (url === '/api/v1/projects' && method === 'GET') return json([project]);
      if (url === '/api/v1/settings' && method === 'GET') return json(settings);
      if (url === '/api/v1/settings') {
        const update = JSON.parse(String(init?.body)) as Partial<WorkflowSettings>;
        // Core refuses English for this test, to show how a failure looks.
        if (update.qaLanguage === 'en') return json({ error: 'The settings file is read-only' }, 500);
        settings = { ...settings, ...update };
        return json(settings);
      }
      if (url === '/api/v1/projects/settings') {
        const { reviewMode } = JSON.parse(String(init?.body)) as { reviewMode: ProjectSummary['reviewMode'] };
        project = { ...project, reviewMode, effectiveReviewMode: reviewMode ?? settings.reviewMode };
        return json(project);
      }
      if (url === '/api/v1/projects') return json({ project: { repoRoot: SITE, addedAt: NOW, addedBy: 'dashboard', note: null }, added: true }, 201);
      if (url === '/api/v1/projects/remove') return json({ repoRoot: SHOP, removed: true, openTasks: ['JRY-0001'], warning: 'JRY-0001 stays open, but JERRY no longer monitors D:\\Work\\shop.' });
      if (url === '/api/v1/data/usage') return json(usage);
      if (url === '/api/v1/data/prune/preview') return json(prunePreview);
      if (url === '/api/v1/data/prune') return json({ ...prunePreview, at: NOW, backupFile: 'C:\\J\\backups\\jerry-before-prune.sqlite', databaseBytesBefore: 3 * 1024 * 1024, databaseBytesAfter: 1024 * 1024 });
      if (url === '/api/v1/data/forget/preview') return json(forgetPreview);
      if (url === '/api/v1/data/forget') return json({ ...forgetPreview, at: NOW, backupFile: 'C:\\J\\backups\\jerry-before-forget.sqlite', databaseBytesBefore: 2048, databaseBytesAfter: 1024 });
      return json({ error: `unexpected ${method} ${url}` }, 404);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function mountApp() {
    const wrapper = mount(App, { attachTo: document.body });
    await startDashboard();
    await flushPromises();
    return wrapper;
  }
  type Wrapper = Awaited<ReturnType<typeof mountApp>>;
  const body = () => new DOMWrapper(document.body);
  const open = async (wrapper: Wrapper, label: string) => {
    await wrapper.findAll('[data-slot="sidebar-content"] [data-sidebar="menu-button"]').find((item) => item.text() === label)!.trigger('click');
    await flushPromises();
  };
  const buttonIn = (scope: Pick<Wrapper, 'findAll'>, label: string) => scope.findAll('button').find((candidate) => candidate.text() === label)!;
  const repositoryRow = (wrapper: Wrapper, repoRoot: string) => wrapper.findAll('.data-repositories [data-repository]').find((row) => row.attributes('data-repository') === repoRoot)!;
  const posts = (url: string) => calls.filter((call) => call.url === url && call.method === 'POST');

  const projectTile = (wrapper: Wrapper) => wrapper.findAll('.projects .project').find((tile) => tile.attributes('data-project') === SHOP)!;
  const openProject = async (wrapper: Wrapper) => {
    await open(wrapper, 'Projects');
    await projectTile(wrapper).get('code').trigger('click');
    await flushPromises();
    return wrapper.get('.project-page');
  };

  it('counts the projects on the overview and shows them as tiles, and the repositories not added, on Projects', async () => {
    const wrapper = await mountApp();
    expect(wrapper.get('.guard-projects').text()).toBe('1 project(s) monitored');
    await open(wrapper, 'Projects');
    const tile = projectTile(wrapper);
    // The name is the last path segment; the root is in Geist Mono.
    expect(tile.get('a').text()).toBe('shop');
    expect(tile.get('a').attributes('href')).toBe('#/projects/D%3A%5CWork%5Cshop');
    expect(tile.get('code').classes()).toContain('font-mono');
    expect(tile.get('code').text()).toBe(SHOP);
    expect(tile.text()).toContain('4 of 5 task(s) open');
    expect(tile.text()).toContain('1 waiting for you');
    expect(tile.find('.waiting-marker').exists()).toBe(true);
    expect(tile.text()).toContain('TypeScript, Vue');
    expect(tile.text()).not.toContain('corepack pnpm run test');

    // The chevron unfolds commands, CI, the review mode and the data in place.
    await tile.get('[data-expand]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.project-page').exists()).toBe(false);
    const details = projectTile(wrapper).text();
    expect(details).toContain('corepack pnpm run test');
    expect(details).toContain('.github/workflows/ci.yml');
    expect(details).toContain('ReviewOptional (inherited from Settings)');
    expect(details).toContain('5 task(s), 3900 event(s) stored');
    expect(details).toContain('in the dashboard');

    const site = wrapper.get('.other-repositories').findAll('.repository').find((row) => row.text().includes(SITE))!;
    expect(site.text()).toContain('not added — only hard rules apply');
    expect(site.get('[data-slot="badge"]').text()).toBe('not added');
    expect(site.get('[data-slot="badge"]').attributes('data-tone')).toBe('neutral');
    expect(wrapper.text()).not.toContain('excluded from monitoring');
    wrapper.unmount();
  });

  it('adds another repository from its row, only after its root is typed', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Projects');
    const site = wrapper.get('.other-repositories').findAll('.repository').find((row) => row.text().includes(SITE))!;
    await buttonIn(site, 'Add project').trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.get('h2').text()).toBe('Add this project?');
    await dialog.get('#confirm-typed').setValue('site');
    expect(dialog.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await dialog.get('#confirm-typed').setValue(SITE);
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/projects').map((call) => call.body)).toEqual([{ path: SITE, confirmation: SITE }]);
    wrapper.unmount();
  });

  it('shows the project page: its tasks as tiles, profile, data and a review setting that saves at once', async () => {
    const wrapper = await mountApp();
    const page = await openProject(wrapper);
    expect(window.location.hash).toBe('#/projects/D%3A%5CWork%5Cshop');
    expect(page.get('.project-page__header').text()).toContain('shop');
    expect(page.get('.project-page__header').text()).toContain(SHOP);
    expect(page.findAll('.project-tasks .task').map((task) => task.attributes('data-task-id'))).toEqual(['JRY-0002', 'JRY-0001']);
    expect(page.get('.repository-profile').text()).toContain('corepack pnpm run test');
    expect(page.get('.project-data').text()).toContain('5 (4 open)');
    expect(page.get('.project-data').text()).toContain('3900');
    // Open tasks: forgetting waits until they are finished.
    expect(page.get('.project-data [data-forget-blocked] button').attributes('disabled')).toBeDefined();

    const review = () => wrapper.get('.project-review');
    const radios = () => review().findAll('[role="radio"]');
    expect(radios().map((radio) => [radio.text(), radio.attributes('aria-checked')])).toEqual([
      ['Inherit', 'true'],
      ['Optional', 'false'],
      ['Required', 'false'],
    ]);
    expect(review().text()).toContain('Now: Optional (inherited from Settings).');
    await radios()[2]!.trigger('click');
    await flushPromises();
    expect(posts('/api/v1/projects/settings').map((call) => [call.body, call.csrf])).toEqual([[{ path: SHOP, reviewMode: 'required' }, CSRF]]);
    expect(state.notice).toBe('Review for shop is required now.');
    expect(radios()[2]!.attributes('aria-checked')).toBe('true');
    expect(review().text()).toContain('Now: Required (set for this project).');

    // Back to the global setting.
    await radios()[0]!.trigger('click');
    await flushPromises();
    expect(posts('/api/v1/projects/settings').at(-1)!.body).toEqual({ path: SHOP, reviewMode: null });
    expect(state.notice).toBe('Review for shop follows Settings again.');
    wrapper.unmount();
  });

  it('saves the workflow settings at once and shows a failure as an alert', async () => {
    const wrapper = await mountApp();
    await wrapper.get('[data-settings] [data-sidebar="menu-button"]').trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/settings');
    const reviewRadios = () => wrapper.get('.settings-review').findAll('[role="radio"]');
    expect(reviewRadios().map((radio) => [radio.text(), radio.attributes('aria-checked')])).toEqual([
      ['Optional', 'true'],
      ['Required', 'false'],
    ]);
    await reviewRadios()[1]!.trigger('click');
    await flushPromises();
    expect(posts('/api/v1/settings').map((call) => [call.body, call.csrf])).toEqual([[{ reviewMode: 'required' }, CSRF]]);
    expect(state.notice).toBe('Saved: review is required now.');
    expect(state.settings).toEqual({ reviewMode: 'required', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' });
    expect(reviewRadios()[1]!.attributes('aria-checked')).toBe('true');

    const qa = wrapper.get('.settings-qa').findAll('[role="radio"]');
    expect(qa.map((radio) => radio.text())).toEqual(['Polski', 'English']);
    await qa[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.get('.settings-error').text()).toContain('The settings file is read-only');
    expect(state.settings).toEqual({ reviewMode: 'required', qaLanguage: 'pl', usageShowBar: true, decisionConfirmation: 'click' });

    // Appearance: the theme, stored in this browser.
    await wrapper.get('.settings-theme').findAll('[role="radio"]').find((radio) => radio.text() === 'Dark')!.trigger('click');
    expect(theme.value).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    document.documentElement.classList.remove('dark');
    window.localStorage.clear();
    wrapper.unmount();
  });

  it('saves the typed-confirmation switch at once, and decision dialogs follow it', async () => {
    const wrapper = await mountApp();
    const approveDialogMode = async () => {
      await open(wrapper, 'Tasks');
      const tile = wrapper.get('.task[data-task-id="JRY-0002"]');
      if (tile.find('.task-tile__details').exists() === false) await tile.get('[data-expand]').trigger('click');
      await flushPromises();
      await buttonIn(wrapper.get('.task[data-task-id="JRY-0002"]'), 'Approve plan v1').trigger('click');
      await flushPromises();
      const dialog = body().get('[role="alertdialog"]');
      const mode = [dialog.attributes('data-confirm-mode'), dialog.find('#confirm-typed').exists()];
      await buttonIn(dialog, 'Cancel').trigger('click');
      await flushPromises();
      return mode;
    };
    const openSettings = async () => {
      await wrapper.get('[data-settings] [data-sidebar="menu-button"]').trigger('click');
      await flushPromises();
      return wrapper.get('.settings-confirmation');
    };

    // One click by default: the switch is off.
    expect(await approveDialogMode()).toEqual(['click', false]);
    let card = await openSettings();
    expect(card.text()).toContain('Type the task ID to confirm decisions');
    expect(card.text()).toContain('always ask for a typed confirmation');
    expect(card.get('[role="switch"]').attributes('aria-checked')).toBe('false');

    await card.get('[role="switch"]').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/settings').map((call) => [call.body, call.csrf])).toEqual([[{ decisionConfirmation: 'typed' }, CSRF]]);
    expect(state.notice).toBe('Saved: decisions need the task ID typed.');
    expect(state.settings?.decisionConfirmation).toBe('typed');
    expect(wrapper.get('.settings-confirmation [role="switch"]').attributes('aria-checked')).toBe('true');
    expect(await approveDialogMode()).toEqual(['typed', true]);

    // Back to one click.
    card = await openSettings();
    await card.get('[role="switch"]').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/settings').at(-1)!.body).toEqual({ decisionConfirmation: 'click' });
    expect(state.notice).toBe('Saved: decisions are one click in a confirmation dialog.');
    expect(await approveDialogMode()).toEqual(['click', false]);
    expect(calls.some((call) => call.url.endsWith('/approvals'))).toBe(false);
    wrapper.unmount();
  });

  it('adds a project only after its path is typed again', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Projects');
    await buttonIn(wrapper.get('.projects'), 'Add project').trigger('click');
    await flushPromises();
    await body().get('#project-path').setValue(SITE);
    await body().get('form.add-project').trigger('submit');
    await flushPromises();

    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.get('h2').text()).toBe('Add this project?');
    const submit = dialog.get('button[type="submit"]');
    for (const typed of ['', 'D:\\Old', SHOP]) {
      await dialog.get('#confirm-typed').setValue(typed);
      expect(submit.attributes('disabled'), typed).toBeDefined();
      await dialog.get('form').trigger('submit');
    }
    await flushPromises();
    expect(posts('/api/v1/projects')).toHaveLength(0);

    await dialog.get('#confirm-typed').setValue(SITE);
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/projects')).toEqual([{ url: '/api/v1/projects', method: 'POST', body: { path: SITE, confirmation: SITE }, csrf: CSRF }]);
    expect(state.notice).toBe(`JERRY monitors ${SITE} now.`);
    wrapper.unmount();
  });

  it('removes a project from its page only with the typed path and passes on the open-tasks warning', async () => {
    const wrapper = await mountApp();
    const page = await openProject(wrapper);
    await buttonIn(page.get('.project-page__header'), 'Remove').trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.text()).toContain('4 open task(s) stay open');
    expect(dialog.attributes('data-confirm-mode')).toBe('typed');
    await dialog.get('#confirm-typed').setValue('remove');
    expect(dialog.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await dialog.get('#confirm-typed').setValue(SHOP);
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/projects/remove').map((call) => call.body)).toEqual([{ path: SHOP, confirmation: SHOP }]);
    expect(state.notice).toBe('JRY-0001 stays open, but JERRY no longer monitors D:\\Work\\shop.');
    wrapper.unmount();
  });

  it('shows what JERRY stores: the total, the files, each kind of data and each repository', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Data');
    expect(wrapper.get('header h1').text()).toBe('Data');
    const summary = wrapper.get('.data-usage');
    expect(summary.text()).toContain('JERRY stores 24 MB on this computer');
    expect(summary.text()).toContain('3.0 MB');
    expect(summary.text()).toContain('7 file(s), 21 MB');
    expect(summary.text()).toContain('older than 90 days are removed automatically');
    const categories = wrapper.findAll('.data-categories tbody tr').map((row) => row.findAll('td').map((cell) => cell.text()));
    expect(categories).toEqual([
      ['🗂️Tasks, plans and approvals', '120', '512 KB'],
      ['ℹ️Events (the timeline)', '4000', '2.0 MB'],
    ]);
    const repositoriesTable = wrapper.get('.data-repositories');
    expect(repositoriesTable.text()).toContain(SHOP);
    expect(repositoriesTable.text()).toContain('5 (4)');
    wrapper.unmount();
  });

  it('previews a clean-up and deletes it only after "delete" is typed', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Data');
    const cleanUp = wrapper.get('.clean-up');
    expect(buttonIn(cleanUp, 'Preview').attributes('disabled')).toBeDefined();
    expect(buttonIn(cleanUp, 'Delete').attributes('disabled')).toBeDefined();

    await cleanUp.get('#prune-eventsOlderThanDays').setValue('30');
    await buttonIn(cleanUp, 'Preview').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/data/prune/preview').map((call) => call.body)).toEqual([{ eventsOlderThanDays: 30 }]);
    const preview = cleanUp.get('.prune-preview');
    expect(preview.text()).toContain('Would delete 3812 row(s) and 0 backup file(s)');
    expect(preview.findAll('tbody tr').map((row) => row.text())).toEqual(['hook_events3800', 'sessions12']);

    // Another setting needs its own preview.
    await cleanUp.get('#prune-backupsKeep').setValue('3');
    expect(cleanUp.find('.prune-preview').exists()).toBe(false);
    expect(buttonIn(cleanUp, 'Delete').attributes('disabled')).toBeDefined();
    await cleanUp.get('#prune-backupsKeep').setValue('');
    await buttonIn(cleanUp, 'Preview').trigger('click');
    await flushPromises();

    await buttonIn(cleanUp, 'Delete').trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.attributes('data-confirm-mode')).toBe('typed');
    for (const typed of ['Delete', 'yes', 'delete it']) {
      await dialog.get('#confirm-typed').setValue(typed);
      expect(dialog.get('button[type="submit"]').attributes('disabled'), typed).toBeDefined();
      await dialog.get('form').trigger('submit');
    }
    await flushPromises();
    expect(posts('/api/v1/data/prune')).toHaveLength(0);

    const usageCalls = calls.filter((call) => call.url === '/api/v1/data/usage').length;
    await dialog.get('#confirm-typed').setValue('delete');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/data/prune')).toEqual([{ url: '/api/v1/data/prune', method: 'POST', body: { eventsOlderThanDays: 30, confirmation: 'delete' }, csrf: CSRF }]);
    const result = wrapper.get('.prune-result');
    expect(result.text()).toContain('Freed 2.0 MB in the database.');
    expect(result.text()).toContain('jerry-before-prune.sqlite');
    expect(calls.filter((call) => call.url === '/api/v1/data/usage').length).toBe(usageCalls + 1);
    wrapper.unmount();
  });

  it('forgets a repository only with its typed root, and not while it has open tasks', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Data');
    const shop = repositoryRow(wrapper, SHOP);
    expect(shop.get('[data-forget-blocked] button').attributes('disabled')).toBeDefined();
    expect(shop.get('[data-forget-blocked]').attributes('tabindex')).toBe('0');

    const site = repositoryRow(wrapper, SITE);
    await buttonIn(site, 'Forget').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/data/forget/preview').map((call) => call.body)).toEqual([{ path: SITE }]);
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.text()).toContain('Deletes 102 row(s), including JRY-0020, JRY-0021');
    expect(dialog.attributes('data-confirm-mode')).toBe('typed');
    await dialog.get('#confirm-typed').setValue('forget');
    expect(dialog.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await dialog.get('#confirm-typed').setValue(SITE);
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/data/forget').map((call) => [call.body, call.csrf])).toEqual([[{ path: SITE, confirmation: SITE }, CSRF]]);
    expect(wrapper.get('.forget-result').text()).toContain('jerry-before-forget.sqlite');
    wrapper.unmount();
  });
});
