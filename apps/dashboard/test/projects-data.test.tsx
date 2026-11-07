// @vitest-environment happy-dom
import type { DataUsage, ForgetPreview, PrunePreview, ProjectSummary, RepositorySummary } from '@jerry/contracts';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { startDashboard, state } from '../src/state';

const CSRF = 'c'.repeat(64);
const NOW = new Date().toISOString();
const SHOP = 'D:\\Work\\shop';
const SITE = 'D:\\Old\\site';

const shopProject: ProjectSummary = { repoRoot: SHOP, addedAt: NOW, addedBy: 'dashboard', note: null, tasks: 5, openTasks: 4, lastActivityAt: NOW, exists: true };
const repositories: RepositorySummary[] = [
  { repoRoot: SHOP, excluded: false, project: true, openTasks: 4, profile: null },
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

  beforeEach(() => {
    calls = [];
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], projects: [], repositories: [], graph: { nodes: [], edges: [] }, refreshedAt: null });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>), csrf: (init?.headers as Record<string, string> | undefined)?.['x-jerry-csrf'] });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.1.0', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 5, sessionCount: 1, database: { file: 'db', migration: '0009' } });
      if (url === '/api/v1/tasks' || url.startsWith('/api/v1/events') || url === '/api/v1/artifacts') return json([]);
      if (url === '/api/v1/repositories') return json(repositories);
      if (url === '/api/v1/workspace/graph') return json({ nodes: [], edges: [] });
      if (url === '/api/v1/projects' && method === 'GET') return json([shopProject]);
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

  it('counts the projects on the overview and lists them, and the repositories not added, on Repositories', async () => {
    const wrapper = await mountApp();
    expect(wrapper.get('.guard-projects').text()).toBe('1 project(s) monitored');
    await open(wrapper, 'Repositories');
    const row = wrapper.findAll('.projects [data-project]').find((candidate) => candidate.attributes('data-project') === SHOP)!;
    expect(row.get('td').classes()).toContain('font-mono');
    expect(row.text()).toContain(SHOP);
    expect(row.text()).toContain('4 of 5');
    expect(row.text()).toContain('in the dashboard');
    const site = wrapper.findAll('.repository').find((card) => card.text().includes(SITE))!;
    expect(site.text()).toContain('not added — only hard rules apply');
    expect(site.get('[data-slot="badge"]').text()).toBe('not added');
    expect(site.get('[data-slot="badge"]').attributes('data-tone')).toBe('neutral');
    expect(wrapper.text()).not.toContain('excluded from monitoring');
    wrapper.unmount();
  });

  it('adds a project only after its path is typed again', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Repositories');
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

  it('removes a project only with the typed path and passes on the open-tasks warning', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Repositories');
    await buttonIn(wrapper.get('.projects'), 'Remove').trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.text()).toContain('4 open task(s) stay open');
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
