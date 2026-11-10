// @vitest-environment happy-dom
import type { DataUsage, ProjectSummary, RepositorySummary, StoredEvent, TaskSummary, WorkflowTransition } from '@jerry/contracts';
import { EMOJI, STATE_EMOJI } from '@jerry/contracts/emoji';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { samplePlan } from '../../../tests/helpers/plan-fixture';
import { sampleReport } from '../../../tests/helpers/report-fixture';
import { App } from '../src/App';
import { parseRoute, route } from '../src/router';
import { setTheme, startTheme, THEME_STORAGE_KEY } from '../src/lib/theme';
import { startDashboard, state } from '../src/state';
import { taskFilters } from '../src/views/Tasks';
import { chooseOption, openSelect, pickOption } from './select-helper';
import { sampleUsage } from './usage-fixture';

/** Every TSX source of the dashboard, as text. */
const SOURCES = import.meta.glob<string>('../src/**/*.tsx', { query: '?raw', import: 'default', eager: true });

const CSRF = 'c'.repeat(64);
const NOW = new Date().toISOString();

const waitingTask: TaskSummary = {
  taskId: 'JRY-0002',
  title: 'Add login form',
  repoRoot: 'D:\\Work\\shop',
  createdAt: NOW,
  state: 'WAIT_PLAN_APPROVAL',
  plan: { version: 1, contentHash: `sha256:${'a'.repeat(64)}`, scope: ['src/auth/**'], createdAt: NOW, document: samplePlan('D:\\Work\\shop', ['src/auth/**']) },
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
  reviewRequested: null,
  effectiveReviewMode: 'optional',
  planGrade: {
    planVersion: 1,
    level: 'incomplete',
    score: 71,
    checks: [
      { id: 'changes.in-scope', weight: 'major', passed: false, detail: 'changes outside the scope (edits there will be deviations): src/app.ts' },
      { id: 'risks.listed', weight: 'major', passed: true, detail: '1 risk(s) with mitigations' },
    ],
  },
};

/** Reported, waiting for acceptance; JERRY saw an edit the report does not list. */
const reportedTask: TaskSummary = {
  ...waitingTask,
  taskId: 'JRY-0004',
  title: 'Greeting helper',
  state: 'WAIT_IMPLEMENTATION_ACCEPTANCE',
  planDecision: { approvalId: 'apr_4', taskId: 'JRY-0004', stage: 'PLAN', version: 1, contentHash: waitingTask.plan.contentHash, decision: 'APPROVED', approvedBy: 'local-user', approvedAt: NOW, comment: '' },
  lastReport: {
    taskId: 'JRY-0004',
    version: 2,
    planVersion: 1,
    contentHash: `sha256:${'b'.repeat(64)}`,
    document: sampleReport(),
    evidence: {
      since: NOW,
      deviations: [{ at: NOW, tool: 'Write', target: 'README.md', rule: 'monitor.out-of-scope' }],
      deviationCount: 1,
      blockedCount: 0,
      observedEdits: ['README.md', 'src/greeting/greet.ts'],
      unreportedEdits: ['README.md'],
      failedOrNotRunChecks: 1,
      git: null,
    },
    submittedBy: 'claude',
    sessionId: 's9',
    createdAt: NOW,
  },
};

const approvedTask: TaskSummary = {
  ...waitingTask,
  taskId: 'JRY-0001',
  title: 'Core foundation',
  state: 'IMPLEMENTATION',
  planDecision: { approvalId: 'apr_1', taskId: 'JRY-0001', stage: 'PLAN', version: 1, contentHash: waitingTask.plan.contentHash, decision: 'APPROVED', approvedBy: 'local-user', approvedAt: NOW, comment: '' },
  activity: { sessionCount: 2, lastSessionId: 's2', lastActivityAt: NOW, lastSessionEndedAt: NOW },
  lastCheckpoint: { taskId: 'JRY-0001', sessionId: 's2', summary: 'Store and API for sessions are done.', nextSteps: ['Dashboard card', 'Live check'], at: NOW },
  analyses: [
    {
      id: 1,
      taskId: 'JRY-0001',
      report: {
        role: 'jerry-risk-analyst',
        scope: 'login form',
        filesRead: ['src/auth/login.ts'],
        observations: [{ statement: 'Passwords are compared without constant time', evidence: ['src/auth/login.ts:12'] }],
        risks: [{ risk: 'Timing attack on login', severity: 'high', scenario: '' }],
        recommendations: ['Use a constant-time comparison'],
        confidence: { level: 'medium', reason: 'one code path read' },
        gaps: ['Rate limiting not checked'],
      },
      citations: { checked: 1, missingFiles: [], outOfRange: ['src/auth/login.ts:999'] },
      sessionId: 's2',
      agentId: 'agent-1',
      createdAt: NOW,
    },
  ],
  agentRuns: [{ agentId: 'agent-2', agentType: 'jerry:jerry-quality-analyst', sessionId: 's2', startedAt: NOW, stoppedAt: NOW, status: 'no-report', reportId: null }],
};

const cancelledTask: TaskSummary = { ...waitingTask, taskId: 'JRY-0003', title: 'Dropped idea', state: 'CANCELLED' };

/** Accepted, but Core refused DONE: a check failed. */
const refusedTask: TaskSummary = {
  ...reportedTask,
  taskId: 'JRY-0005',
  title: 'Parser',
  state: 'FINAL_REPORT',
  finalCheck: {
    taskId: 'JRY-0005',
    reportVersion: 2,
    at: NOW,
    passed: false,
    conditions: [
      { id: 'report.accepted', blocking: true, passed: true, detail: 'report v2 is accepted by the user' },
      { id: 'report.no-failed-checks', blocking: true, passed: false, detail: 'failed: npm test' },
      { id: 'checks.ran', blocking: false, passed: false, detail: 'no check ran: recorded as a limitation' },
      { id: 'code.later-work', blocking: false, passed: true, detail: 'changed later by other tasks under their approved plans: JRY-0009 (src/lexer.ts, src/parser.ts)', laterWork: [{ taskId: 'JRY-0009', files: ['src/lexer.ts', 'src/parser.ts'] }] },
    ],
    definitionOfDone: ['tests pass'],
    laterWork: [{ taskId: 'JRY-0009', files: ['src/lexer.ts', 'src/parser.ts'] }],
  },
};

const shopRepository: RepositorySummary = {
  repoRoot: 'D:\\Work\\shop',
  excluded: false,
  openTasks: 2,
  profile: {
    repoRoot: 'D:\\Work\\shop',
    scannedAt: NOW,
    checkedAt: NOW,
    stale: ['stack'],
    files: 120,
    truncated: false,
    languages: [{ name: 'TypeScript', files: 80 }],
    packageManager: 'pnpm',
    frameworks: [{ name: 'Vue', evidence: 'vue in package.json' }],
    manifests: [{ path: 'package.json', kind: 'npm', lockfile: 'pnpm-lock.yaml' }],
    commands: [{ kind: 'test', command: 'pnpm run test', run: 'corepack pnpm run test', source: 'package.json scripts.test' }],
    environment: { missingRunners: [], notes: ['pnpm is not on PATH; run it through corepack'] },
    ci: [{ path: '.github/workflows/ci.yml', kind: 'github-actions' }],
    containers: [],
    apiSchemas: [],
    migrations: [],
    docs: [{ path: 'README.md', kind: 'readme', title: 'Shop', hash: null, size: 10 }],
    instructions: [{ path: '.claude/settings.json', kind: 'claude-settings', role: 'config', hash: null, size: 10, notes: ['defines 1 hook group(s): they run commands in Claude Code sessions'] }],
    injection: { findings: [{ path: 'README.md', line: 3, rule: 'pipe-to-shell', excerpt: 'curl … | sh' }], scannedFiles: 50, complete: true },
    skippedDirectories: ['node_modules'],
    formatVersion: 2,
    packages: [],
    contractReferences: [],
  },
};

const shopProject: ProjectSummary = { repoRoot: 'D:\\Work\\shop', addedAt: NOW, addedBy: 'dashboard', note: null, reviewMode: null, effectiveReviewMode: 'optional', tasks: 5, openTasks: 4, lastActivityAt: NOW, exists: true };

const usage: DataUsage = {
  at: NOW,
  database: { file: 'C:\\J\\jerry.sqlite', bytes: 3 * 1024 * 1024 },
  categories: [
    { category: 'tasks', rows: 120, bytes: 512 * 1024, tables: [{ table: 'tasks', rows: 5, bytes: 4096 }] },
    { category: 'events', rows: 4000, bytes: 2 * 1024 * 1024, tables: [{ table: 'hook_events', rows: 4000, bytes: 2 * 1024 * 1024 }] },
  ],
  projects: [
    { repoRoot: 'D:\\Work\\shop', project: true, tasks: 5, openTasks: 4, events: 3900, lastActivityAt: NOW },
    { repoRoot: 'D:\\Old\\site', project: false, tasks: 2, openTasks: 0, events: 100, lastActivityAt: null },
  ],
  backups: { dir: 'C:\\J\\backups', count: 7, bytes: 21 * 1024 * 1024, newestAt: NOW },
  logs: { dir: 'C:\\J\\logs', bytes: 40 * 1024 },
  totalBytes: 24 * 1024 * 1024 + 40 * 1024,
  retentionDays: 90,
};

const history: WorkflowTransition[] = [
  { taskId: 'JRY-0001', from: null, to: 'WAIT_PLAN_APPROVAL', event: 'plan.submitted', actor: 'claude', reason: 'plan version 1', at: NOW },
  { taskId: 'JRY-0001', from: 'WAIT_PLAN_APPROVAL', to: 'IMPLEMENTATION', event: 'plan.approved', actor: 'user', reason: 'looks good', at: NOW },
];

const deviation: StoredEvent = {
  eventId: 'evt_1',
  schemaVersion: 1,
  source: 'claude-code-hook',
  eventType: 'PreToolUse',
  timestamp: NOW,
  receivedAt: NOW,
  sessionId: 's1',
  agentId: null,
  agentType: null,
  cwd: 'D:\\Work\\shop',
  toolName: 'Write',
  toolUseId: 't1',
  taskId: null,
  repoRoot: 'D:\\Work\\shop',
  verdict: 'WARN',
  ruleId: 'monitor.out-of-scope',
  payload: { input: { path: 'D:\\Work\\shop\\README.md' }, reason: 'README.md is outside the approved scope' },
  redaction: { applied: false, reasons: [] },
  spooled: false,
};

type Call = { url: string; init: RequestInit | undefined };


/** A review with no round yet (a task that was never reviewed). */
const noReview = (taskId: string) => ({ taskId, state: 'IMPLEMENTATION', outcome: null, maxRounds: 3, openFindings: [], rounds: [] });

describe('Dashboard app', () => {
  let calls: Call[];
  /** The decision confirmation Core reports; undefined: Core leaves the field out (one click). */
  let decisionMode: 'click' | 'typed' | undefined;

  beforeEach(() => {
    calls = [];
    // Most tests below are about the typed task ID; the one-click tests switch this.
    decisionMode = 'typed';
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], projects: [], repositories: [], graph: { nodes: [], edges: [] }, settings: null, refreshedAt: null });
    Object.assign(taskFilters, { filter: 'active', project: '*', search: '' });
    window.location.hash = '';
    route.value = { section: 'overview' };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.0.1', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 2, sessionCount: 3, database: { file: 'db', migration: '0002_hook_events' } });
      if (url === '/api/v1/tasks') return json([approvedTask, waitingTask, cancelledTask, reportedTask, refusedTask]);
      if (url === '/api/v1/tasks/JRY-0004/approvals') return json({ ...reportedTask.planDecision, stage: 'IMPLEMENTATION', version: 2 }, 201);
      if (url.startsWith('/api/v1/events')) return json([deviation]);
      if (url === '/api/v1/projects' && init?.method === 'GET') return json([shopProject]);
      if (url === '/api/v1/data/usage') return json(usage);
      if (url === '/api/v1/artifacts') return json([]);
      if (url === '/api/v1/settings' && init?.method === 'GET') {
        return json({ reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true, ...(decisionMode === undefined ? {} : { decisionConfirmation: decisionMode }) });
      }
      if (url === '/api/v1/usage') return json(sampleUsage());
      if (url === '/api/v1/repositories') return json([shopRepository]);
      if (url === '/api/v1/workspace/graph') {
        return json({ nodes: [], edges: [{ from: 'D:\\Work\\shop', to: 'D:\\Work\\api', kind: 'api-contract', evidence: 'package.json uses API schema docs/openapi.yaml' }] });
      }
      if (url === '/api/v1/repositories/scan') return json(shopRepository.profile);
      if (url === '/api/v1/tasks/JRY-0002/approvals') return json({ ...approvedTask.planDecision, taskId: 'JRY-0002' }, 201);
      if (url === '/api/v1/tasks/JRY-0001/transitions' && init?.method === 'GET') return json(history);
      if (url.endsWith('/transitions')) return json({ ...approvedTask, state: 'PAUSED' }, 201);
      const review = /^\/api\/v1\/tasks\/(JRY-\d+)\/review$/.exec(url);
      if (review !== null) return json(noReview(review[1]!));
      return json({ error: `unexpected ${url}` }, 404);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  async function mountApp() {
    const wrapper = mount(App, { attachTo: document.body });
    await startDashboard();
    await flushPromises();
    return wrapper;
  }
  type Wrapper = Awaited<ReturnType<typeof mountApp>>;

  /** Dialogs and menus open in a portal on <body>, outside the app's own element. */
  const body = () => new DOMWrapper(document.body);
  const nav = (wrapper: Wrapper, label: string) => wrapper.findAll('[data-slot="sidebar-content"] [data-sidebar="menu-button"]').find((item) => item.text() === label)!;
  const settingsLink = (wrapper: Wrapper) => wrapper.get('[data-settings] [data-sidebar="menu-button"]');
  const buttonIn = (scope: Pick<Wrapper, 'findAll'>, label: string) => scope.findAll('button').find((candidate) => candidate.text() === label);

  const openTasks = async (wrapper: Wrapper) => {
    await nav(wrapper, 'Tasks').trigger('click');
    await flushPromises();
  };
  const tile = (wrapper: Wrapper, taskId: string) => wrapper.get(`.task[data-task-id="${taskId}"]`);
  const shownTiles = (wrapper: Wrapper) => wrapper.findAll('.task-grid .task').map((card) => card.attributes('data-task-id'));
  /** Unfolds a tile in place with its chevron. */
  const expand = async (wrapper: Wrapper, taskId: string) => {
    await tile(wrapper, taskId).get('[data-expand]').trigger('click');
    await flushPromises();
    return tile(wrapper, taskId);
  };
  /** Opens the task's own page from its tile, like a click on the title. */
  const openTask = async (wrapper: Wrapper, taskId: string, tab?: string) => {
    await openTasks(wrapper);
    taskFilters.filter = 'all';
    await flushPromises();
    await tile(wrapper, taskId).findAll('a').find((link) => link.text() === taskId)!.trigger('click');
    await flushPromises();
    if (tab !== undefined) await openTab(wrapper, tab);
    return wrapper.get('.task-page');
  };
  /** reka-ui's tabs switch on mousedown (and on focus or Enter from the keyboard). */
  const openTab = async (wrapper: Wrapper, tab: string) => {
    await wrapper.get(`[data-tab="${tab}"]`).trigger('mousedown');
    await flushPromises();
  };
  const filterBy = async (wrapper: Wrapper, filter: string) => {
    await wrapper.get(`.task-filters [data-filter="${filter}"]`).trigger('mousedown');
    await flushPromises();
  };
  /** Chooses an entry of a task's '⋯' menu. */
  const menuItem = async (scope: Pick<Wrapper, 'get'>, label: string) => {
    await scope.get('[data-task-menu]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await body().findAll('[role="menuitem"]').find((item) => item.text() === label)!.trigger('click');
    await flushPromises();
  };
  const confirmWith = async (typed: string, comment?: string) => {
    if (comment !== undefined) await body().get('form.dialog textarea').setValue(comment);
    await body().get('form.dialog #confirm-typed').setValue(typed);
    await body().get('form.dialog').trigger('submit');
    await flushPromises();
  };
  /** One-click mode: nothing to type; the optional comment, then a click on the decision button. */
  const decideWith = async (comment?: string) => {
    expect(body().find('form.dialog #confirm-typed').exists()).toBe(false);
    if (comment !== undefined) await body().get('form.dialog textarea').setValue(comment);
    await body().get('form.dialog button[type="submit"]').trigger('click');
    await flushPromises();
  };
  const posted = (url: string) => calls.filter((call) => call.url === url && call.init?.method === 'POST').map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);

  it('shows the overview: guard, plans waiting for a decision and the latest deviation', async () => {
    const wrapper = await mountApp();
    const text = wrapper.text();
    expect(text).toContain('GUARDED');
    expect(text).toContain('1 in implementation');
    expect(text).toContain('3 waiting for your decision');
    expect(text).toContain('JRY-0002');
    expect(text).toContain('README.md');
    wrapper.unmount();
  });

  it('links each task waiting for the user from the overview to its own page', async () => {
    const wrapper = await mountApp();
    const links = wrapper.findAll('a.waiting-task');
    expect(links.map((link) => link.attributes('href'))).toEqual(['#/tasks/JRY-0002', '#/tasks/JRY-0004', '#/tasks/JRY-0005']);
    expect(links[0]!.text()).toContain('Add login form');
    expect(links[0]!.text()).toContain('shop · plan v1');
    await links[1]!.trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/tasks/JRY-0004');
    expect(wrapper.get('.task-page').attributes('data-task-id')).toBe('JRY-0004');
    wrapper.unmount();
  });

  it('routes by the address: each section and page has one, back and forward follow it, unknown ones show the overview', async () => {
    expect(parseRoute('')).toEqual({ section: 'overview' });
    expect(parseRoute('#/tasks')).toEqual({ section: 'tasks' });
    expect(parseRoute('#/tasks/JRY-0001')).toEqual({ section: 'tasks', taskId: 'JRY-0001' });
    expect(parseRoute('#/projects/D%3A%5CWork%5Cshop')).toEqual({ section: 'projects', repoRoot: 'D:\\Work\\shop' });
    for (const section of ['timeline', 'data', 'evals', 'settings', 'projects', 'overview']) expect(parseRoute(`#/${section}`)).toEqual({ section });
    for (const unknown of ['#/nope', '#/tasks/not a task', '#/timeline/x', '#/projects/%E0%A4%A']) expect(parseRoute(unknown), unknown).toBeNull();

    // Opened at a task's address: its page shows, and the sidebar marks Tasks.
    window.location.hash = '#/tasks/JRY-0001';
    const wrapper = await mountApp();
    expect(wrapper.get('.task-page').attributes('data-task-id')).toBe('JRY-0001');
    expect(nav(wrapper, 'Tasks').attributes('aria-current')).toBe('page');
    expect(wrapper.get('header nav[aria-label="Breadcrumb"]').text()).toBe('TasksJRY-0001');

    // The browser's back and forward change the address; the view follows.
    window.location.hash = '#/timeline';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    expect(wrapper.get('header h1').text()).toBe('Timeline');
    expect(nav(wrapper, 'Timeline').attributes('aria-current')).toBe('page');
    window.location.hash = '#/tasks/JRY-0001';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    expect(wrapper.find('.task-page').exists()).toBe(true);

    // Sidebar entries are real links to their address.
    expect(nav(wrapper, 'Projects').attributes('href')).toBe('#/projects');
    expect(settingsLink(wrapper).attributes('href')).toBe('#/settings');

    // An unknown address shows the overview and is replaced by its address.
    window.location.hash = '#/nowhere';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();
    expect(wrapper.get('header h1').text()).toBe('Overview');
    expect(window.location.hash).toBe('#/overview');
    wrapper.unmount();
  });

  it('filters tasks at the top by state, project and search, without a folded finished section', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    expect(wrapper.find('.closed-tasks').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Finished and cancelled');
    const tabs = wrapper.findAll('.task-filters [role="tab"]').map((tab) => tab.text());
    expect(tabs).toEqual(['Active4', 'Waiting for you3', 'In review0', 'Finished0', 'Cancelled1', 'All5']);
    expect(shownTiles(wrapper)).toEqual(['JRY-0005', 'JRY-0004', 'JRY-0002', 'JRY-0001']);

    await filterBy(wrapper, 'waiting');
    expect(shownTiles(wrapper)).toEqual(['JRY-0005', 'JRY-0004', 'JRY-0002']);
    await filterBy(wrapper, 'cancelled');
    expect(shownTiles(wrapper)).toEqual(['JRY-0003']);
    await filterBy(wrapper, 'review');
    expect(shownTiles(wrapper)).toEqual([]);
    expect(wrapper.get('.tasks-empty').text()).toBe('No task matches these filters.');
    await filterBy(wrapper, 'all');
    expect(shownTiles(wrapper)).toHaveLength(5);

    await wrapper.get('input.task-search').setValue('greet');
    expect(shownTiles(wrapper)).toEqual(['JRY-0004']);
    await wrapper.get('input.task-search').setValue('jry-0001');
    expect(shownTiles(wrapper)).toEqual(['JRY-0001']);
    expect(wrapper.findAll('.task-filters [role="tab"]').map((tab) => tab.text())).toEqual(['Active1', 'Waiting for you0', 'In review0', 'Finished0', 'Cancelled0', 'All1']);
    // Each count is its own badge next to the label.
    expect(wrapper.findAll('.task-filters [role="tab"] [data-count]').map((badge) => badge.text())).toEqual(['1', '0', '0', '0', '0', '1']);
    await wrapper.get('input.task-search').setValue('');

    // The project filter is a menu of the projects and the other repositories with tasks.
    await wrapper.get('[data-project-filter]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(body().findAll('[role="menuitemradio"]').map((item) => item.text())).toEqual(['All projects', 'shop']);
    await body().findAll('[role="menuitemradio"]').find((item) => item.text() === 'shop')!.trigger('click');
    await flushPromises();
    expect(taskFilters.project).toBe('D:\\Work\\shop');
    expect(wrapper.get('[data-project-filter]').text()).toBe('shop');
    expect(shownTiles(wrapper)).toHaveLength(5);
    wrapper.unmount();
  });

  it('shows each task as a tile and unfolds it in place with the key facts and the decisions', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    const card = tile(wrapper, 'JRY-0002');
    expect(card.text()).toContain('JRY-0002');
    expect(card.text()).toContain('Add login form');
    expect(card.text()).toContain('shop');
    expect(card.text()).toContain('plan v1');
    expect(card.get('.waiting-marker').text()).toContain('waiting for you');
    expect(tile(wrapper, 'JRY-0001').find('.waiting-marker').exists()).toBe(false);
    const badge = card.get('[data-slot="badge"]');
    expect(badge.get('.emoji').text()).toBe(STATE_EMOJI.WAIT_PLAN_APPROVAL);
    expect(badge.text()).toContain('Waiting for plan approval');
    expect(tile(wrapper, 'JRY-0004').text()).toContain('plan v1 · report v2');
    expect(card.find('.task-tile__details').exists()).toBe(false);

    const open = await expand(wrapper, 'JRY-0002');
    // Unfolding stays on the list.
    expect(wrapper.find('.task-page').exists()).toBe(false);
    const details = open.get('.task-tile__details');
    expect(details.text()).toContain('Your decision: approve or reject the plan.');
    expect(details.text()).toContain('src/auth/**');
    expect(details.text()).toContain('Checksnone yet');
    expect(details.text()).toContain('Findingsnone open');
    expect(details.text()).toContain('Reviewdecided at acceptance (review is optional)');
    expect(buttonIn(details, 'Approve plan v1')).toBeDefined();
    expect(buttonIn(details, 'Reject')).toBeDefined();

    const working = await expand(wrapper, 'JRY-0001');
    expect(working.get('.task-tile__details').text()).toContain('Claude: Dashboard card');
    expect(buttonIn(working, 'Approve plan v1')).toBeUndefined();
    // Pause, withdrawing and cancelling are behind '⋯', not on the tile.
    expect(buttonIn(working, 'Pause')).toBeUndefined();
    expect(buttonIn(working, 'Cancel task')).toBeUndefined();
    await working.get('[data-task-menu]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(body().findAll('[role="menuitem"]').map((item) => item.text())).toEqual(['Pause', 'Withdraw approval', 'Cancel task']);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();

    // A finished or cancelled task has no '⋯' menu.
    await filterBy(wrapper, 'cancelled');
    expect(tile(wrapper, 'JRY-0003').find('[data-task-menu]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('opens the task page from the tile header, with every tab', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await tile(wrapper, 'JRY-0001').get('.task-tile__header').trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/tasks/JRY-0001');
    const page = wrapper.get('.task-page');
    expect(page.attributes('data-task-id')).toBe('JRY-0001');
    expect(page.get('.task-page__header').text()).toContain('Core foundation');
    expect(page.get('.task-page__header').text()).toContain('In implementation');
    expect(page.get('.task-page__header a').attributes('href')).toBe('#/projects/D%3A%5CWork%5Cshop');
    expect(page.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(['Overview', 'Plan', 'Analysis', 'Implementation report', 'Review', 'Final report', 'History']);
    expect(page.get('[role="tab"][data-state="active"]').text()).toBe('Overview');
    for (const [tab, marker] of [
      ['plan', '.plan-document, .plan-grade'],
      ['analysis', '.analysis'],
      ['report', '.task-tab--report'],
      ['review', '.task-tab--review'],
      ['final', '.task-tab--final'],
      ['history', 'ol.history'],
      ['overview', '.checkpoint'],
    ] as const) {
      await openTab(wrapper, tab);
      expect(wrapper.find(marker).exists(), tab).toBe(true);
    }
    // The breadcrumb leads back to the list.
    await wrapper.get('header nav a').trigger('click');
    await flushPromises();
    expect(wrapper.find('.task-grid').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows emoji from the shared vocabulary next to their labels, hidden from assistive technology', async () => {
    const wrapper = await mountApp();
    const titles = wrapper.findAll('[data-slot="card-description"]').filter((title) => title.find('.emoji').exists());
    expect(titles.map((title) => title.text())).toEqual([`${EMOJI.jerry}Guard`, `${EMOJI.task}Tasks`, `${EMOJI.warning}Today`]);
    const guard = wrapper.get('[data-guard] [data-slot="badge"]');
    expect(guard.get('.emoji').text()).toBe(EMOJI.jerry);
    await openTasks(wrapper);
    await expand(wrapper, 'JRY-0001');
    const badge = tile(wrapper, 'JRY-0001').get('[data-slot="badge"]');
    expect(badge.get('.emoji').text()).toBe(STATE_EMOJI.IMPLEMENTATION);
    expect(badge.text()).toContain('In implementation');
    const emoji = wrapper.findAll('.emoji');
    expect(emoji.length).toBeGreaterThan(10);
    for (const element of emoji) {
      expect(element.attributes('aria-hidden')).toBe('true');
      // Never alone: the element around the emoji also carries a text label.
      expect(element.element.parentElement!.textContent!.replace(element.text(), '').trim()).not.toBe('');
    }
    // The sidebar uses icons, which are hidden from assistive technology too.
    for (const icon of wrapper.findAll('[data-sidebar="menu-button"] svg')) expect(icon.attributes('aria-hidden')).toBe('true');
    wrapper.unmount();
  });

  it('switches views from the sidebar and names the current one in the top bar', async () => {
    const wrapper = await mountApp();
    expect(wrapper.get('header h1').text()).toBe('Overview');
    expect(nav(wrapper, 'Overview').attributes('aria-current')).toBe('page');
    expect(nav(wrapper, 'Overview').attributes('data-active')).toBe('true');
    // Three tasks wait for the user: the count is next to "Tasks".
    expect(wrapper.get('[data-sidebar="menu-badge"]').text()).toBe('3');
    expect(wrapper.findAll('[data-slot="sidebar-content"] [data-sidebar="menu-button"]').map((item) => item.text())).toEqual(['Overview', 'Tasks', 'Projects', 'Skills', 'Timeline', 'Data', 'Evals']);
    for (const [label, marker] of [
      ['Tasks', '.task'],
      ['Projects', '.projects'],
      ['Timeline', 'table'],
      ['Data', '.data-usage'],
      ['Evals', '.evals'],
      ['Overview', 'section [data-slot="card"]'],
    ] as const) {
      await nav(wrapper, label).trigger('click');
      await flushPromises();
      expect(wrapper.get('header h1').text()).toBe(label);
      expect(nav(wrapper, label).attributes('aria-current')).toBe('page');
      expect(wrapper.get('[data-view]').attributes('data-view')).toBe(label.toLowerCase());
      expect(window.location.hash).toBe(`#/${label.toLowerCase()}`);
      expect(wrapper.find(`[data-view] ${marker}`).exists(), label).toBe(true);
    }
    // Settings sit at the bottom of the sidebar, above Sign out.
    const footer = wrapper.findAll('[data-slot="sidebar-footer"] [data-sidebar="menu-button"]').map((item) => item.text());
    expect(footer).toEqual(['Settings', 'Sign out']);
    await settingsLink(wrapper).trigger('click');
    await flushPromises();
    expect(wrapper.get('header h1').text()).toBe('Settings');
    expect(settingsLink(wrapper).attributes('aria-current')).toBe('page');
    expect(wrapper.find('[data-view="settings"] .settings-workflow').exists()).toBe(true);
    wrapper.unmount();
  });

  it('switches between light, dark and the system theme and remembers the choice', async () => {
    let systemDark = true;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          media: query,
          get matches() {
            return query.includes('prefers-color-scheme: dark') ? systemDark : false;
          },
          addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
        }) as unknown as MediaQueryList,
    );
    startTheme();
    // Nothing stored: the system decides, and it is dark.
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const wrapper = await mountApp();
    const choose = async (label: string) => {
      await wrapper.get('[data-theme-toggle]').trigger('keydown', { key: 'Enter' });
      await flushPromises();
      await body().findAll('[role="menuitemradio"]').find((item) => item.text() === label)!.trigger('click');
      await flushPromises();
    };

    await choose('Light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    await choose('Dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    // "System" follows the operating system while the page is open.
    await choose('System');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    systemDark = false;
    for (const listener of listeners) listener({ matches: false } as MediaQueryListEvent);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // A stored choice wins over the system on the next start.
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    startTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    wrapper.unmount();
  });

  it('keeps working when the browser refuses storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(() => startTheme()).not.toThrow();
    expect(() => setTheme('dark')).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const wrapper = await mountApp();
    expect(wrapper.text()).toContain('GUARDED');
    wrapper.unmount();
  });

  it('renders no inline style of its own: the CSP allows only the stylesheet', async () => {
    // The sources set no style attribute at all, static or bound.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    for (const [name, source] of Object.entries(SOURCES)) expect(source, name).not.toMatch(/\sstyle=|:style|<style/);

    // Rendered: no <style> element; the only inline styles are the ones reka-ui's primitives set
    // through the CSSOM (allowed by style-src 'self'): its CSS variables, outline and animation settings.
    const wrapper = await mountApp();
    const check = (label: string) => {
      expect(wrapper.html(), label).not.toContain('<style');
      for (const element of wrapper.findAll('[style]')) {
        const properties = (element.attributes('style') ?? '')
          .split(';')
          .map((declaration) => declaration.split(':')[0]!.trim())
          .filter((property) => property !== '');
        for (const property of properties) expect(property, `${label}: ${element.html().slice(0, 120)}`).toMatch(/^(--reka-[\w-]+|outline(-\w+)?|animation-duration|animation-name|transition-duration)$/);
      }
    };
    for (const label of ['Overview', 'Tasks', 'Projects', 'Timeline', 'Data', 'Evals']) {
      await nav(wrapper, label).trigger('click');
      await flushPromises();
      check(label);
    }
    // The usage bar, the Usage card's bars and its daily chart size their fills with SVG attributes.
    await nav(wrapper, 'Overview').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-usage-bar] [data-slot="progress"]')).toHaveLength(2);
    expect(wrapper.findAll('.usage-card [data-slot="progress"]')).toHaveLength(2);
    expect(wrapper.findAll('.usage-card [data-usage-chart] [data-day]')).toHaveLength(30);
    for (const element of wrapper.findAll('[data-slot="progress"], [data-slot="progress"] *, [data-usage-chart] *')) expect(element.attributes('style'), element.html().slice(0, 80)).toBeUndefined();
    await openTasks(wrapper);
    await expand(wrapper, 'JRY-0004');
    check('expanded tile');
    for (const address of ['#/tasks/JRY-0004', '#/projects/D%3A%5CWork%5Cshop', '#/settings']) {
      window.location.hash = address;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await flushPromises();
      check(address);
    }
    wrapper.unmount();
  });

  it('pauses with one click from the menu and cancels only after the task ID is typed', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await menuItem(tile(wrapper, 'JRY-0001'), 'Pause');
    const pause = calls.find((call) => call.url === '/api/v1/tasks/JRY-0001/transitions' && call.init?.method === 'POST')!;
    expect(JSON.parse(String(pause.init?.body))).toEqual({ event: 'task.paused' });
    expect(state.notice).toBe('Paused JRY-0001.');

    await menuItem(tile(wrapper, 'JRY-0002'), 'Cancel task');
    expect(body().get('form.dialog h2').text()).toBe('Cancel JRY-0002');
    expect(body().get('form.dialog button[type="submit"]').attributes('disabled')).toBeDefined();
    await confirmWith('JRY-0002');
    const cancel = calls.find((call) => call.url === '/api/v1/tasks/JRY-0002/transitions')!;
    expect(JSON.parse(String(cancel.init?.body))).toEqual({ event: 'task.cancelled', confirmTaskId: 'JRY-0002' });
    expect((cancel.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    wrapper.unmount();
  });

  it('shows which sessions worked on a task and Claude’s last checkpoint', async () => {
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0001');
    expect(page.text()).toContain('2 sessions · last activity');
    expect(page.text()).toContain('last session ended');
    expect(page.get('.checkpoint').text()).toContain('Store and API for sessions are done.');
    expect(page.findAll('.checkpoint li').map((item) => item.text())).toEqual(['Dashboard card', 'Live check']);
    const waiting = await openTask(wrapper, 'JRY-0002', 'overview');
    expect(waiting.text()).toContain('No session has worked on it yet');
    expect(waiting.find('.checkpoint').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the implementation report next to what JERRY recorded, with accept and request-changes in one click', async () => {
    decisionMode = 'click';
    const wrapper = await mountApp();
    // Waiting for acceptance: the page opens on the report.
    const page = await openTask(wrapper, 'JRY-0004');
    expect(page.get('[role="tab"][data-state="active"]').text()).toBe('Implementation report');
    const report = page.get('.report');
    expect(report.text()).toContain('Implementation report v2');
    expect(report.text()).toContain('Added greet(name) and its unit test.');
    expect(report.get('.evidence').attributes('data-attention')).toBe('true');
    expect(report.get('.evidence').text()).toContain('Edited but not in the report: README.md');
    expect(report.text()).toContain('1 check(s) failed or did not run.');
    expect(report.text()).toContain('NOT_RUN');
    expect(report.text()).toContain('QA-1 Greeting for a named user');
    // An older report does not say its QA language: no badge.
    expect(report.find('.qa-language').exists()).toBe(false);
    const header = page.get('.task-page__header');
    expect(buttonIn(header, 'Approve plan v1')).toBeUndefined();

    await buttonIn(header, 'Request changes')!.trigger('click');
    expect(body().get('form.dialog h2').text()).toBe('Request changes to JRY-0004 report v2');
    // The comment field stays; the decision button is ready without typing.
    expect(body().get('form.dialog button[type="submit"]').attributes('disabled')).toBeUndefined();
    await decideWith('Also handle empty names.');
    // A one-click decision still sends the task ID (every Core accepts it).
    expect(posted('/api/v1/tasks/JRY-0004/approvals')).toEqual([{ stage: 'IMPLEMENTATION', version: 2, decision: 'REJECTED', comment: 'Also handle empty names.', confirmTaskId: 'JRY-0004' }]);
    expect(state.notice).toBe('Requested changes to JRY-0004 report v2.');

    await buttonIn(header, 'Accept implementation')!.trigger('click');
    expect(body().find('form.dialog textarea').exists()).toBe(false);
    await decideWith();
    expect(posted('/api/v1/tasks/JRY-0004/approvals').at(-1)).toMatchObject({ stage: 'IMPLEMENTATION', version: 2, decision: 'APPROVED' });
    wrapper.unmount();
  });

  it('shows the QA language of a report as a badge', async () => {
    const base = globalThis.fetch;
    const english: TaskSummary = { ...reportedTask, lastReport: { ...reportedTask.lastReport!, document: { ...reportedTask.lastReport!.document, qaLanguage: 'en' } } };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/tasks') return new Response(JSON.stringify([english]), { status: 200, headers: { 'content-type': 'application/json' } });
      return base(url, init);
    });
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0004');
    expect(page.get('.report .qa [data-slot="collapsible-trigger"]').text()).toContain('Manual QA (1)EN');
    expect(page.get('.qa-language').attributes('title')).toBe('The QA scenarios are written in English');
    wrapper.unmount();
  });

  it('accepts in one click with the choice of independent review: off by default when optional, on and locked when required', async () => {
    decisionMode = 'click';
    const base = globalThis.fetch;
    const required: TaskSummary = { ...reportedTask, taskId: 'JRY-0006', title: 'Payments', effectiveReviewMode: 'required' };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/tasks') return new Response(JSON.stringify([reportedTask, required]), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks/JRY-0006/approvals') {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ...reportedTask.planDecision, taskId: 'JRY-0006' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await openTasks(wrapper);

    // Optional: the switch starts off; turning it on sends the task to review.
    await buttonIn(await expand(wrapper, 'JRY-0004'), 'Accept implementation')!.trigger('click');
    await flushPromises();
    let choice = body().get('form.dialog .review-choice');
    expect(choice.attributes('data-review-mode')).toBe('optional');
    expect(choice.text()).toContain('Send to independent review');
    expect(choice.get('[role="switch"]').attributes('aria-checked')).toBe('false');
    expect(choice.get('[role="switch"]').attributes('disabled')).toBeUndefined();
    expect(choice.text()).toContain('No review: JERRY runs the final checks right away');
    await choice.get('[role="switch"]').trigger('click');
    expect(body().get('form.dialog [role="switch"]').attributes('aria-checked')).toBe('true');
    // One click: the decision button is ready.
    expect(body().get('form.dialog button[type="submit"]').attributes('disabled')).toBeUndefined();
    await decideWith();
    expect(posted('/api/v1/tasks/JRY-0004/approvals')).toEqual([{ stage: 'IMPLEMENTATION', version: 2, decision: 'APPROVED', comment: '', confirmTaskId: 'JRY-0004', review: true }]);

    // Without turning it on: no review.
    await buttonIn(tile(wrapper, 'JRY-0004'), 'Accept implementation')!.trigger('click');
    await flushPromises();
    await decideWith();
    expect(posted('/api/v1/tasks/JRY-0004/approvals').at(-1)).toMatchObject({ decision: 'APPROVED', review: false });

    // Required: on and disabled.
    await buttonIn(await expand(wrapper, 'JRY-0006'), 'Accept implementation')!.trigger('click');
    await flushPromises();
    choice = body().get('form.dialog .review-choice');
    expect(choice.attributes('data-review-mode')).toBe('required');
    expect(choice.get('[role="switch"]').attributes('aria-checked')).toBe('true');
    expect(choice.get('[role="switch"]').attributes('disabled')).toBeDefined();
    expect(choice.text()).toContain('Review is required for this project');
    await decideWith();
    expect(posted('/api/v1/tasks/JRY-0006/approvals')).toEqual([{ stage: 'IMPLEMENTATION', version: 2, decision: 'APPROVED', comment: '', confirmTaskId: 'JRY-0006', review: true }]);
    wrapper.unmount();
  });

  it('shows why JERRY refused DONE and lets the user send the work back', async () => {
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0005');
    const check = page.get('.final-check');
    expect(check.attributes('data-passed')).toBe('false');
    expect(check.text()).toContain('JERRY did not complete the task');
    expect(check.text()).toContain('blocks failed: npm test');
    expect(check.text()).toContain('note no check ran');
    expect(buttonIn(page.get('.task-page__header'), 'Request changes')).toBeDefined();
    expect(buttonIn(page.get('.task-page__header'), 'Accept implementation')).toBeUndefined();
    wrapper.unmount();
  });

  it('lists what blocks DONE and the later work of other tasks on the task page', async () => {
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0005', 'overview');
    const check = page.get('.final-check');
    expect(check.findAll('.final-check__failed li').map((item) => item.attributes('data-condition'))).toEqual(['report.no-failed-checks']);
    // Each blocker says what fixes it: a failed check in the report needs a new report.
    expect(check.get('[data-condition="report.no-failed-checks"] [data-remedy]').text()).toContain('request changes');
    const later = check.get('.final-check__later-work');
    expect(later.text()).toContain('Changed later by other tasks');
    expect(later.get('[data-later-task="JRY-0009"]').text()).toBe('JRY-0009: src/lexer.ts, src/parser.ts');
    expect(later.get('a').attributes('href')).toBe('#/tasks/JRY-0009');
    // Waiting in final checks: the checks can be re-run from the page.
    expect(buttonIn(page.get('.task-page__header'), 'Re-run final checks')).toBeDefined();
    wrapper.unmount();
  });

  it('re-runs the final checks of a task Core held back, from the tile and the task page, in one click', async () => {
    decisionMode = 'click';
    const base = globalThis.fetch;
    let current: TaskSummary = refusedTask;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([reportedTask, current]);
      if (url === '/api/v1/tasks/JRY-0005/final-checks') {
        calls.push({ url, init });
        const passed = { ...refusedTask.finalCheck!, passed: true, conditions: refusedTask.finalCheck!.conditions.map((condition) => ({ ...condition, passed: condition.blocking ? true : condition.passed })) };
        current = { ...refusedTask, state: 'DONE', finalCheck: passed };
        return json({ check: passed, state: 'DONE' });
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await openTasks(wrapper);
    taskFilters.filter = 'all';
    await flushPromises();
    // Only the task in final checks offers it; Request changes stays next to it.
    expect(buttonIn(tile(wrapper, 'JRY-0004'), 'Re-run final checks')).toBeUndefined();
    const refused = await expand(wrapper, 'JRY-0005');
    expect(buttonIn(refused, 'Request changes')).toBeDefined();
    await buttonIn(refused, 'Re-run final checks')!.trigger('click');
    await flushPromises();
    expect(body().get('form.dialog h2').text()).toBe('Re-run the final checks of JRY-0005');
    expect(body().get('form.dialog').text()).toContain('the task is done if they pass');
    await decideWith();
    // A one-click decision still sends the task ID (every Core accepts it).
    expect(posted('/api/v1/tasks/JRY-0005/final-checks')).toEqual([{ confirmTaskId: 'JRY-0005' }]);
    expect(calls.find((call) => call.url === '/api/v1/tasks/JRY-0005/final-checks')?.init?.headers).toMatchObject({ 'x-jerry-csrf': CSRF });
    expect(state.notice).toBe("Re-ran the final checks of JRY-0005. JERRY's final checks passed: the task is done.");
    // Done now: the action is gone.
    const page = await openTask(wrapper, 'JRY-0005');
    expect(buttonIn(page.get('.task-page__header'), 'Re-run final checks')).toBeUndefined();
    wrapper.unmount();
  });

  it('re-runs the final checks from the task page with the typed task ID when the user chose typed confirmations', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/tasks/JRY-0005/final-checks') {
        calls.push({ url, init });
        return new Response(JSON.stringify({ check: refusedTask.finalCheck, state: 'FINAL_REPORT' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0005');
    await buttonIn(page.get('.task-page__header'), 'Re-run final checks')!.trigger('click');
    await flushPromises();
    // Only the report blocks it: the dialog says a re-run cannot pass.
    expect(body().get('form.dialog [data-rerun-warning]').text()).toContain('Request changes instead');
    await confirmWith('JRY-0005');
    expect(posted('/api/v1/tasks/JRY-0005/final-checks')).toEqual([{ confirmTaskId: 'JRY-0005' }]);
    expect(state.notice).toBe("Re-ran the final checks of JRY-0005. JERRY's final checks did not pass.");
    wrapper.unmount();
  });

  it('keeps the standard re-run note when files changed after the report block the task', async () => {
    const base = globalThis.fetch;
    const edited: TaskSummary = {
      ...refusedTask,
      finalCheck: { ...refusedTask.finalCheck!, conditions: [{ id: 'code.unchanged-since-report', blocking: true, passed: false, detail: 'edited after report v2 was submitted: src/parser.ts' }] },
    };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => (url === '/api/v1/tasks' ? new Response(JSON.stringify([edited]), { status: 200, headers: { 'content-type': 'application/json' } }) : base(url, init)));
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0005', 'overview');
    expect(page.get('[data-condition="code.unchanged-since-report"] [data-remedy]').text()).toContain('re-run the final checks');
    await buttonIn(page.get('.task-page__header'), 'Re-run final checks')!.trigger('click');
    await flushPromises();
    expect(body().find('form.dialog [data-rerun-warning]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("says how to continue a task sent back to implementation, with the user's request", async () => {
    const base = globalThis.fetch;
    const rejected = { ...reportedTask.planDecision!, approvalId: 'apr_9', taskId: 'JRY-0001', stage: 'IMPLEMENTATION' as const, decision: 'REJECTED' as const, comment: 'remove the pre-fix check from the report' };
    const sentBack: TaskSummary = { ...approvedTask, lastCheckpoint: null, lastReport: { ...reportedTask.lastReport!, taskId: 'JRY-0001' }, reportDecision: rejected };
    const fixing: TaskSummary = { ...reportedTask, taskId: 'JRY-0006', title: 'Fixing', state: 'FIX_IMPLEMENTATION' };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      url === '/api/v1/tasks' ? new Response(JSON.stringify([sentBack, fixing, reportedTask]), { status: 200, headers: { 'content-type': 'application/json' } }) : base(url, init),
    );
    const wrapper = await mountApp();
    await openTasks(wrapper);
    taskFilters.filter = 'all';
    await flushPromises();
    const sentBackTile = await expand(wrapper, 'JRY-0001');
    expect(sentBackTile.text()).toContain('You requested changes ("remove the pre-fix check from the report"): run /jerry:implement JRY-0001 in Claude Code to continue.');
    await buttonIn(sentBackTile, 'Continue in Claude Code')!.trigger('click');
    await flushPromises();
    expect(body().get('.continue-in-claude [data-instruction]').text()).toBe('/jerry:implement JRY-0001');
    expect(body().get('.continue-in-claude [data-sent-back]').text()).toContain('remove the pre-fix check from the report');
    await buttonIn(body().get('.continue-in-claude'), 'Close')!.trigger('click');
    await flushPromises();
    // Fixing review findings continues with /jerry:review.
    await buttonIn(await expand(wrapper, 'JRY-0006'), 'Continue in Claude Code')!.trigger('click');
    await flushPromises();
    expect(body().get('.continue-in-claude [data-instruction]').text()).toBe('/jerry:review JRY-0006');
    expect(body().find('.continue-in-claude [data-sent-back]').exists()).toBe(false);
    await buttonIn(body().get('.continue-in-claude'), 'Close')!.trigger('click');
    await flushPromises();
    // Waiting for the user: nothing to continue in Claude Code.
    expect(buttonIn(await expand(wrapper, 'JRY-0004'), 'Continue in Claude Code')).toBeUndefined();
    wrapper.unmount();
  });

  it('shows the scope and the Definition of Done the user confirms when accepting, folded until opened', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await buttonIn(await expand(wrapper, 'JRY-0004'), 'Accept implementation')!.trigger('click');
    await flushPromises();
    const dialog = body().get('form.dialog');
    const definitionOfDone = samplePlan('D:\\Work\\shop', ['src/auth/**']).definitionOfDone;
    const trigger = (section: string) => dialog.get(`[data-details="${section}"] button`);
    // Both sections start folded, with their size in the heading.
    expect(trigger('scope').text()).toBe('Scope (1)');
    expect(trigger('definition-of-done').text()).toBe(`Definition of Done you confirm (${definitionOfDone.length})`);
    expect(trigger('scope').attributes('aria-expanded')).toBe('false');
    expect(trigger('definition-of-done').attributes('aria-expanded')).toBe('false');
    expect(dialog.text()).not.toContain(definitionOfDone[0]);
    // Opening one keeps the other as it was; opening a section does not submit the decision.
    await trigger('definition-of-done').trigger('click');
    await flushPromises();
    for (const item of definitionOfDone) expect(dialog.text()).toContain(item);
    expect(trigger('scope').attributes('aria-expanded')).toBe('false');
    await trigger('scope').trigger('click');
    await flushPromises();
    expect(dialog.get('[data-details="scope"] code').text()).toBe('src/auth/**');
    expect(posted('/api/v1/tasks/JRY-0004/approvals')).toEqual([]);
    wrapper.unmount();
  });

  it('shows the analysts’ reports with unverified citations, and a run without a report as a gap', async () => {
    const wrapper = await mountApp();
    const analysis = (await openTask(wrapper, 'JRY-0001', 'analysis')).get('.analysis');
    expect(analysis.text()).toContain('Risk');
    expect(analysis.text()).toContain('medium confidence');
    expect(analysis.text()).toContain('Passwords are compared without constant time');
    expect(analysis.text()).toContain('Unverified citations: src/auth/login.ts:999 (beyond end of file)');
    expect(analysis.text()).toContain('jerry:jerry-quality-analyst: stopped without a report (a gap, not a result)');
    expect(analysis.text()).toContain('Gaps: Rate limiting not checked');
    wrapper.unmount();
  });

  it('shows the plan completeness check as information next to the plan', async () => {
    const wrapper = await mountApp();
    // Waiting for plan approval: the page opens on the plan.
    const page = await openTask(wrapper, 'JRY-0002');
    expect(page.get('[role="tab"][data-state="active"]').text()).toBe('Plan');
    const grade = page.get('.plan-grade');
    expect(grade.text()).toContain('incomplete');
    expect(grade.text()).toContain('71/100');
    expect(grade.text()).toContain('informational, you decide');
    expect(grade.text()).toContain('changes outside the scope (edits there will be deviations): src/app.ts');
    expect(grade.text()).not.toContain('1 risk(s) with mitigations');
    // The approval stays available: the check never blocks.
    expect(buttonIn(page.get('.task-page__header'), 'Approve plan v1')).toBeDefined();
    wrapper.unmount();
  });

  it('shows quality findings and dismisses one only with the typed ID and a reason', async () => {
    const base = globalThis.fetch;
    const finding = (id: number, severity: 'P2' | 'P4', status: string, title: string) => ({
      findingId: `FND-${id}`,
      taskId: 'JRY-0001',
      repoRoot: 'D:\\Work\\shop',
      ruleId: severity === 'P2' ? 'errors.empty-catch' : 'naming.vague-name',
      ruleVersion: '1.0.0',
      source: 'static',
      category: 'error-handling',
      severity,
      confidence: 0.9,
      file: 'src/auth/login.ts',
      lineStart: id * 10,
      lineEnd: id * 10,
      title,
      evidence: 'run().then(done, ignore);',
      whyItMatters: 'An empty catch hides failures.',
      suggestedFix: 'Handle or rethrow.',
      planRelated: true,
      status,
      statusReason: status === 'FIXED' ? 'no longer found' : '',
      sessionId: 's2',
      agentId: null,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      updatedAt: NOW,
    });
    const list = [finding(1, 'P2', 'OPEN', 'Exception swallowed silently'), finding(2, 'P4', 'FIXED', 'Vague name')];
    const withFindings: TaskSummary = { ...approvedTask, findings: { open: 1, bySeverity: { P1: 0, P2: 1, P3: 0, P4: 0 }, fixed: 1, dismissed: 0 } };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([withFindings]);
      if (url.startsWith('/api/v1/findings?taskId=JRY-0001')) return json(list);
      if (url === '/api/v1/findings/FND-1/status') {
        calls.push({ url, init });
        return json({ ...list[0], status: 'FALSE_POSITIVE' });
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await openTasks(wrapper);
    // The tile counts the open findings by severity.
    expect((await expand(wrapper, 'JRY-0001')).get('.task-tile__details').text()).toContain('Findings🟠1 P2');
    await openTask(wrapper, 'JRY-0001');
    const panel = wrapper.get('.findings');
    expect(panel.get('[data-slot="collapsible-trigger"]').text()).toContain('1 open');
    expect(panel.get('[data-slot="collapsible-trigger"]').text()).toContain('1 P2 · 1 fixed');
    expect(panel.text()).toContain('Exception swallowed silently');
    expect(panel.text()).not.toContain('Vague name');
    await panel.get('.findings__filters [role="switch"]').trigger('click');
    expect(panel.text()).toContain('Vague name');

    await panel.findAll('button').find((candidate) => candidate.text() === 'False positive')!.trigger('click');
    const submit = body().get('form.dialog button[type="submit"]');
    await body().get('form.dialog input').setValue('FND-1');
    expect(submit.attributes('disabled')).toBeDefined();
    await body().get('form.dialog textarea').setValue('the catch is in generated code');
    expect(submit.attributes('disabled')).toBeUndefined();
    await body().get('form.dialog').trigger('submit');
    await flushPromises();
    const decision = calls.find((call) => call.url === '/api/v1/findings/FND-1/status')!;
    expect(JSON.parse(String(decision.init?.body))).toEqual({ status: 'FALSE_POSITIVE', reason: 'the catch is in generated code' });
    expect((decision.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    wrapper.unmount();
  });

  /** A review round with a P1 finding and a fix plan waiting for the user. */
  const reviewWithFixPlan = (taskId: string, reviewState: string) => ({
    taskId,
    state: reviewState,
    outcome: null,
    maxRounds: 3,
    openFindings: [{ findingId: 'FND-4', taskId, repoRoot: 'D:\\Work\\shop', ruleId: 'review', ruleVersion: '1', source: 'review', category: 'security', severity: 'P1', confidence: 0.8, file: 'src/auth/login.ts', lineStart: 12, lineEnd: 12, title: 'Timing attack on login', evidence: 'a === b', whyItMatters: 'x', suggestedFix: 'y', planRelated: false, status: 'OPEN', statusReason: '', sessionId: null, agentId: null, firstSeenAt: NOW, lastSeenAt: NOW, updatedAt: NOW }],
    rounds: [
      {
        round: 1,
        startedAt: NOW,
        completedAt: NOW,
        changedFiles: ['src/auth/login.ts', 'src/auth/token.ts'],
        submissions: [
          { role: 'jerry-correctness-reviewer', agentId: 'r1', filesReviewed: ['src/auth/login.ts'], summary: 's', findings: 0, gaps: [], independent: true, independenceNote: 'ok', at: NOW },
          { role: 'jerry-security-reviewer', agentId: null, filesReviewed: ['src/auth/login.ts'], summary: 's', findings: 1, gaps: [], independent: false, independenceNote: 'submitted from the main session', at: NOW },
        ],
        uncovered: ['src/auth/token.ts'],
        fixPlan: { summary: 'Constant-time comparison', items: [{ findings: ['FND-4'], change: 'use timingSafeEqual', files: ['src/auth/login.ts'] }], tests: [], notFixed: [] },
        fixPlanHash: `sha256:${'c'.repeat(64)}`,
        fixesSummary: null,
        passedAt: null,
        skippedAt: null,
        skipReason: null,
      },
    ],
  });

  it('shows the independent review and lets the user approve the fix plan or waive the review', async () => {
    const base = globalThis.fetch;
    const reviewTask: TaskSummary = { ...approvedTask, taskId: 'JRY-0007', title: 'Reviewed change', state: 'WAIT_REVIEW_FIX_APPROVAL', reviewRequested: true };
    const review = reviewWithFixPlan('JRY-0007', 'WAIT_REVIEW_FIX_APPROVAL');
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([reviewTask]);
      if (url === '/api/v1/tasks/JRY-0007/review') return json(review);
      if (url === '/api/v1/tasks/JRY-0007/approvals' || url === '/api/v1/tasks/JRY-0007/review/skip') {
        calls.push({ url, init });
        return json(url.endsWith('skip') ? review : { ...approvedTask.planDecision, taskId: 'JRY-0007', stage: 'REVIEW_FIX' }, url.endsWith('skip') ? 200 : 201);
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await openTasks(wrapper);
    // The tile shows the round; the fix plan can be decided from it.
    const details = (await expand(wrapper, 'JRY-0007')).get('.task-tile__details');
    expect(details.text()).toContain('Reviewin review · round 1 of at most 3');
    await buttonIn(details, 'Approve fix plan')!.trigger('click');
    await flushPromises();
    expect(body().get('form.dialog h2').text()).toBe('Approve the fix plan of JRY-0007 (round 1)');
    await confirmWith('JRY-0007');
    expect(posted('/api/v1/tasks/JRY-0007/approvals')).toEqual([{ stage: 'REVIEW_FIX', version: 1, decision: 'APPROVED', comment: '', confirmTaskId: 'JRY-0007' }]);

    // The task page opens on the review.
    const page = await openTask(wrapper, 'JRY-0007');
    expect(page.get('[role="tab"][data-state="active"]').text()).toBe('Review');
    await flushPromises();
    const panel = wrapper.get('.review');
    expect(panel.text()).toContain('1 open finding(s)');
    expect(panel.text()).toContain('round 1 of at most 3');
    expect(panel.text()).toContain('Architecture, quality, UX: no report (gap)');
    expect(panel.text()).toContain('not independent: submitted from the main session');
    expect(panel.text()).toContain('Changed files no reviewer covered: src/auth/token.ts');
    expect(panel.text()).toContain('FND-4: use timingSafeEqual');

    await panel.findAll('button').find((candidate) => candidate.text() === 'Approve fix plan')!.trigger('click');
    await confirmWith('JRY-0007');
    expect(posted('/api/v1/tasks/JRY-0007/approvals')).toHaveLength(2);

    await wrapper.get('.review').findAll('button').find((candidate) => candidate.text() === 'Waive review')!.trigger('click');
    await body().get('form.dialog input').setValue('JRY-0007');
    expect(body().get('form.dialog button[type="submit"]').attributes('disabled')).toBeDefined();
    await body().get('form.dialog textarea').setValue('prototype only');
    await body().get('form.dialog').trigger('submit');
    await flushPromises();
    expect(posted('/api/v1/tasks/JRY-0007/review/skip')).toEqual([{ reason: 'prototype only', confirmTaskId: 'JRY-0007' }]);
    wrapper.unmount();
  });

  it('skips the review from a tile with a reason and the typed ID, and shows how to start it in Claude Code', async () => {
    const base = globalThis.fetch;
    const inReview: TaskSummary = { ...approvedTask, taskId: 'JRY-0008', title: 'Search box', state: 'CODE_REVIEW', reviewRequested: true };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([inReview, approvedTask]);
      if (url === '/api/v1/tasks/JRY-0008/review/skip') {
        calls.push({ url, init });
        return json(noReview('JRY-0008'));
      }
      return base(url, init);
    });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await filterBy(wrapper, 'review');
    expect(shownTiles(wrapper)).toEqual(['JRY-0008']);
    const details = (await expand(wrapper, 'JRY-0008')).get('.task-tile__details');
    expect(details.text()).toContain('start /jerry:review in Claude Code, or skip the review');
    // In review: Skip and Start review are on the tile; Pause and Cancel stay in the menu.
    expect(details.findAll('.task-actions button').map((button) => button.text())).toEqual(['Start review', 'Skip review']);

    await buttonIn(details, 'Start review')!.trigger('click');
    await flushPromises();
    const instruction = body().get('.start-review [data-instruction]');
    expect(instruction.text()).toBe('/jerry:review JRY-0008');
    await buttonIn(body().get('.start-review'), 'Copy')!.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('/jerry:review JRY-0008');
    expect(buttonIn(body().get('.start-review'), 'Copied')).toBeDefined();
    await buttonIn(body().get('.start-review'), 'Close')!.trigger('click');
    await flushPromises();

    await buttonIn(tile(wrapper, 'JRY-0008'), 'Skip review')!.trigger('click');
    await flushPromises();
    expect(body().get('form.dialog h2').text()).toBe('Skip the review of JRY-0008');
    await body().get('form.dialog #confirm-typed').setValue('JRY-0008');
    // The reason is required.
    expect(body().get('form.dialog button[type="submit"]').attributes('disabled')).toBeDefined();
    await confirmWith('JRY-0008', 'small change, reviewed by hand');
    expect(posted('/api/v1/tasks/JRY-0008/review/skip')).toEqual([{ reason: 'small change, reviewed by hand', confirmTaskId: 'JRY-0008' }]);
    expect(state.notice).toContain('Skipped the review of JRY-0008.');
    wrapper.unmount();
  });

  it('shows the final report and Artifact decisions, linking only to claude.ai Artifacts', async () => {
    const base = globalThis.fetch;
    const finalReport = {
      taskId: 'JRY-0004',
      title: 'Greeting helper',
      state: 'DONE',
      status: 'final',
      completedAt: NOW,
      generatedAt: NOW,
      goal: 'Add a greeting helper.',
      repositories: [{ repository: 'D:\\Work\\shop', changes: [{ path: 'src/greeting/greet.ts', kind: 'added', description: '<img src=x onerror=alert(1)>' }] }],
      diffSummary: { files: 1, added: 1, modified: 0, deleted: 0, renamed: 0, seenByGit: [], unreported: [] },
      tests: { checks: [{ kind: 'test', command: 'npm test', result: 'PASS', details: '' }], observedRuns: [], claimedVsObserved: [] },
      qa: [],
      security: { risks: [], openFindings: [], securityFindings: [] },
      review: { requested: true, outcome: 'passed', rounds: 2, reviewers: [], findings: { total: 1, fixed: 1, open: [] }, uncovered: [] },
      rules: { skills: [], deviations: 0, blocked: 0, planDeviations: [] },
      commitSubjects: ['feat(greeting): add greet helper'],
      artifact: { planned: 'wanted: stakeholder presentation', decision: 'created', kind: 'stakeholder-presentation', title: 'Greeting overview', url: 'https://claude.ai/code/artifact/abc-123' },
      coverage: { reviewedFiles: ['src/greeting/greet.ts'], notReviewed: [], checksNotRun: [] },
      limitations: ['no check ran: recorded as a limitation'],
      decisions: [],
      definitionOfDone: { items: ['greet implemented'], passed: true, evidence: [] },
    };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks/JRY-0004/final-report') return json(finalReport);
      if (url === '/api/v1/tasks/JRY-0005/final-report') {
        return json({ ...finalReport, taskId: 'JRY-0005', review: { ...finalReport.review, requested: false, outcome: 'not requested', rounds: 0, findings: { total: 0, fixed: 0, open: [] } }, laterWork: [{ taskId: 'JRY-0009', files: ['src/lexer.ts', 'src/parser.ts'] }] });
      }
      if (url === '/api/v1/artifacts') {
        return json([
          { taskId: 'JRY-0004', decision: 'created', kind: 'stakeholder-presentation', title: 'Greeting overview', url: 'https://claude.ai/code/artifact/abc-123', reason: '', at: NOW },
          { taskId: 'JRY-0009', decision: 'created', kind: 'other', title: 'Hostile', url: 'javascript:alert(1)', reason: '', at: NOW },
          { taskId: 'JRY-0010', decision: 'declined', kind: null, title: null, url: null, reason: 'not needed', at: NOW },
        ]);
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await flushPromises();
    const artifacts = wrapper.get('.artifacts');
    expect(artifacts.text()).toContain('Artifacts (2)');
    expect(artifacts.text()).toContain('declined: not needed');
    const links = artifacts.findAll('a').map((link) => link.attributes('href'));
    expect(links).toEqual(['https://claude.ai/code/artifact/abc-123']);

    await openTask(wrapper, 'JRY-0004', 'final');
    await flushPromises();
    const report = wrapper.get('.final-report');
    expect(report.text()).toContain('Review: passed after 2 round(s)');
    expect(report.text()).toContain('feat(greeting): add greet helper');
    expect(report.get('a').attributes()).toMatchObject({ href: 'https://claude.ai/code/artifact/abc-123', rel: 'noopener noreferrer' });
    // Content is text, never markup.
    expect(report.html()).not.toContain('<img');
    expect(report.text()).toContain('<img src=x onerror=alert(1)>');
    // No other task changed its files later (and an older Core sends no list): no such section.
    expect(report.find('.final-report__later-work').exists()).toBe(false);

    // Accepted without review: the final report says so.
    await openTask(wrapper, 'JRY-0005', 'final');
    await flushPromises();
    expect(wrapper.get('.final-report .final-report__review').text()).toBe(`${EMOJI.review}Review: not requested at acceptance`);
    // Files a later task changed under its own approved plan.
    expect(wrapper.get('.final-report .final-report__later-work').text()).toBe(`${EMOJI.info}Changed later by other tasksJRY-0009: src/lexer.ts, src/parser.ts`);
    wrapper.unmount();
  });

  const idleRunner = { state: 'idle', startedAt: null, finishedAt: null, exitCode: null, suite: null, label: '', logFile: null, logTail: [], runId: null, unavailable: null, suites: [{ suite: 'capability', cases: 3 }, { suite: 'regression', cases: 5 }] };

  it('runs the evals from the dashboard after a confirmation, follows the run and shows the run it recorded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const base = globalThis.fetch;
    let runner: Record<string, unknown> = idleRunner;
    const fingerprint = { total: 'f', components: { skills: 'a', agents: 'b', hooks: 'c', rules: 'd' } };
    const run = { runId: 'EVR-3', startedAt: NOW, finishedAt: NOW, jerryVersion: '0.0.1', fingerprint, label: 'nightly', counts: { PASS: 8, FAIL: 0, FLAKY: 0, ERROR: 0 }, isBaseline: false };
    let runs: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/evals/runs') return json(runs);
      if (url === '/api/v1/evals/runs/EVR-3') return json({ ...run, results: [], comparison: { baselineRunId: null, cases: [], regressions: [], releaseBlocked: false } });
      if (url === '/api/v1/evals/status') return json({ baselineRunId: null, latestRunId: null, fingerprint, changedSinceBaseline: [], releaseBlocked: false });
      if (url === '/api/v1/evals/calibration') return json([]);
      if (url === '/api/v1/evals/runner') return json(runner);
      if (url === '/api/v1/evals/runner/start') {
        calls.push({ url, init });
        runner = { ...idleRunner, state: 'running', startedAt: NOW, suite: 'regression', label: 'nightly', logFile: 'C:/J/run/eval-runs/x.log', logTail: ['Running 5 case(s)'] };
        return json(runner, 202);
      }
      return base(url, init);
    });
    try {
      const wrapper = await mountApp();
      await nav(wrapper, 'Evals').trigger('click');
      await flushPromises();
      expect(wrapper.text()).toContain('Start one with Run evals');
      await wrapper.get('[data-run-evals]').trigger('click');
      await flushPromises();
      const dialog = body().get('[role="alertdialog"]');
      expect(dialog.text()).toContain('Starts real Claude Code sessions');
      expect(dialog.text()).toContain('8 case(s)');
      const suites = await openSelect(dialog.get('#eval-suite'));
      expect(suites.map((option) => option.text())).toEqual(['All (8)', 'capability (3)', 'regression (5)']);
      await chooseOption(suites, 'regression (5)');
      expect(dialog.text()).toContain('5 case(s)');
      await dialog.get('#eval-label').setValue('nightly');
      if (dialog.find('#confirm-typed').exists()) await dialog.get('#confirm-typed').setValue('evals');
      await dialog.get('form').trigger('submit');
      await flushPromises();
      expect(JSON.parse(String(calls.find((call) => call.url === '/api/v1/evals/runner/start')!.init?.body))).toEqual({ suite: 'regression', label: 'nightly' });
      expect(wrapper.get('.eval-runner').attributes('data-runner-state')).toBe('running');
      expect(wrapper.get('.eval-runner__log').text()).toContain('Running 5 case(s)');
      expect(wrapper.get('[data-run-evals]').attributes('disabled')).toBeDefined();
      expect(wrapper.find('[data-stop-evals]').exists()).toBe(true);

      // The panel closes; a small "Show progress" stands in for it while the run runs.
      await wrapper.get('[data-close-runner]').trigger('click');
      expect(wrapper.find('.eval-runner').exists()).toBe(false);
      await wrapper.get('[data-show-progress]').trigger('click');
      expect(wrapper.find('.eval-runner').exists()).toBe(true);

      // It finishes: the run joins the list, and the panel opens it.
      runner = { ...runner, state: 'finished', finishedAt: NOW, exitCode: 0, runId: 'EVR-3' };
      runs = [run];
      await vi.advanceTimersByTimeAsync(2100);
      await flushPromises();
      expect(wrapper.get('.eval-runner').attributes('data-runner-state')).toBe('finished');
      expect(wrapper.findAll('.eval-runs [data-run-id]').map((row) => row.attributes('data-run-id'))).toEqual(['EVR-3']);
      await wrapper.get('[data-open-run]').trigger('click');
      await flushPromises();
      expect(window.location.hash).toBe('#/evals/EVR-3');
      expect(wrapper.get('[data-eval-run="EVR-3"]').text()).toContain('compared with no baseline');
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows eval runs against the baseline and lets the user choose a new baseline', async () => {
    const base = globalThis.fetch;
    const fingerprint = { total: 'f', components: { skills: 'a', agents: 'b', hooks: 'c', rules: 'd' } };
    const summary = (id: number, isBaseline: boolean) => ({ runId: `EVR-${id}`, startedAt: NOW, finishedAt: NOW, jerryVersion: '0.0.1', fingerprint, label: id === 2 ? 'after rules change' : '', counts: { PASS: 1, FAIL: id === 2 ? 1 : 0, FLAKY: 0, ERROR: 0 }, isBaseline });
    const detail = {
      ...summary(2, false),
      results: [
        { caseId: 'git-blocked', suite: 'regression', kind: 'tool-safety', critical: true, outcome: 'FAIL', attempts: [{ attempt: 1, outcome: 'FAIL', harnessError: null, durationMs: 10, costUsd: 0, sessionId: 's', output: '', graders: [{ grader: 'Git unchanged', kind: 'deterministic', passed: false, detail: 'HEAD moved' }] }] },
        { caseId: 'plan-quality', suite: 'capability', kind: 'planning-quality', critical: false, outcome: 'PASS', attempts: [] },
      ],
      comparison: {
        baselineRunId: 'EVR-1',
        cases: [
          { caseId: 'git-blocked', critical: true, baseline: 'PASS', current: 'FAIL', comparison: 'REGRESSION' },
          { caseId: 'plan-quality', critical: false, baseline: null, current: 'PASS', comparison: 'NEW' },
        ],
        regressions: ['git-blocked'],
        releaseBlocked: true,
      },
    };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/evals/runs') return json([summary(2, false), summary(1, true)]);
      if (url === '/api/v1/evals/runs/EVR-2') return json(detail);
      if (url === '/api/v1/evals/status') return json({ baselineRunId: 'EVR-1', latestRunId: 'EVR-2', fingerprint, changedSinceBaseline: ['rules'], releaseBlocked: true });
      if (url === '/api/v1/evals/calibration') return json([{ rubricId: 'plan-quality', labels: 4, agreement: 0.75, calibrated: false }]);
      if (url === '/api/v1/evals/runner') return json(idleRunner);
      if (url === '/api/v1/evals/baseline') {
        calls.push({ url, init });
        return json(summary(2, true));
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await nav(wrapper, 'Evals').trigger('click');
    await flushPromises();
    const text = wrapper.get('.evals').text();
    expect(text).toContain('Baseline: EVR-1');
    expect(text).toContain('release blocked: critical regression');
    expect(text).toContain('Changed since the baseline: rules');
    expect(text).toContain('plan-quality 4 label(s), 75%');
    // The list is an overview: runs as full-width rows, no run's cases under it, no runner panel while idle.
    expect(wrapper.findAll('.eval-runs [data-run-id]').map((row) => row.attributes('data-run-id'))).toEqual(['EVR-2', 'EVR-1']);
    expect(wrapper.get('.eval-runs').classes()).toContain('grid-cols-1');
    expect(text).not.toContain('Git unchanged: HEAD moved');
    expect(wrapper.find('.eval-runner').exists()).toBe(false);
    expect(parseRoute('#/evals/EVR-12')).toEqual({ section: 'evals', runId: 'EVR-12' });
    expect(parseRoute('#/evals/..%2Fx')).toBeNull();
    expect(parseRoute('#/evals/abc')).toBeNull();

    // A click on the row opens the run's own page.
    await wrapper.get('.eval-runs [data-run-id="EVR-2"]').trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/evals/EVR-2');
    const page = wrapper.get('[data-eval-run="EVR-2"]');
    expect(page.text()).toContain('compared with EVR-1');
    expect(page.text()).toContain('REGRESSION');
    expect(page.text()).toContain('Git unchanged: HEAD moved');
    expect(page.text()).toContain('release blocked: critical regression');

    await page.get('[data-make-baseline]').trigger('click');
    await flushPromises();
    if (body().find('form.dialog #confirm-typed').exists()) await body().get('form.dialog #confirm-typed').setValue('EVR-2');
    await body().get('form.dialog textarea').setValue('the regression is intended');
    await body().get('form.dialog').trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(calls.find((call) => call.url === '/api/v1/evals/baseline')!.init?.body))).toEqual({ runId: 'EVR-2', note: 'the regression is intended', confirm: 'EVR-2' });
    // A run without metrics (older Core) shows no cost table.
    expect(page.find('.eval-metrics').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows what each variant of a case cost and did, against the baseline', async () => {
    const base = globalThis.fetch;
    const fingerprint = { total: 'f', components: { skills: 'a', agents: 'b', hooks: 'c', rules: 'd' } };
    const spread = (mean: number, min = mean, max = mean, n = 2) => ({ mean, min, max, n });
    const metrics = (variant: string, cost: number, tokens: number, search: number) => ({ variant, attempts: 2, passRate: 1, costUsd: spread(cost, cost * 0.8, cost * 1.2), tokens: spread(tokens), outputTokens: spread(100), turns: spread(4), toolCalls: spread(search + 1), searchCalls: spread(search), jerryCalls: spread(1), sessionMs: spread(9000) });
    const summary = { runId: 'EVR-4', startedAt: NOW, finishedAt: NOW, jerryVersion: '0.0.1', fingerprint, label: 'ab', counts: { PASS: 1, FAIL: 0, FLAKY: 0, ERROR: 0 }, isBaseline: false, costUsd: 1.234 };
    const detail = {
      ...summary,
      results: [{ caseId: 'history-reuse', suite: 'capability', kind: 'repo-discovery', critical: false, outcome: 'PASS', attempts: [] }],
      comparison: { baselineRunId: 'EVR-3', cases: [{ caseId: 'history-reuse', critical: false, baseline: 'PASS', current: 'PASS', comparison: 'UNCHANGED' }], regressions: [], releaseBlocked: false, deltas: [{ caseId: 'history-reuse', variant: 'jerry', costUsd: -0.1, tokens: -2000, costRatio: -0.25 }] },
      metrics: [{ caseId: 'history-reuse', variants: [metrics('jerry', 0.3, 20000, 3), metrics('no-plugin', 0.5, 40000, 12)] }],
    };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/evals/runs') return json([summary]);
      if (url === '/api/v1/evals/runs/EVR-4') return json(detail);
      if (url === '/api/v1/evals/status') return json({ baselineRunId: 'EVR-3', latestRunId: 'EVR-4', fingerprint, changedSinceBaseline: [], releaseBlocked: false });
      if (url === '/api/v1/evals/calibration') return json([]);
      if (url === '/api/v1/evals/runner') return json(idleRunner);
      if (url === '/api/v1/evals/runner/start') {
        calls.push({ url, init });
        return json({ ...idleRunner, state: 'running', startedAt: NOW });
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await nav(wrapper, 'Evals').trigger('click');
    await flushPromises();
    expect(wrapper.get('.eval-runs [data-run-id="EVR-4"] [data-run-cost]').text()).toBe('$1.23');

    await wrapper.get('.eval-runs [data-run-id="EVR-4"]').trigger('click');
    await flushPromises();
    const table = wrapper.get('[data-eval-run="EVR-4"] .eval-metrics');
    const jerry = table.get('[data-eval-metrics="history-reuse:jerry"]').text();
    expect(jerry).toContain('100%');
    expect(jerry).toContain('$0.300 ($0.240–$0.360)');
    expect(jerry).toContain('20,000');
    expect(jerry).toContain('-25% cost, -2,000 tokens');
    expect(table.get('[data-eval-metrics="history-reuse:no-plugin"]').text()).toContain('12');
    wrapper.unmount();
  });

  it('shows plan drift and the implementers on demand', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/tasks/JRY-0001/drift') {
        const drift = {
          taskId: 'JRY-0001',
          unplannedFiles: ['src/extra.ts'],
          untouchedSteps: [{ number: 2, step: 'Add unit tests' }],
          layers: [[1], [2]],
          blockedSteps: [],
          assignments: [{ taskId: 'JRY-0001', label: 'code', steps: [1], files: ['src/greeting/greet.ts'], agentId: 'impl-a', createdAt: NOW }],
        };
        return new Response(JSON.stringify(drift), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    expect(buttonIn(await openTask(wrapper, 'JRY-0002', 'plan'), 'Plan drift')).toBeUndefined();
    const page = await openTask(wrapper, 'JRY-0001', 'plan');
    await buttonIn(page, 'Plan drift')!.trigger('click');
    await flushPromises();
    const drift = wrapper.get('.plan-drift');
    expect(drift.text()).toContain('Changed but not named by any plan step: src/extra.ts');
    expect(drift.text()).toContain('2. Add unit tests');
    expect(drift.text()).toContain('Step order: 1 → 2');
    expect(drift.text()).toContain('implementer impl-a');
    wrapper.unmount();
  });

  it('still renders tasks from an older Core that does not send the newer fields', async () => {
    const base = globalThis.fetch;
    const { planGrade: _grade, analyses: _analyses, agentRuns: _runs, reviewRequested: _requested, effectiveReviewMode: _mode, ...older } = waitingTask;
    const { reviewRequested: _r, effectiveReviewMode: _m, ...olderReported } = reportedTask;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([older, olderReported]);
      if (url === '/api/v1/settings') return json({ error: 'Not Found' }, 404);
      if (url === '/api/v1/projects' && init?.method === 'GET') {
        const { reviewMode: _own, effectiveReviewMode: _effective, ...olderProject } = shopProject;
        return json([olderProject]);
      }
      return base(url, init);
    });
    const errors: unknown[] = [];
    const wrapper = mount(App, { attachTo: document.body, global: { config: { errorHandler: (error) => errors.push(error) } } });
    await startDashboard();
    await flushPromises();
    expect(state.settings).toBeNull();
    expect(state.notice).toBeNull();
    await openTasks(wrapper);
    expect(buttonIn(await expand(wrapper, 'JRY-0002'), 'Approve plan v1')).toBeDefined();
    // An older Core always reviews: the switch is on and locked, and nothing extra is sent.
    await buttonIn(await expand(wrapper, 'JRY-0004'), 'Accept implementation')!.trigger('click');
    await flushPromises();
    const choice = body().get('form.dialog .review-choice');
    expect(choice.attributes('data-review-mode')).toBe('unknown');
    expect(choice.get('[role="switch"]').attributes('disabled')).toBeDefined();
    // No decision setting from this Core: one click, still sending the task ID an older Core requires.
    await decideWith();
    expect(posted('/api/v1/tasks/JRY-0004/approvals')).toEqual([{ stage: 'IMPLEMENTATION', version: 2, decision: 'APPROVED', comment: '', confirmTaskId: 'JRY-0004' }]);
    await openTask(wrapper, 'JRY-0002', 'plan');
    expect(wrapper.find('.plan-grade').exists()).toBe(false);
    await settingsLink(wrapper).trigger('click');
    await flushPromises();
    expect(wrapper.get('.settings-unavailable').text()).toContain('This JERRY Core does not offer workflow settings yet');
    expect(errors).toEqual([]);
    wrapper.unmount();
  });

  it('compares the current plan version with the one before, section by section', async () => {
    const base = globalThis.fetch;
    const v1 = { ...waitingTask.plan, version: 1, scope: ['src/auth/**'] };
    const v2 = {
      ...waitingTask.plan,
      version: 2,
      scope: ['src/auth/**', 'tests/auth/**'],
      document: { ...waitingTask.plan.document!, goal: 'Add a login form with rate limiting.', openQuestions: [] },
    };
    const revised: TaskSummary = { ...approvedTask, plan: v2 };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([revised, waitingTask]);
      if (url === '/api/v1/tasks/JRY-0001/plans') {
        calls.push({ url, init });
        return json([v1, v2]);
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    expect(buttonIn(await openTask(wrapper, 'JRY-0002', 'plan'), 'Changes since v1')).toBeUndefined();
    const page = await openTask(wrapper, 'JRY-0001', 'plan');
    await buttonIn(page, 'Changes since v1')!.trigger('click');
    await flushPromises();
    const diff = wrapper.get('.plan-diff');
    expect(diff.text()).toContain('Plan v1 → v2');
    expect(diff.text()).toContain('Scope (what JERRY checks edits against)');
    expect(diff.find('[data-change="added"]').text()).toContain('tests/auth/**');
    expect(diff.text()).toContain('Add a login form with rate limiting.');
    expect(diff.text()).toContain('Should greetings be localised?');
    expect(diff.findAll('[data-change="removed"]').map((item) => item.text()).join(' ')).toContain('Should greetings be localised?');
    expect(calls.some((call) => call.url === '/api/v1/tasks/JRY-0001/plans')).toBe(true);
    await buttonIn(wrapper.get('.task-page'), 'Hide changes')!.trigger('click');
    expect(wrapper.find('.plan-diff').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the transition history in its tab', async () => {
    const wrapper = await mountApp();
    await openTask(wrapper, 'JRY-0001', 'history');
    await flushPromises();
    const text = wrapper.get('ol.history').text();
    expect(text).toContain('Waiting for plan approval → In implementation');
    expect(text).toContain('plan.approved by user · looks good');
    wrapper.unmount();
  });

  it('approves a plan only after the task ID is typed, sending the CSRF token and the confirmation', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await buttonIn(await expand(wrapper, 'JRY-0002'), 'Approve plan v1')!.trigger('click');

    const submit = body().get('form.dialog button[type="submit"]');
    expect(submit.attributes('disabled')).toBeDefined();
    await confirmWith('JRY-0002');

    const approval = calls.find((call) => call.url === '/api/v1/tasks/JRY-0002/approvals')!;
    expect(approval.init?.method).toBe('POST');
    expect((approval.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    expect(JSON.parse(String(approval.init?.body))).toEqual({ stage: 'PLAN', version: 1, decision: 'APPROVED', confirmTaskId: 'JRY-0002' });
    expect(state.notice).toBe('Approved JRY-0002 plan v1.');
    wrapper.unmount();
  });

  it('approves a plan with the Artifact switch on and the chosen kind', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await buttonIn(await expand(wrapper, 'JRY-0002'), 'Approve plan v1')!.trigger('click');
    await flushPromises();
    const choice = body().get('form.dialog [data-artifact-choice]');
    expect(choice.attributes('data-artifact-choice')).toBe('off');
    expect(choice.text()).toContain('You can switch it on later on the task page');
    await body().get('#approve-artifact-switch').trigger('click');
    await flushPromises();
    await pickOption(body().get('form.dialog [data-artifact-kind]'), 'UI flows and screens');
    expect(body().get('form.dialog [data-artifact-choice]').text()).toContain('without asking again');
    await confirmWith('JRY-0002');
    expect(posted('/api/v1/tasks/JRY-0002/approvals')).toEqual([{ stage: 'PLAN', version: 1, decision: 'APPROVED', confirmTaskId: 'JRY-0002', artifact: { wanted: true, kind: 'ui-flows' } }]);
    wrapper.unmount();
  });

  it('changes the Artifact choice on the task page until a decision is recorded, then shows the decision', async () => {
    const base = globalThis.fetch;
    let task: TaskSummary = { ...waitingTask, artifact: { request: { wanted: true, kind: 'endpoint-contract-map', by: 'plan', at: null }, decision: null } };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([task]);
      if (url === '/api/v1/tasks/JRY-0002/artifact-request') {
        calls.push({ url, init });
        const next = JSON.parse(String(init?.body)) as { wanted: boolean; kind: 'endpoint-contract-map' };
        task = { ...task, artifact: { request: { ...next, by: 'user', at: NOW }, decision: null } };
        return json({ taskId: 'JRY-0002', request: task.artifact!.request });
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0002', 'overview');
    const fact = page.get('[data-artifact-choice]');
    expect(fact.attributes('data-artifact-choice')).toBe('endpoint-contract-map');
    expect(page.text()).toContain('From your answer in the plan; the switch overrides it.');
    await page.get('#task-artifact-JRY-0002-switch').trigger('click');
    await flushPromises();
    expect(posted('/api/v1/tasks/JRY-0002/artifact-request')).toEqual([{ wanted: false, kind: 'endpoint-contract-map' }]);
    expect(state.notice).toBe('JRY-0002: no Artifact.');
    wrapper.unmount();

    // Once Claude recorded the Artifact, the page shows it and no switch.
    task = { ...task, state: 'DONE', artifact: { request: { wanted: true, kind: 'ui-flows', by: 'user', at: NOW }, decision: { taskId: 'JRY-0002', decision: 'created', kind: 'ui-flows', title: 'Login flows', url: 'https://claude.ai/code/artifact/0f6c1a2b-aaaa-bbbb-cccc-000000000002', reason: '', at: NOW } } };
    const again = await mountApp();
    const done = await openTask(again, 'JRY-0002', 'overview');
    expect(done.find('[data-artifact-choice]').exists()).toBe(false);
    expect(done.get('[data-artifact-decision="created"] a').attributes('href')).toBe('https://claude.ai/code/artifact/0f6c1a2b-aaaa-bbbb-cccc-000000000002');
    again.unmount();
  });

  it('asks in an alert dialog and decides nothing without the exact task ID', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await buttonIn(await expand(wrapper, 'JRY-0002'), 'Reject')!.trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.get('h2').text()).toBe('Reject JRY-0002 plan v1');
    // The field to type into has the focus, not a button.
    expect(document.activeElement).toBe(dialog.get('#confirm-typed').element);
    const submit = dialog.get('button[type="submit"]');
    for (const typed of ['', 'JRY-0001', 'jry-0002', 'JRY-0002x']) {
      await dialog.get('#confirm-typed').setValue(typed);
      expect(submit.attributes('disabled'), typed).toBeDefined();
      await dialog.get('form').trigger('submit');
    }
    await flushPromises();
    expect(calls.some((call) => call.url.endsWith('/approvals'))).toBe(false);

    // Escape closes the dialog without a decision.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(body().find('[role="alertdialog"]').exists()).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/approvals'))).toBe(false);
    wrapper.unmount();
  });

  it('withdraws an approval from the menu only after the task ID is typed', async () => {
    const wrapper = await mountApp();
    const page = await openTask(wrapper, 'JRY-0001');
    await menuItem(page.get('.task-page__header'), 'Withdraw approval');
    expect(body().get('form.dialog h2').text()).toBe('Reject JRY-0001 plan v1');
    await confirmWith('JRY-0001');
    expect(posted('/api/v1/tasks/JRY-0001/approvals')).toEqual([{ stage: 'PLAN', version: 1, decision: 'REJECTED', confirmTaskId: 'JRY-0001' }]);
    wrapper.unmount();
  });

  it('decides with one click by default: the decision button has the focus, Escape cancels, nothing is typed', async () => {
    // Core sends no decision setting: one click.
    decisionMode = undefined;
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await buttonIn(await expand(wrapper, 'JRY-0002'), 'Approve plan v1')!.trigger('click');
    await flushPromises();
    let dialog = body().get('[role="alertdialog"]');
    expect(dialog.attributes('data-confirm-mode')).toBe('click');
    expect(dialog.get('h2').text()).toBe('Approve JRY-0002 plan v1');
    // What is decided is shown: the task, its plan version and scope.
    expect(dialog.get('[data-details="scope"] button').text()).toBe('Scope (1)');
    // Only accepting an implementation confirms the Definition of Done.
    expect(dialog.find('[data-details="definition-of-done"]').exists()).toBe(false);
    expect(dialog.find('#confirm-typed').exists()).toBe(false);
    const submit = dialog.get('button[type="submit"]');
    expect(submit.text()).toBe('Approve plan');
    expect(submit.attributes('disabled')).toBeUndefined();
    expect(document.activeElement).toBe(submit.element);

    // Escape cancels without a decision.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(body().find('[role="alertdialog"]').exists()).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/approvals'))).toBe(false);

    // Enter on the focused button submits its form: one gesture decides.
    await buttonIn(tile(wrapper, 'JRY-0002'), 'Approve plan v1')!.trigger('click');
    await flushPromises();
    dialog = body().get('[role="alertdialog"]');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    const approval = calls.find((call) => call.url === '/api/v1/tasks/JRY-0002/approvals')!;
    expect((approval.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    expect(JSON.parse(String(approval.init?.body))).toEqual({ stage: 'PLAN', version: 1, decision: 'APPROVED', confirmTaskId: 'JRY-0002' });
    expect(state.notice).toBe('Approved JRY-0002 plan v1.');
    wrapper.unmount();
  });

  it('cancels in one click in one-click mode, without typing the task ID, and still sends it to Core', async () => {
    decisionMode = 'click';
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await menuItem(tile(wrapper, 'JRY-0002'), 'Cancel task');
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.attributes('data-confirm-mode')).toBe('click');
    expect(dialog.find('#confirm-typed').exists()).toBe(false);
    expect(dialog.text()).toContain('Cancelling cannot be undone');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posted('/api/v1/tasks/JRY-0002/transitions')).toEqual([{ event: 'task.cancelled', confirmTaskId: 'JRY-0002' }]);
    wrapper.unmount();
  });

  it('asks for the typed task ID to cancel when the user chose typed confirmations', async () => {
    decisionMode = 'typed';
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await menuItem(tile(wrapper, 'JRY-0002'), 'Cancel task');
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.attributes('data-confirm-mode')).toBe('typed');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(calls.some((call) => call.url === '/api/v1/tasks/JRY-0002/transitions')).toBe(false);
    await confirmWith('JRY-0002');
    expect(posted('/api/v1/tasks/JRY-0002/transitions')).toEqual([{ event: 'task.cancelled', confirmTaskId: 'JRY-0002' }]);
    wrapper.unmount();
  });

  it('lists tasks as full-width bars, one per row', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    const grid = wrapper.get('.task-grid');
    expect(grid.classes()).toContain('grid-cols-1');
    expect(grid.classes().some((name) => /^(md|lg|xl|2xl):grid-cols-/.test(name))).toBe(false);
    const bar = tile(wrapper, 'JRY-0002');
    const header = bar.get('.task-tile__header');
    // One row from md up: state, title, where and when, actions.
    expect(header.classes()).toContain('md:grid-cols-[auto_minmax(0,1fr)_auto_auto]');
    expect(header.get('.task-tile__state').text()).toContain('JRY-0002');
    expect(header.get('.task-tile__title').attributes('title')).toBe(header.get('.task-tile__title').text());
    expect(header.find('.task-tile__meta').exists()).toBe(true);
    expect(header.find('.task-tile__actions [data-expand]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('decides the fix plan and waives the review in one click; the reason stays required', async () => {
    decisionMode = 'click';
    const base = globalThis.fetch;
    const reviewTask: TaskSummary = { ...approvedTask, taskId: 'JRY-0007', title: 'Reviewed change', state: 'WAIT_REVIEW_FIX_APPROVAL', reviewRequested: true };
    const review = reviewWithFixPlan('JRY-0007', 'WAIT_REVIEW_FIX_APPROVAL');
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([reviewTask]);
      if (url === '/api/v1/tasks/JRY-0007/review') return json(review);
      if (url === '/api/v1/tasks/JRY-0007/approvals' || url === '/api/v1/tasks/JRY-0007/review/skip') {
        calls.push({ url, init });
        return json(url.endsWith('skip') ? review : { ...approvedTask.planDecision, taskId: 'JRY-0007', stage: 'REVIEW_FIX' }, url.endsWith('skip') ? 200 : 201);
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await openTask(wrapper, 'JRY-0007');
    await flushPromises();
    await wrapper.get('.review').findAll('button').find((candidate) => candidate.text() === 'Reject fix plan')!.trigger('click');
    await flushPromises();
    await decideWith('Keep the old token format.');
    expect(posted('/api/v1/tasks/JRY-0007/approvals')).toEqual([{ stage: 'REVIEW_FIX', version: 1, decision: 'REJECTED', comment: 'Keep the old token format.', confirmTaskId: 'JRY-0007' }]);

    await wrapper.get('.review').findAll('button').find((candidate) => candidate.text() === 'Waive review')!.trigger('click');
    await flushPromises();
    // Nothing to type, but the reason is required: the button waits for it, and the field has the focus.
    const submit = body().get('form.dialog button[type="submit"]');
    expect(submit.attributes('disabled')).toBeDefined();
    expect(document.activeElement).toBe(body().get('form.dialog textarea').element);
    await decideWith('prototype only');
    expect(posted('/api/v1/tasks/JRY-0007/review/skip')).toEqual([{ reason: 'prototype only', confirmTaskId: 'JRY-0007' }]);
    wrapper.unmount();
  });

  it('shows the plan Claude submitted, section by section, before the decision', async () => {
    const wrapper = await mountApp();
    const text = (await openTask(wrapper, 'JRY-0002', 'plan')).text();
    expect(text).toContain('Add a greeting helper that formats a personalised welcome message.');
    for (const heading of ['Changes (2)', 'Risks (1)', 'Steps (2)', 'Tests (1)', 'Manual QA (1)', 'Proposed commits', 'Definition of Done', 'Open questions (1)']) {
      expect(text, heading).toContain(heading);
    }
    expect(text).toContain('feat(greeting): add greet helper');
    expect(text).toContain('Should greetings be localised?');
    wrapper.unmount();
  });

  it('shows a project’s profile on its page: commands as they run here, instructions, suspicious text and links', async () => {
    const wrapper = await mountApp();
    await nav(wrapper, 'Projects').trigger('click');
    await flushPromises();
    await wrapper.get('.projects .project a').trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/projects/D%3A%5CWork%5Cshop');
    expect(wrapper.get('header nav[aria-label="Breadcrumb"]').text()).toBe('Projectsshop');
    const card = wrapper.get('.repository-profile');
    expect(card.text()).toContain('out of date: stack');
    expect(card.text()).toContain('corepack pnpm run test');
    expect(card.text()).toContain('defines 1 hook group(s)');
    expect(card.text()).toContain('README.md:3');
    expect(wrapper.get('.project-links').text()).toContain('Links between repositories');
    expect(wrapper.get('.project-links').text()).toContain('package.json uses API schema docs/openapi.yaml');
    // The project's tasks as the same tiles, without the project name.
    expect(wrapper.findAll('.project-tasks .task').map((task) => task.attributes('data-task-id'))).toEqual(['JRY-0005', 'JRY-0004', 'JRY-0003', 'JRY-0002', 'JRY-0001']);
    await buttonIn(card, 'Rescan')!.trigger('click');
    await flushPromises();
    const scan = calls.find((call) => call.url === '/api/v1/repositories/scan')!;
    expect(JSON.parse(String(scan.init?.body))).toEqual({ repoPath: 'D:\\Work\\shop' });
    expect((scan.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    wrapper.unmount();
  });

  it('filters the timeline and renders every section without errors', async () => {
    const wrapper = await mountApp();
    const tab = (label: string) => nav(wrapper, label);
    await tab('Timeline').trigger('click');
    expect(wrapper.get('table').text()).toContain('WARN');
    expect(wrapper.get('table').text()).toContain('README.md');
    // reka-ui's tabs switch on mousedown (and on focus or Enter from the keyboard).
    await wrapper.findAll('[role="tab"]').find((button) => button.text() === 'Blocked')!.trigger('mousedown');
    expect(wrapper.text()).toContain('No events for this filter.');
    await tab('Projects').trigger('click');
    expect(wrapper.get('.projects').text()).toContain('D:\\Work\\shop');
    wrapper.unmount();
  });

  it('shows how to sign in again when the session has ended', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    const wrapper = await mountApp();
    expect(wrapper.text()).toContain('Run jerry ui');
    wrapper.unmount();
  });
});
