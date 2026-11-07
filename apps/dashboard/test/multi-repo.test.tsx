// @vitest-environment happy-dom
import type { ImplementationReportRecord, TaskSummary, Workspace } from '@jerry/contracts';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { sampleMultiRepoPlan } from '../../../tests/helpers/plan-fixture';
import { ImplementationReportView } from '../src/components/ImplementationReport';
import { PlanDocumentView } from '../src/components/PlanDocument';
import { TaskTile } from '../src/components/TaskTile';
import { distinctCount, workspaceSummary } from '../src/components/WorkspacesCard';
import { repositoryNames, taskRoots, taskTouches } from '../src/lib/tasks';

const NOW = new Date().toISOString();
const API = 'D:\\Work\\api';
const SHOP = 'D:\\Work\\shop';
const ADMIN = 'D:\\Work\\admin';

function task(repositories?: string[]): TaskSummary {
  return {
    taskId: 'JRY-0007',
    title: 'Greeting across the workspace',
    repoRoot: API,
    createdAt: NOW,
    state: 'IMPLEMENTATION',
    plan: {
      version: 1,
      contentHash: `sha256:${'a'.repeat(64)}`,
      scope: ['src/**'],
      createdAt: NOW,
      ...(repositories === undefined ? {} : { repositories: repositories.map((repoRoot) => ({ repoRoot, scope: ['web/**'], exclude: [] })) }),
    },
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
  };
}

describe('a task across several repositories in the dashboard', () => {
  it('knows every repository of a task and which ones it touches', () => {
    expect(taskRoots(task())).toEqual([API]);
    expect(taskRoots(task([SHOP, ADMIN]))).toEqual([API, SHOP, ADMIN]);
    expect(taskTouches(task([SHOP]), SHOP)).toBe(true);
    expect(taskTouches(task([SHOP]), ADMIN)).toBe(false);
    expect(taskTouches(task(), 'D:\\Work')).toBe(true);
  });

  it('tells repositories with the same folder name apart', () => {
    const names = repositoryNames(['D:\\Work\\api', 'D:\\Other\\api', 'D:\\Work\\shop']);
    expect([...names.values()]).toEqual(['Work/api', 'Other/api', 'shop']);
  });

  it('shows "+N" with an accessible name on the task bar, and nothing for one repository', () => {
    const multi = mount(TaskTile, { props: { task: task([SHOP, ADMIN]) } });
    const badge = multi.get('[data-task-repos]');
    expect(badge.text()).toBe('+2');
    expect(badge.attributes('aria-label')).toBe('also in shop, admin');
    expect(mount(TaskTile, { props: { task: task() } }).find('[data-task-repos]').exists()).toBe(false);
  });

  it('counts a task across repositories of a workspace once, and sums for an older Core', () => {
    const repo = (repoRoot: string, ids: string[] | undefined) => ({ repoRoot, project: true, present: true, openTasks: ids?.length ?? 1, waiting: 0, openTaskIds: ids as string[], waitingTaskIds: [] as string[] });
    const workspace: Workspace = { id: 1, name: 'Shop', createdAt: NOW, repos: [repo(API, ['JRY-0007']), repo(SHOP, ['JRY-0007', 'JRY-0008'])] };
    expect(distinctCount(workspace, 'open')).toBe(2);
    expect(workspaceSummary(workspace)).toBe('2 repositories · 2 open task(s)');
    const older: Workspace = { ...workspace, repos: [repo(API, undefined), repo(SHOP, undefined)] };
    expect(distinctCount(older, 'open')).toBe(2);
  });

  it('shows the repository of each change and step, and the other repositories with their scopes', () => {
    const wrapper = mount(PlanDocumentView, { props: { plan: sampleMultiRepoPlan([API, SHOP], ['src/**']) } });
    expect(wrapper.findAll('[data-plan-repository]').map((item) => item.attributes('data-plan-repository'))).toEqual([SHOP]);
    expect(wrapper.findAll('[data-repository-badge]').map((badge) => badge.text())).toEqual(['api', 'shop', 'shop', 'api', 'shop']);
  });

  it('shows what JERRY recorded per repository in a report', () => {
    const record = {
      taskId: 'JRY-0007',
      version: 1,
      planVersion: 1,
      contentHash: `sha256:${'b'.repeat(64)}`,
      submittedBy: 'claude',
      sessionId: null,
      createdAt: NOW,
      document: {
        summary: 'Greeting in api and shop.',
        changes: [
          { repository: '', path: 'src/greet.ts', kind: 'added', description: 'api part' },
          { repository: SHOP, path: 'web/greet.ts', kind: 'added', description: 'shop part' },
        ],
        agents: [],
        skills: [],
        checks: [],
        planDeviations: [],
        risks: [],
        commitSubjects: ['feat: greeting'],
        qaScenarios: [],
        artifact: '',
      },
      evidence: {
        since: NOW,
        deviations: [],
        deviationCount: 0,
        blockedCount: 0,
        observedEdits: ['src/greet.ts', 'D:/Work/shop/web/greet.ts'],
        unreportedEdits: ['D:/Work/shop/web/extra.ts'],
        failedOrNotRunChecks: 0,
        git: null,
        repositories: [
          { repoRoot: API, observedEdits: ['src/greet.ts'], unreportedEdits: [], git: null },
          { repoRoot: SHOP, observedEdits: ['web/greet.ts'], unreportedEdits: ['web/extra.ts'], git: { baselineHead: null, baselineAt: null, changed: ['web/greet.ts', 'web/extra.ts'], userChanged: [] } },
        ],
      },
    } as unknown as ImplementationReportRecord;
    const wrapper = mount(ImplementationReportView, { props: { report: record } });
    const rows = wrapper.findAll('[data-evidence-repository]').map((row) => row.text());
    expect(rows[0]).toContain('api: 1 file(s) edited · Git not read');
    expect(rows[1]).toContain('shop: 1 file(s) edited · 2 changed in Git · 1 not in the report');
    expect(wrapper.text()).toContain('shop');
  });
});
