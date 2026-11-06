// @vitest-environment happy-dom
import type { StoredEvent, TaskSummary, WorkflowTransition } from '@jerry/contracts';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { samplePlan } from '../../../tests/helpers/plan-fixture';
import { App } from '../src/App';
import { startDashboard, state } from '../src/state';

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
};

const approvedTask: TaskSummary = {
  ...waitingTask,
  taskId: 'JRY-0001',
  title: 'M1 Core Foundation',
  state: 'IMPLEMENTATION',
  planDecision: { approvalId: 'apr_1', taskId: 'JRY-0001', stage: 'PLAN', version: 1, contentHash: waitingTask.plan.contentHash, decision: 'APPROVED', approvedBy: 'local-user', approvedAt: NOW, comment: '' },
  activity: { sessionCount: 2, lastSessionId: 's2', lastActivityAt: NOW, lastSessionEndedAt: NOW },
  lastCheckpoint: { taskId: 'JRY-0001', sessionId: 's2', summary: 'Store and API for sessions are done.', nextSteps: ['Dashboard card', 'Live check'], at: NOW },
};

const cancelledTask: TaskSummary = { ...waitingTask, taskId: 'JRY-0003', title: 'Dropped idea', state: 'CANCELLED' };

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

describe('Dashboard app', () => {
  let calls: Call[];

  beforeEach(() => {
    calls = [];
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], exclusions: [], refreshedAt: null });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.0.1', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 2, sessionCount: 3, database: { file: 'db', migration: '0002_hook_events' } });
      if (url === '/api/v1/tasks') return json([approvedTask, waitingTask, cancelledTask]);
      if (url.startsWith('/api/v1/events')) return json([deviation]);
      if (url === '/api/v1/repositories/exclusions') return json([]);
      if (url === '/api/v1/tasks/JRY-0002/approvals') return json({ ...approvedTask.planDecision, taskId: 'JRY-0002' }, 201);
      if (url === '/api/v1/tasks/JRY-0001/transitions' && init?.method === 'GET') return json(history);
      if (url.endsWith('/transitions')) return json({ ...approvedTask, state: 'PAUSED' }, 201);
      return json({ error: `unexpected ${url}` }, 404);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function mountApp() {
    const wrapper = mount(App, { attachTo: document.body });
    await startDashboard();
    await flushPromises();
    return wrapper;
  }

  it('shows the overview: guard, plans waiting for a decision and the latest deviation', async () => {
    const wrapper = await mountApp();
    const text = wrapper.text();
    expect(text).toContain('GUARDED');
    expect(text).toContain('1 in implementation');
    expect(text).toContain('1 waiting for your decision');
    expect(text).toContain('JRY-0002');
    expect(text).toContain('README.md');
    wrapper.unmount();
  });

  const openTasks = async (wrapper: Awaited<ReturnType<typeof mountApp>>) => {
    await wrapper.findAll('nav button').find((button) => button.text().startsWith('Tasks'))!.trigger('click');
  };
  const button = (wrapper: Awaited<ReturnType<typeof mountApp>>, label: string, taskId?: string) => {
    const scope = taskId === undefined ? wrapper : wrapper.findAll('article.task').find((card) => card.text().includes(taskId))!;
    return scope.findAll('button').find((candidate) => candidate.text() === label);
  };

  it('offers only the steps the workflow allows in each state, and folds away finished tasks', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    expect(wrapper.findAll('article.task').find((card) => card.text().includes('JRY-0001'))!.text()).toContain('In implementation');
    expect(button(wrapper, 'Approve plan v1', 'JRY-0002')).toBeDefined();
    expect(button(wrapper, 'Approve plan v1', 'JRY-0001')).toBeUndefined();
    expect(button(wrapper, 'Withdraw approval', 'JRY-0001')).toBeDefined();
    expect(button(wrapper, 'Pause', 'JRY-0001')).toBeDefined();
    expect(button(wrapper, 'Resume', 'JRY-0001')).toBeUndefined();
    expect(wrapper.get('details.panel summary').text()).toBe('Finished and cancelled (1)');
    expect(button(wrapper, 'Cancel task', 'JRY-0003')).toBeUndefined();
    wrapper.unmount();
  });

  it('pauses with one click and cancels only after the task ID is typed', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await button(wrapper, 'Pause', 'JRY-0001')!.trigger('click');
    await flushPromises();
    const pause = calls.find((call) => call.url === '/api/v1/tasks/JRY-0001/transitions' && call.init?.method === 'POST')!;
    expect(JSON.parse(String(pause.init?.body))).toEqual({ event: 'task.paused' });
    expect(state.notice).toBe('Paused JRY-0001.');

    await button(wrapper, 'Cancel task', 'JRY-0002')!.trigger('click');
    expect(wrapper.get('form.dialog button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('form.dialog input').setValue('JRY-0002');
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();
    const cancel = calls.find((call) => call.url === '/api/v1/tasks/JRY-0002/transitions')!;
    expect(JSON.parse(String(cancel.init?.body))).toEqual({ event: 'task.cancelled', confirmTaskId: 'JRY-0002' });
    expect((cancel.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    wrapper.unmount();
  });

  it('shows which sessions worked on a task and Claude’s last checkpoint', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    const card = wrapper.findAll('article.task').find((candidate) => candidate.text().includes('JRY-0001'))!;
    expect(card.text()).toContain('2 sessions · last activity');
    expect(card.text()).toContain('last session ended');
    expect(card.get('.checkpoint').text()).toContain('Store and API for sessions are done.');
    expect(card.findAll('.checkpoint li').map((item) => item.text())).toEqual(['Dashboard card', 'Live check']);
    const waiting = wrapper.findAll('article.task').find((candidate) => candidate.text().includes('JRY-0002'))!;
    expect(waiting.text()).toContain('No session has worked on it yet');
    expect(waiting.find('.checkpoint').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the transition history on demand', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await button(wrapper, 'History', 'JRY-0001')!.trigger('click');
    await flushPromises();
    const text = wrapper.get('ol.history').text();
    expect(text).toContain('Waiting for plan approval → In implementation');
    expect(text).toContain('plan.approved by user · looks good');
    wrapper.unmount();
  });

  it('approves a plan only after the task ID is typed, sending the CSRF token and the confirmation', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await wrapper.findAll('button').find((button) => button.text() === 'Approve plan v1')!.trigger('click');

    const submit = wrapper.get('form.dialog button[type="submit"]');
    expect(submit.attributes('disabled')).toBeDefined();
    await wrapper.get('form.dialog input').setValue('JRY-0002');
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();

    const approval = calls.find((call) => call.url === '/api/v1/tasks/JRY-0002/approvals')!;
    expect(approval.init?.method).toBe('POST');
    expect((approval.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    expect(JSON.parse(String(approval.init?.body))).toEqual({ stage: 'PLAN', version: 1, decision: 'APPROVED', confirmTaskId: 'JRY-0002' });
    expect(state.notice).toBe('Approved JRY-0002 plan v1.');
    wrapper.unmount();
  });

  it('shows the plan Claude submitted, section by section, before the decision', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    const text = wrapper.text();
    expect(text).toContain('Add a greeting helper that formats a personalised welcome message.');
    for (const heading of ['Changes (2)', 'Risks (1)', 'Steps (2)', 'Tests (1)', 'Manual QA (1)', 'Proposed commits', 'Definition of Done', 'Open questions (1)']) {
      expect(text, heading).toContain(heading);
    }
    expect(text).toContain('feat(greeting): add greet helper');
    expect(wrapper.text()).toContain('Should greetings be localised?');
    wrapper.unmount();
  });

  it('filters the timeline and renders every section without errors', async () => {
    const wrapper = await mountApp();
    const tab = (label: string) => wrapper.findAll('nav button').find((button) => button.text().startsWith(label))!;
    await tab('Timeline').trigger('click');
    expect(wrapper.get('table').text()).toContain('WARN');
    expect(wrapper.get('table').text()).toContain('README.md');
    await wrapper.findAll('.chip-button').find((button) => button.text() === 'Blocked')!.trigger('click');
    expect(wrapper.text()).toContain('No events for this filter.');
    await tab('Repositories').trigger('click');
    expect(wrapper.text()).toContain('No repository is excluded.');
    wrapper.unmount();
  });

  it('shows how to sign in again when the session has ended', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    const wrapper = await mountApp();
    expect(wrapper.text()).toContain('Run jerry ui');
    wrapper.unmount();
  });
});
