// @vitest-environment happy-dom
import type { StoredEvent, TaskWithDecision } from '@jerry/contracts';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { samplePlan } from '../../../tests/helpers/plan-fixture';
import { App } from '../src/App';
import { startDashboard, state } from '../src/state';

const CSRF = 'c'.repeat(64);
const NOW = new Date().toISOString();

const waitingTask: TaskWithDecision = {
  taskId: 'JRY-0002',
  title: 'Add login form',
  repoRoot: 'D:\\Work\\shop',
  createdAt: NOW,
  plan: { version: 1, contentHash: `sha256:${'a'.repeat(64)}`, scope: ['src/auth/**'], createdAt: NOW, document: samplePlan('D:\\Work\\shop', ['src/auth/**']) },
  planDecision: null,
};

const approvedTask: TaskWithDecision = {
  ...waitingTask,
  taskId: 'JRY-0001',
  title: 'M1 Core Foundation',
  planDecision: { approvalId: 'apr_1', taskId: 'JRY-0001', stage: 'PLAN', version: 1, contentHash: waitingTask.plan.contentHash, decision: 'APPROVED', approvedBy: 'local-user', approvedAt: NOW, comment: '' },
};

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
      if (url === '/api/v1/tasks') return json([approvedTask, waitingTask]);
      if (url.startsWith('/api/v1/events')) return json([deviation]);
      if (url === '/api/v1/repositories/exclusions') return json([]);
      if (url === '/api/v1/tasks/JRY-0002/approvals') return json({ ...approvedTask.planDecision, taskId: 'JRY-0002' }, 201);
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
    expect(text).toContain('1 approved');
    expect(text).toContain('1 waiting for your decision');
    expect(text).toContain('JRY-0002');
    expect(text).toContain('README.md');
    wrapper.unmount();
  });

  it('approves a plan only after the task ID is typed, sending the CSRF token and the confirmation', async () => {
    const wrapper = await mountApp();
    await wrapper.findAll('nav button').find((button) => button.text().startsWith('Plans'))!.trigger('click');
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
    await wrapper.findAll('nav button').find((button) => button.text().startsWith('Plans'))!.trigger('click');
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
