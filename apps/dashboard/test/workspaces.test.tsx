// @vitest-environment happy-dom
import type { ProjectSummary, TaskSummary, Workspace, WorkspaceChangeResult, WorkspaceScan } from '@jerry/contracts';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { parseRoute, route } from '../src/router';
import type { WorkflowSettings } from '../src/settings';
import { startDashboard, state } from '../src/state';
import { pathsOf } from '../src/components/WorkspacesCard';

const CSRF = 'c'.repeat(64);
const NOW = new Date().toISOString();
const API = 'D:\\Work\\api';
const SHOP = 'D:\\Work\\shop';
const ADMIN = 'D:\\Work\\admin';

const project = (repoRoot: string): ProjectSummary => ({ repoRoot, addedAt: NOW, addedBy: 'dashboard', note: null, reviewMode: null, effectiveReviewMode: 'optional', tasks: 1, openTasks: 1, lastActivityAt: NOW, exists: true });
const task = (taskId: string, repoRoot: string, taskState: TaskSummary['state']): TaskSummary => ({
  taskId,
  title: `Task in ${repoRoot}`,
  repoRoot,
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
const repo = (repoRoot: string, openTasks: number, waiting: number) => ({ repoRoot, project: true, present: true, openTasks, waiting, openTaskIds: [], waitingTaskIds: [] });

type Call = { url: string; method: string; body: Record<string, unknown> | null; csrf: string | undefined };

describe('Workspaces in the dashboard', () => {
  let calls: Call[];
  let workspaces: Workspace[];

  beforeEach(() => {
    calls = [];
    workspaces = [{ id: 1, name: 'Shop', createdAt: NOW, repos: [repo(API, 1, 1), repo(SHOP, 1, 0)] }];
    const settings: WorkflowSettings = { reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: false, decisionConfirmation: 'click' };
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], projects: [], repositories: [], graph: { nodes: [], edges: [] }, settings: null, refreshedAt: null });
    window.location.hash = '';
    route.value = { section: 'overview' };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
      calls.push({ url, method, body, csrf: (init?.headers as Record<string, string> | undefined)?.['x-jerry-csrf'] });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.1.0', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 3, sessionCount: 0, database: { file: 'db', migration: '0024' } });
      if (url === '/api/v1/tasks') return json([task('JRY-0001', API, 'WAIT_PLAN_APPROVAL'), task('JRY-0002', SHOP, 'IMPLEMENTATION'), task('JRY-0003', ADMIN, 'IMPLEMENTATION')]);
      if (url.startsWith('/api/v1/events') || url === '/api/v1/artifacts' || url === '/api/v1/repositories') return json([]);
      if (url === '/api/v1/workspace/graph') return json({ nodes: [], edges: [{ from: SHOP, to: API, kind: 'api-contract', evidence: 'openapi.yaml' }] });
      if (url === '/api/v1/projects') return json([project(API), project(SHOP), project(ADMIN)]);
      if (url === '/api/v1/settings') return json(settings);
      if (url === '/api/v1/data/usage') return json({ error: 'no' }, 404);
      if (url === '/api/v1/workspaces' && method === 'GET') return json(workspaces);
      if (url === '/api/v1/workspaces/1') return json(workspaces[0]);
      if (url === '/api/v1/workspaces/scan') {
        return json({
          folder: 'D:\\Work',
          repos: [
            { repoRoot: API, project: true, workspace: 'Shop' },
            { repoRoot: ADMIN, project: true, workspace: null },
            { repoRoot: 'D:\\Work\\blog', project: false, workspace: null },
          ],
          truncated: false,
        } satisfies WorkspaceScan);
      }
      if (url === '/api/v1/workspaces' && method === 'POST') {
        const created: Workspace = { id: 2, name: String(body!['name']), createdAt: NOW, repos: (body!['paths'] as string[]).map((path) => repo(path, 0, 0)) };
        workspaces = [...workspaces, created];
        return json({ workspace: created, addedProjects: ['D:\\Work\\blog'] } satisfies WorkspaceChangeResult, 201);
      }
      if (url === '/api/v1/workspaces/2') return json(workspaces[1]);
      if (url === '/api/v1/workspaces/1/repos/remove') {
        workspaces = [{ ...workspaces[0]!, repos: [repo(API, 1, 1)] }];
        return json({ workspace: workspaces[0]!, addedProjects: [] } satisfies WorkspaceChangeResult);
      }
      if (url === '/api/v1/workspaces/1/delete') {
        workspaces = [];
        return json({ workspace: null, addedProjects: [] } satisfies WorkspaceChangeResult);
      }
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
  const posts = (url: string) => calls.filter((call) => call.url === url && call.method === 'POST');

  it('lists workspaces on Projects as full-width rows and opens one: its repositories, open tasks and links', async () => {
    expect(parseRoute('#/workspaces/1')).toEqual({ section: 'workspaces', id: 1 });
    expect(parseRoute('#/workspaces/x')).toBeNull();
    const wrapper = await mountApp();
    await open(wrapper, 'Projects');
    const row = wrapper.get('.workspaces [data-workspace="Shop"]');
    expect(wrapper.get('.workspace-list').classes()).toContain('grid-cols-1');
    expect(row.text()).toContain('2 repositories · 2 open task(s)');
    expect(row.text()).toContain('1 waiting for you');
    await row.trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/workspaces/1');
    const page = wrapper.get('[data-workspace-page="Shop"]');
    expect(page.findAll('[data-workspace-repo]').map((item) => item.attributes('data-workspace-repo'))).toEqual([API, SHOP]);
    // Open tasks of both repositories, not of admin.
    expect(page.findAll('.task').map((tile) => tile.attributes('data-task-id')).sort()).toEqual(['JRY-0001', 'JRY-0002']);
    expect(page.text()).toContain('shop → api: api-contract');
    // The header shows the workspace under Projects.
    expect(wrapper.get('header').text()).toContain('Shop');
    wrapper.unmount();
  });

  it('creates a workspace from a folder scan and pasted paths, confirmed once', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Projects');
    await wrapper.get('[data-new-workspace]').trigger('click');
    await flushPromises();
    await body().get('#workspace-name').setValue('Blog');
    await body().get('#workspace-folder').setValue('D:\\Work');
    await body().get('[data-scan-folder]').trigger('click');
    await flushPromises();
    const scanned = body().findAll('[data-scan-repo]');
    // In another workspace: shown, not choosable; the free ones are chosen.
    expect(scanned.map((item) => [item.attributes('data-scan-repo'), (item.get('input').element as HTMLInputElement).checked, item.get('input').attributes('disabled') !== undefined])).toEqual([
      [API, false, true],
      [ADMIN, true, false],
      ['D:\\Work\\blog', true, false],
    ]);
    await body().get(`[data-scan-repo="${ADMIN.replaceAll('\\', '\\\\')}"] input`).setValue(false);
    await body().get('#workspace-paths').setValue('"D:\\Work\\docs"\n\n');
    expect(body().get('[data-create-workspace]').text()).toContain('Create with 2 repositories');
    await body().get('form.new-workspace').trigger('submit');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.text()).toContain('D:\\Work\\blog');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/workspaces').map((call) => [call.body, call.csrf])).toEqual([[{ name: 'Blog', paths: ['D:\\Work\\docs', 'D:\\Work\\blog'], confirmation: 'Blog' }, CSRF]]);
    expect(state.notice).toContain('Created workspace Blog; JERRY monitors 1 more project(s) now.');
    expect(window.location.hash).toBe('#/workspaces/2');
    expect(pathsOf(' "C:\\a" \n\n\'D:\\b\'')).toEqual(['C:\\a', 'D:\\b']);
    wrapper.unmount();
  });

  it('removes a repository (it stays a project) and deletes the workspace (projects stay)', async () => {
    window.location.hash = '#/workspaces/1';
    const wrapper = await mountApp();
    route.value = { section: 'workspaces', id: 1 };
    await flushPromises();
    await wrapper.get(`[data-remove-repo="${SHOP.replaceAll('\\', '\\\\')}"]`).trigger('click');
    await flushPromises();
    let dialog = body().get('[role="alertdialog"]');
    expect(dialog.text()).toContain('stays a project');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/workspaces/1/repos/remove').map((call) => call.body)).toEqual([{ path: SHOP, confirmation: 'Shop' }]);
    expect(wrapper.findAll('[data-workspace-repo]')).toHaveLength(1);

    await wrapper.get('[data-delete-workspace]').trigger('click');
    await flushPromises();
    dialog = body().get('[role="alertdialog"]');
    expect(dialog.text()).toContain('every repository stays a JERRY project');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/workspaces/1/delete')).toHaveLength(1);
    expect(window.location.hash).toBe('#/projects');
    wrapper.unmount();
  });

  it('filters tasks by workspace', async () => {
    const wrapper = await mountApp();
    await open(wrapper, 'Tasks');
    await wrapper.get('[data-project-filter]').trigger('click');
    await flushPromises();
    await body().get('[data-workspace-filter="Shop"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.task-grid .task').map((tile) => tile.attributes('data-task-id')).sort()).toEqual(['JRY-0001', 'JRY-0002']);
    expect(wrapper.get('[data-project-filter]').text()).toContain('Shop');
    wrapper.unmount();
  });
});
