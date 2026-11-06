// @vitest-environment happy-dom
import type { RepositorySummary, StoredEvent, TaskSummary, WorkflowTransition } from '@jerry/contracts';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { samplePlan } from '../../../tests/helpers/plan-fixture';
import { sampleReport } from '../../../tests/helpers/report-fixture';
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
  lastReport: null,
  reportDecision: null,
  finalCheck: null,
  analyses: [],
  agentRuns: [],
  findings: null,
  lastTestRun: null,
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
  title: 'M1 Core Foundation',
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
    ],
    definitionOfDone: ['tests pass'],
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
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], exclusions: [], repositories: [], graph: { nodes: [], edges: [] }, refreshedAt: null });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.0.1', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 2, sessionCount: 3, database: { file: 'db', migration: '0002_hook_events' } });
      if (url === '/api/v1/tasks') return json([approvedTask, waitingTask, cancelledTask, reportedTask, refusedTask]);
      if (url === '/api/v1/tasks/JRY-0004/approvals') return json({ ...reportedTask.planDecision, stage: 'IMPLEMENTATION', version: 2 }, 201);
      if (url.startsWith('/api/v1/events')) return json([deviation]);
      if (url === '/api/v1/repositories/exclusions') return json([]);
      if (url === '/api/v1/artifacts') return json([]);
      if (url === '/api/v1/repositories') return json([shopRepository]);
      if (url === '/api/v1/workspace/graph') {
        return json({ nodes: [], edges: [{ from: 'D:\\Work\\shop', to: 'D:\\Work\\api', kind: 'api-contract', evidence: 'package.json uses API schema docs/openapi.yaml' }] });
      }
      if (url === '/api/v1/repositories/scan') return json(shopRepository.profile);
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
    expect(text).toContain('3 waiting for your decision');
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

  it('shows the implementation report next to what JERRY recorded, with accept and request-changes', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    const card = wrapper.findAll('article.task').find((candidate) => candidate.text().includes('JRY-0004'))!;
    const report = card.get('.report');
    expect(report.text()).toContain('Implementation report v2');
    expect(report.text()).toContain('Added greet(name) and its unit test.');
    expect(report.get('.evidence').classes()).toContain('evidence--attention');
    expect(report.get('.evidence').text()).toContain('Edited but not in the report: README.md');
    expect(report.text()).toContain('1 check(s) failed or did not run.');
    expect(report.text()).toContain('NOT_RUN');
    expect(report.text()).toContain('QA-1 Greeting for a named user');
    expect(button(wrapper, 'Approve plan v1', 'JRY-0004')).toBeUndefined();

    await button(wrapper, 'Request changes', 'JRY-0004')!.trigger('click');
    expect(wrapper.get('form.dialog h2').text()).toBe('Request changes to JRY-0004 report v2');
    await wrapper.get('form.dialog textarea').setValue('Also handle empty names.');
    await wrapper.get('form.dialog input').setValue('JRY-0004');
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();
    const decision = calls.find((call) => call.url === '/api/v1/tasks/JRY-0004/approvals')!;
    expect(JSON.parse(String(decision.init?.body))).toEqual({ stage: 'IMPLEMENTATION', version: 2, decision: 'REJECTED', comment: 'Also handle empty names.', confirmTaskId: 'JRY-0004' });
    expect(state.notice).toBe('Requested changes to JRY-0004 report v2.');

    await button(wrapper, 'Accept implementation', 'JRY-0004')!.trigger('click');
    expect(wrapper.find('form.dialog textarea').exists()).toBe(false);
    await wrapper.get('form.dialog input').setValue('JRY-0004');
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();
    const accepted = calls.filter((call) => call.url === '/api/v1/tasks/JRY-0004/approvals').at(-1)!;
    expect(JSON.parse(String(accepted.init?.body))).toMatchObject({ stage: 'IMPLEMENTATION', version: 2, decision: 'APPROVED' });
    wrapper.unmount();
  });

  it('shows why JERRY refused DONE and lets the user send the work back', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    const card = wrapper.findAll('article.task').find((candidate) => candidate.text().includes('JRY-0005'))!;
    const check = card.get('.final-check');
    expect(check.classes()).toContain('final-check--failed');
    expect(check.text()).toContain('JERRY did not complete the task');
    expect(check.text()).toContain('blocks failed: npm test');
    expect(check.text()).toContain('note no check ran');
    expect(button(wrapper, 'Request changes', 'JRY-0005')).toBeDefined();
    expect(button(wrapper, 'Accept implementation', 'JRY-0005')).toBeUndefined();
    wrapper.unmount();
  });

  it('shows the Definition of Done the user confirms when accepting', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await button(wrapper, 'Accept implementation', 'JRY-0004')!.trigger('click');
    const dialog = wrapper.get('form.dialog');
    expect(dialog.text()).toContain("You confirm the plan's Definition of Done:");
    for (const item of samplePlan('D:\\Work\\shop', ['src/auth/**']).definitionOfDone) expect(dialog.text()).toContain(item);
    wrapper.unmount();
  });

  it('shows the analysts’ reports with unverified citations, and a run without a report as a gap', async () => {
    const wrapper = await mountApp();
    await openTasks(wrapper);
    const analysis = wrapper.findAll('article.task').find((candidate) => candidate.text().includes('JRY-0001'))!.get('.analysis');
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
    await openTasks(wrapper);
    const grade = wrapper.findAll('article.task').find((candidate) => candidate.text().includes('JRY-0002'))!.get('.plan-grade');
    expect(grade.text()).toContain('incomplete');
    expect(grade.text()).toContain('71/100');
    expect(grade.text()).toContain('informational, you decide');
    expect(grade.text()).toContain('changes outside the scope (edits there will be deviations): src/app.ts');
    expect(grade.text()).not.toContain('1 risk(s) with mitigations');
    // The approval stays available: the check never blocks.
    expect(wrapper.findAll('button').some((button) => button.text() === 'Approve plan v1')).toBe(true);
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
      evidence: 'try { run(); } catch {}',
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
    await flushPromises();
    const panel = wrapper.get('.findings');
    expect(panel.get('summary').text()).toContain('1 open');
    expect(panel.get('summary').text()).toContain('1 P2 · 1 fixed');
    expect(panel.text()).toContain('Exception swallowed silently');
    expect(panel.text()).not.toContain('Vague name');
    await panel.get('.findings__filters input[type="checkbox"]').setValue(true);
    expect(panel.text()).toContain('Vague name');

    await panel.findAll('button').find((candidate) => candidate.text() === 'False positive')!.trigger('click');
    const submit = wrapper.get('form.dialog button[type="submit"]');
    await wrapper.get('form.dialog input').setValue('FND-1');
    expect(submit.attributes('disabled')).toBeDefined();
    await wrapper.get('form.dialog textarea').setValue('the catch is in generated code');
    expect(submit.attributes('disabled')).toBeUndefined();
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();
    const decision = calls.find((call) => call.url === '/api/v1/findings/FND-1/status')!;
    expect(JSON.parse(String(decision.init?.body))).toEqual({ status: 'FALSE_POSITIVE', reason: 'the catch is in generated code' });
    expect((decision.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
    wrapper.unmount();
  });

  it('shows the independent review and lets the user approve the fix plan or waive the review', async () => {
    const base = globalThis.fetch;
    const reviewTask: TaskSummary = { ...approvedTask, taskId: 'JRY-0007', title: 'Reviewed change', state: 'WAIT_REVIEW_FIX_APPROVAL' };
    const state = {
      taskId: 'JRY-0007',
      state: 'WAIT_REVIEW_FIX_APPROVAL',
      outcome: null,
      maxRounds: 3,
      openFindings: [{ findingId: 'FND-4', taskId: 'JRY-0007', repoRoot: 'D:\\Work\\shop', ruleId: 'review', ruleVersion: '1', source: 'review', category: 'security', severity: 'P1', confidence: 0.8, file: 'src/auth/login.ts', lineStart: 12, lineEnd: 12, title: 'Timing attack on login', evidence: 'a === b', whyItMatters: 'x', suggestedFix: 'y', planRelated: false, status: 'OPEN', statusReason: '', sessionId: null, agentId: null, firstSeenAt: NOW, lastSeenAt: NOW, updatedAt: NOW }],
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
    };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/tasks') return json([reviewTask]);
      if (url === '/api/v1/tasks/JRY-0007/review') return json(state);
      if (url === '/api/v1/tasks/JRY-0007/approvals' || url === '/api/v1/tasks/JRY-0007/review/skip') {
        calls.push({ url, init });
        return json(url.endsWith('skip') ? state : { ...approvedTask.planDecision, taskId: 'JRY-0007', stage: 'REVIEW_FIX' }, url.endsWith('skip') ? 200 : 201);
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await openTasks(wrapper);
    await flushPromises();
    const panel = wrapper.get('.review');
    expect(panel.text()).toContain('1 open finding(s)');
    expect(panel.text()).toContain('round 1 of at most 3');
    expect(panel.text()).toContain('Architecture, quality, UX: no report (gap)');
    expect(panel.text()).toContain('not independent: submitted from the main session');
    expect(panel.text()).toContain('Changed files no reviewer covered: src/auth/token.ts');
    expect(panel.text()).toContain('FND-4: use timingSafeEqual');

    await panel.findAll('button').find((candidate) => candidate.text() === 'Approve fix plan')!.trigger('click');
    await wrapper.get('form.dialog input').setValue('JRY-0007');
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(calls.find((call) => call.url === '/api/v1/tasks/JRY-0007/approvals')!.init?.body))).toEqual({ stage: 'REVIEW_FIX', version: 1, decision: 'APPROVED', comment: '', confirmTaskId: 'JRY-0007' });

    await wrapper.get('.review').findAll('button').find((candidate) => candidate.text() === 'Waive review')!.trigger('click');
    await wrapper.get('form.dialog input').setValue('JRY-0007');
    expect(wrapper.get('form.dialog button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('form.dialog textarea').setValue('prototype only');
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(calls.find((call) => call.url === '/api/v1/tasks/JRY-0007/review/skip')!.init?.body))).toEqual({ reason: 'prototype only', confirmTaskId: 'JRY-0007' });
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
      review: { outcome: 'passed', rounds: 2, reviewers: [], findings: { total: 1, fixed: 1, open: [] }, uncovered: [] },
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

    await button(wrapper, 'Final report', 'JRY-0004')!.trigger('click');
    await flushPromises();
    const report = wrapper.get('.final-report');
    expect(report.text()).toContain('Review: passed after 2 round(s)');
    expect(report.text()).toContain('feat(greeting): add greet helper');
    expect(report.get('a').attributes()).toMatchObject({ href: 'https://claude.ai/code/artifact/abc-123', rel: 'noopener noreferrer' });
    // Content is text, never markup.
    expect(report.html()).not.toContain('<img');
    expect(report.text()).toContain('<img src=x onerror=alert(1)>');
    wrapper.unmount();
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
      if (url === '/api/v1/evals/baseline') {
        calls.push({ url, init });
        return json(summary(2, true));
      }
      return base(url, init);
    });
    const wrapper = await mountApp();
    await wrapper.findAll('nav button').find((candidate) => candidate.text().startsWith('Evals'))!.trigger('click');
    await flushPromises();
    const text = wrapper.get('.evals').text();
    expect(text).toContain('Baseline: EVR-1');
    expect(text).toContain('release blocked: critical regression');
    expect(text).toContain('Changed since the baseline: rules');
    expect(text).toContain('plan-quality 4 label(s), 75%');
    expect(text).toContain('EVR-2 compared with EVR-1');
    expect(text).toContain('REGRESSION');
    expect(text).toContain('Git unchanged: HEAD moved');

    await wrapper.findAll('.evals button').find((candidate) => candidate.text() === 'Make baseline')!.trigger('click');
    await wrapper.get('form.dialog input').setValue('EVR-2');
    await wrapper.get('form.dialog textarea').setValue('the regression is intended');
    await wrapper.get('form.dialog').trigger('submit');
    await flushPromises();
    expect(JSON.parse(String(calls.find((call) => call.url === '/api/v1/evals/baseline')!.init?.body))).toEqual({ runId: 'EVR-2', note: 'the regression is intended', confirm: 'EVR-2' });
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
    await openTasks(wrapper);
    expect(button(wrapper, 'Plan drift', 'JRY-0002')).toBeUndefined();
    await button(wrapper, 'Plan drift', 'JRY-0001')!.trigger('click');
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
    const { planGrade: _grade, analyses: _analyses, agentRuns: _runs, ...older } = waitingTask;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/tasks') return new Response(JSON.stringify([older]), { status: 200, headers: { 'content-type': 'application/json' } });
      return base(url, init);
    });
    const errors: unknown[] = [];
    const wrapper = mount(App, { attachTo: document.body, global: { config: { errorHandler: (error) => errors.push(error) } } });
    await startDashboard();
    await flushPromises();
    await openTasks(wrapper);
    expect(errors).toEqual([]);
    expect(button(wrapper, 'Approve plan v1', 'JRY-0002')).toBeDefined();
    expect(wrapper.find('.plan-grade').exists()).toBe(false);
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
    await openTasks(wrapper);
    expect(button(wrapper, 'Changes since v1', 'JRY-0002')).toBeUndefined();
    await button(wrapper, 'Changes since v1', 'JRY-0001')!.trigger('click');
    await flushPromises();
    const diff = wrapper.get('.plan-diff');
    expect(diff.text()).toContain('Plan v1 → v2');
    expect(diff.text()).toContain('Scope (what JERRY checks edits against)');
    expect(diff.find('.diff__added').text()).toContain('tests/auth/**');
    expect(diff.text()).toContain('Add a login form with rate limiting.');
    expect(diff.text()).toContain('Should greetings be localised?');
    expect(diff.findAll('.diff__removed').map((item) => item.text()).join(' ')).toContain('Should greetings be localised?');
    expect(calls.some((call) => call.url === '/api/v1/tasks/JRY-0001/plans')).toBe(true);
    await button(wrapper, 'Hide changes', 'JRY-0001')!.trigger('click');
    expect(wrapper.find('.plan-diff').exists()).toBe(false);
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

  it('shows each repository’s profile: commands as they run here, instructions and suspicious text', async () => {
    const wrapper = await mountApp();
    await wrapper.findAll('nav button').find((button) => button.text().startsWith('Repositories'))!.trigger('click');
    const card = wrapper.get('article.repository');
    expect(card.text()).toContain('D:\\Work\\shop');
    expect(card.text()).toContain('out of date: stack');
    expect(card.text()).toContain('corepack pnpm run test');
    expect(card.text()).toContain('defines 1 hook group(s)');
    expect(card.text()).toContain('README.md:3');
    expect(wrapper.text()).toContain('Links between repositories');
    expect(wrapper.text()).toContain('package.json uses API schema docs/openapi.yaml');
    await card.findAll('button').find((button) => button.text() === 'Rescan')!.trigger('click');
    await flushPromises();
    const scan = calls.find((call) => call.url === '/api/v1/repositories/scan')!;
    expect(JSON.parse(String(scan.init?.body))).toEqual({ repoPath: 'D:\\Work\\shop' });
    expect((scan.init?.headers as Record<string, string>)['x-jerry-csrf']).toBe(CSRF);
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
