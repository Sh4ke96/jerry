import type { CoreState, GateCheckRequest, Task } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { approvedPlansForRepo, computePlanHash, isRepoExcluded } from '../src/approvals.js';
import { evaluateGate, type GateContext } from '../src/gate.js';

const REPO = 'D:/Work/Repo';
const JERRY_HOME = 'C:/Users/u/AppData/Local/JERRY';

function task(scope: string[], version = 1, repoRoot = REPO): Task {
  const taskId = 'JRY-0001';
  return {
    taskId,
    title: 'Add feature',
    repoRoot,
    createdAt: '2026-11-06T10:00:00.000Z',
    plan: { version, scope, contentHash: computePlanHash({ taskId, title: 'Add feature', repoRoot, version, scope }), createdAt: '2026-11-06T10:00:00.000Z' },
  };
}

function emptyState(): CoreState {
  return { schemaVersion: 1, nextTaskNumber: 1, tasks: [], approvals: [], sessions: [], excludedRepos: [] };
}

function approvedState(planTask: Task, approvedVersion = planTask.plan.version, approvedHash = planTask.plan.contentHash): CoreState {
  return {
    ...emptyState(),
    nextTaskNumber: 2,
    tasks: [planTask],
    approvals: [
      {
        approvalId: 'apr_1',
        taskId: planTask.taskId,
        stage: 'PLAN',
        version: approvedVersion,
        contentHash: approvedHash,
        decision: 'APPROVED',
        approvedBy: 'local-user',
        approvedAt: '2026-11-06T10:05:00.000Z',
        comment: '',
      },
    ],
  };
}

function context(state: CoreState = emptyState(), overrides: Partial<GateContext> = {}): GateContext {
  return {
    platform: 'win32',
    protectedRoots: [JERRY_HOME, 'C:/Users/u/.claude/settings.json', 'C:/Users/u/.claude/plugins'],
    realPath: (target) => target,
    findRepoRoot: (target) => (target.toLowerCase().startsWith(REPO.toLowerCase() + '/') || target.toLowerCase() === REPO.toLowerCase() ? REPO : null),
    approvedPlans: (repoRoot) => approvedPlansForRepo(state, repoRoot, 'win32'),
    isExcluded: (repoRoot) => isRepoExcluded(state, repoRoot, 'win32'),
    ...overrides,
  };
}

function write(filePath: string, toolName = 'Write'): GateCheckRequest {
  return { sessionId: 's1', cwd: REPO, toolName, toolInput: { file_path: filePath }, toolUseId: null, agentId: null };
}

function shell(command: string, toolName = 'Bash', cwd = REPO): GateCheckRequest {
  return { sessionId: 's1', cwd, toolName, toolInput: { command }, toolUseId: null, agentId: null };
}

describe('monitoring: file writes are never blocked, deviations are warned', () => {
  it('warns about a write in a repository without an approved plan', () => {
    expect(evaluateGate(write('src/a.ts'), context())).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.no-approved-plan' });
  });

  it('warns when the plan exists but was not approved', () => {
    const state: CoreState = { ...approvedState(task(['src/**'])), approvals: [] };
    expect(evaluateGate(write('src/a.ts'), context(state)).verdict).toBe('WARN');
  });

  it('passes a write inside the approved scope, case-insensitively on Windows', () => {
    const state = approvedState(task(['src/**']));
    expect(evaluateGate(write('src/a.ts'), context(state))).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.in-approved-scope', taskId: 'JRY-0001' });
    expect(evaluateGate(write('D:\\WORK\\repo\\SRC\\a.ts'), context(state)).verdict).toBe('PASS');
  });

  it('warns about writes outside the approved scope, including ../ escapes', () => {
    const state = approvedState(task(['src/**']));
    expect(evaluateGate(write('README.md'), context(state))).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.out-of-scope' });
    expect(evaluateGate(write('src/../package.json'), context(state)).ruleId).toBe('monitor.out-of-scope');
  });

  it('treats an approval of an older plan version or another hash as no approval', () => {
    const v1 = task(['src/**'], 1);
    const v2 = task(['src/**', 'test/**'], 2);
    expect(evaluateGate(write('src/a.ts'), context(approvedState(v2, v1.plan.version, v1.plan.contentHash))).ruleId).toBe('monitor.no-approved-plan');
    expect(evaluateGate(write('src/a.ts'), context(approvedState(v1, 1, `sha256:${'0'.repeat(64)}`))).verdict).toBe('WARN');
  });

  it('judges a write through a link by its real target', () => {
    const ctx = context(emptyState(), { realPath: (target) => target.replace('C:/Temp/link', `${REPO}/src`) });
    expect(evaluateGate(write('C:/Temp/link/a.ts'), ctx).ruleId).toBe('monitor.no-approved-plan');
  });

  it('passes writes outside any Git repository', () => {
    expect(evaluateGate(write('C:/Temp/scratch.txt'), context()).ruleId).toBe('monitor.outside-repository');
  });

  it('does not monitor repositories the user excluded', () => {
    const state: CoreState = { ...emptyState(), excludedRepos: [{ repoRoot: 'd:\\work\\repo', excludedAt: '2026-11-06T10:00:00.000Z' }] };
    expect(evaluateGate(write('src/a.ts'), context(state))).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.repo-excluded' });
  });

  it('warns about a write tool call without a target path', () => {
    const request: GateCheckRequest = { ...write('x'), toolInput: {} };
    expect(evaluateGate(request, context()).ruleId).toBe('monitor.unknown-target');
  });

  it('monitors Edit and NotebookEdit like Write', () => {
    expect(evaluateGate(write('src/a.ts', 'Edit'), context()).verdict).toBe('WARN');
    const notebook: GateCheckRequest = { ...write('x'), toolName: 'NotebookEdit', toolInput: { notebook_path: 'nb.ipynb' } };
    expect(evaluateGate(notebook, context()).verdict).toBe('WARN');
  });
});

describe('monitoring: shell commands', () => {
  it('passes read-only commands', () => {
    expect(evaluateGate(shell('git status'), context())).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.read-only-command' });
    expect(evaluateGate(shell('Get-ChildItem', 'PowerShell'), context()).verdict).toBe('PASS');
  });

  it('warns about write-capable commands in a repository without a plan', () => {
    expect(evaluateGate(shell('npm install'), context()).ruleId).toBe('monitor.no-approved-plan');
    expect(evaluateGate(shell('Remove-Item src', 'PowerShell'), context()).verdict).toBe('WARN');
  });

  it('passes write-capable commands when a plan is approved', () => {
    expect(evaluateGate(shell('npm test'), context(approvedState(task(['src/**']))))).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.command-with-approved-plan' });
  });

  it('never treats Monitor commands as read-only', () => {
    expect(evaluateGate(shell('ls', 'Monitor'), context()).verdict).toBe('WARN');
  });

  it('passes write-capable commands outside repositories', () => {
    expect(evaluateGate(shell('npm install', 'Bash', 'C:/Temp'), context()).ruleId).toBe('monitor.outside-repository');
  });
});

describe('hard rules: always blocked, with or without a plan, in excluded repositories too', () => {
  const approved = approvedState(task(['**']));
  const excluded: CoreState = { ...approved, excludedRepos: [{ repoRoot: REPO, excludedAt: '2026-11-06T10:00:00.000Z' }] };

  it.each([
    ['git commit -m "x"', 'Bash'],
    ['git push origin main', 'Bash'],
    ['git add . && git commit -m x', 'Bash'],
    ['npm test && git push', 'Bash'],
    ['git -C D:/Work/Repo push', 'Bash'],
    ['git checkout -- src', 'PowerShell'],
    ['& git reset --hard', 'PowerShell'],
    ['npm version patch', 'Bash'],
  ])('blocks %s (%s)', (command, tool) => {
    for (const state of [emptyState(), approved, excluded]) {
      expect(evaluateGate(shell(command, tool), context(state))).toMatchObject({ verdict: 'DENY', ruleId: 'hard.git-mutation' });
    }
  });

  it('blocks Git changes started from outside a repository', () => {
    expect(evaluateGate(shell('git -C D:/Work/Repo commit -m x', 'Bash', 'C:/Temp'), context()).ruleId).toBe('hard.git-mutation');
  });

  it('blocks writes inside .git, even with a plan covering everything', () => {
    expect(evaluateGate(write('.git/config'), context(approved))).toMatchObject({ verdict: 'DENY', ruleId: 'hard.git-metadata' });
    expect(evaluateGate(write('sub/.git/hooks/pre-commit'), context(excluded)).ruleId).toBe('hard.git-metadata');
  });

  it('does not confuse .gitignore or .github with Git metadata', () => {
    expect(evaluateGate(write('.gitignore'), context(approved)).verdict).toBe('PASS');
    expect(evaluateGate(write('.github/workflows/ci.yml'), context(approved)).verdict).toBe('PASS');
  });

  it('blocks writes to JERRY data and Claude guard configuration', () => {
    expect(evaluateGate(write(`${JERRY_HOME}/state/core-state.json`), context()).ruleId).toBe('hard.protected-path');
    expect(evaluateGate(write('C:\\Users\\u\\.claude\\settings.json'), context()).ruleId).toBe('hard.protected-path');
  });

  it('blocks user-only JERRY commands and direct Core API calls', () => {
    expect(evaluateGate(shell('jerry approve JRY-0001 --stage plan --version 1'), context(approved)).ruleId).toBe('hard.user-only-command');
    expect(evaluateGate(shell('node dist/cli/jerry.mjs repo exclude .'), context()).ruleId).toBe('hard.user-only-command');
    expect(evaluateGate(shell('node dist/cli/jerry.mjs core stop'), context()).ruleId).toBe('hard.user-only-command');
    expect(evaluateGate(shell('jerry uninstall --purge-data'), context()).ruleId).toBe('hard.user-only-command');
    expect(evaluateGate(shell('curl -X POST http://127.0.0.1:5555/api/v1/tasks/JRY-0001/approvals'), context(approved)).ruleId).toBe('hard.core-api');
  });

  it('blocks commands that reference JERRY data, even read-only ones', () => {
    expect(evaluateGate(shell(`cat ${JERRY_HOME}/run/core.json`), context()).ruleId).toBe('hard.protected-path');
    expect(evaluateGate(shell('Get-Content $env:LOCALAPPDATA\\JERRY\\run\\core.json', 'PowerShell'), context()).ruleId).toBe('hard.protected-path');
  });

  it('lets agents run read-only JERRY commands without a warning', () => {
    for (const command of ['node dist/cli/jerry.mjs status', 'jerry core status', 'jerry repo list', 'jerry task list', 'jerry doctor']) {
      expect(evaluateGate(shell(command), context())).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.read-only-command' });
    }
  });

  it('blocks Git-changing MCP tools and lets other MCP tools through', () => {
    const mcp = (toolName: string): GateCheckRequest => ({ sessionId: 's', cwd: REPO, toolName, toolInput: {}, toolUseId: null, agentId: null });
    expect(evaluateGate(mcp('mcp__github__push_files'), context(approved))).toMatchObject({ verdict: 'DENY', ruleId: 'hard.git-mutation' });
    expect(evaluateGate(mcp('mcp__github__get_file_contents'), context())).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.mcp-tool' });
    expect(evaluateGate(mcp('mcp__stripe__create_checkout_session'), context()).verdict).toBe('PASS');
  });

  it('allows read-only Git', () => {
    for (const command of ['git status', 'git diff HEAD~1', 'git log --oneline -5', 'git --no-pager show HEAD', 'gh pr view 12']) {
      expect(evaluateGate(shell(command), context()).verdict).not.toBe('DENY');
    }
  });
});

describe('other tools', () => {
  it('does not monitor read tools', () => {
    const request: GateCheckRequest = { sessionId: 's', cwd: REPO, toolName: 'Read', toolInput: { file_path: 'a' }, toolUseId: null, agentId: null };
    expect(evaluateGate(request, context()).verdict).toBe('PASS');
  });
});
