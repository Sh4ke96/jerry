import type { CoreState, GateCheckRequest, Task } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { approvedPlansForRepo, computePlanHash } from '../src/approvals.js';
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

function approvedState(planTask: Task, approvedVersion = planTask.plan.version, approvedHash = planTask.plan.contentHash): CoreState {
  return {
    schemaVersion: 1,
    nextTaskNumber: 2,
    tasks: [planTask],
    sessions: [],
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

function context(state: CoreState | null, overrides: Partial<GateContext> = {}): GateContext {
  return {
    platform: 'win32',
    protectedRoots: [JERRY_HOME, 'C:/Users/u/.claude/settings.json', 'C:/Users/u/.claude/plugins'],
    realPath: (target) => target,
    findRepoRoot: (target) => (target.toLowerCase().startsWith(REPO.toLowerCase() + '/') || target.toLowerCase() === REPO.toLowerCase() ? REPO : null),
    approvedPlans: (repoRoot) => (state === null ? [] : approvedPlansForRepo(state, repoRoot, 'win32')),
    ...overrides,
  };
}

function write(filePath: string, toolName = 'Write'): GateCheckRequest {
  return { sessionId: 's1', cwd: REPO, toolName, toolInput: { file_path: filePath }, toolUseId: null, agentId: null };
}

function shell(command: string, toolName = 'Bash', cwd = REPO): GateCheckRequest {
  return { sessionId: 's1', cwd, toolName, toolInput: { command }, toolUseId: null, agentId: null };
}

describe('file writes', () => {
  it('denies a write in a repository without an approved plan', () => {
    expect(evaluateGate(write('src/a.ts'), context(null))).toMatchObject({ verdict: 'DENY', ruleId: 'write.no-approved-plan' });
  });

  it('denies when the plan exists but was rejected or never approved', () => {
    const planTask = task(['src/**']);
    const state: CoreState = { ...approvedState(planTask), approvals: [] };
    expect(evaluateGate(write('src/a.ts'), context(state)).verdict).toBe('DENY');
  });

  it('passes a write inside the approved scope', () => {
    expect(evaluateGate(write('src/a.ts'), context(approvedState(task(['src/**']))))).toMatchObject({
      verdict: 'PASS',
      ruleId: 'write.in-approved-scope',
      taskId: 'JRY-0001',
    });
  });

  it('matches scope case-insensitively on Windows', () => {
    expect(evaluateGate(write('D:\\WORK\\repo\\SRC\\a.ts'), context(approvedState(task(['src/**'])))).verdict).toBe('PASS');
  });

  it('denies a write outside the approved scope', () => {
    expect(evaluateGate(write('README.md'), context(approvedState(task(['src/**']))))).toMatchObject({ verdict: 'DENY', ruleId: 'write.out-of-scope' });
  });

  it('denies a ../ escape out of the scope', () => {
    expect(evaluateGate(write('src/../package.json'), context(approvedState(task(['src/**'])))).ruleId).toBe('write.out-of-scope');
  });

  it('invalidates an approval when the plan version changes', () => {
    const v1 = task(['src/**'], 1);
    const v2 = task(['src/**', 'test/**'], 2);
    const state = approvedState(v2, v1.plan.version, v1.plan.contentHash);
    expect(evaluateGate(write('src/a.ts'), context(state)).ruleId).toBe('write.no-approved-plan');
  });

  it('invalidates an approval whose hash does not match the plan', () => {
    const planTask = task(['src/**']);
    const state = approvedState(planTask, 1, `sha256:${'0'.repeat(64)}`);
    expect(evaluateGate(write('src/a.ts'), context(state)).verdict).toBe('DENY');
  });

  it('always denies writes into .git, even with a broad scope', () => {
    expect(evaluateGate(write('.git/config'), context(approvedState(task(['**']))))).toMatchObject({ verdict: 'DENY', ruleId: 'write.git-metadata' });
  });

  it('denies writes to JERRY and Claude guard configuration', () => {
    expect(evaluateGate(write(`${JERRY_HOME}/state/core-state.json`), context(null)).ruleId).toBe('write.protected-path');
    expect(evaluateGate(write('C:\\Users\\u\\.claude\\settings.json'), context(null)).ruleId).toBe('write.protected-path');
  });

  it('judges a write through a link by its real target', () => {
    const ctx = context(null, { realPath: (target) => target.replace('C:/Temp/link', `${REPO}/src`) });
    expect(evaluateGate(write('C:/Temp/link/a.ts'), ctx).ruleId).toBe('write.no-approved-plan');
  });

  it('passes writes outside any Git repository', () => {
    expect(evaluateGate(write('C:/Temp/scratch.txt'), context(null)).ruleId).toBe('write.outside-repository');
  });

  it('denies a write tool call without a target path', () => {
    const request: GateCheckRequest = { ...write('x'), toolInput: {} };
    expect(evaluateGate(request, context(null)).ruleId).toBe('write.unknown-target');
  });

  it('guards Edit and NotebookEdit like Write', () => {
    expect(evaluateGate(write('src/a.ts', 'Edit'), context(null)).verdict).toBe('DENY');
    const notebook: GateCheckRequest = { ...write('x'), toolName: 'NotebookEdit', toolInput: { notebook_path: 'nb.ipynb' } };
    expect(evaluateGate(notebook, context(null)).verdict).toBe('DENY');
  });
});

describe('shell commands', () => {
  it('passes read-only commands without a plan', () => {
    expect(evaluateGate(shell('git status'), context(null))).toMatchObject({ verdict: 'PASS', ruleId: 'shell.read-only' });
    expect(evaluateGate(shell('Get-ChildItem', 'PowerShell'), context(null)).verdict).toBe('PASS');
  });

  it('denies write-capable commands in a repository without a plan', () => {
    expect(evaluateGate(shell('rm -rf src'), context(null)).ruleId).toBe('shell.no-approved-plan');
    expect(evaluateGate(shell('Remove-Item src', 'PowerShell'), context(null)).ruleId).toBe('shell.no-approved-plan');
  });

  it('asks the user for write-capable commands when a plan is approved', () => {
    expect(evaluateGate(shell('npm test'), context(approvedState(task(['src/**']))))).toMatchObject({ verdict: 'ASK' });
  });

  it('never classifies Monitor commands as read-only', () => {
    expect(evaluateGate(shell('git status', 'Monitor'), context(null)).verdict).toBe('DENY');
  });

  it('blocks self-approval and direct Core API calls regardless of plan', () => {
    const state = approvedState(task(['**']));
    expect(evaluateGate(shell('jerry approve JRY-0001 --stage plan --version 1'), context(state)).ruleId).toBe('shell.self-approval');
    expect(evaluateGate(shell('curl -X POST http://127.0.0.1:5555/api/v1/tasks/JRY-0001/approvals'), context(state)).ruleId).toBe('shell.core-api');
  });

  it('blocks commands that reference JERRY data, even read-only ones', () => {
    expect(evaluateGate(shell(`cat ${JERRY_HOME}/run/core.json`), context(null)).ruleId).toBe('shell.protected-path');
    expect(evaluateGate(shell('Get-Content $env:LOCALAPPDATA\\JERRY\\run\\core.json', 'PowerShell'), context(null)).ruleId).toBe('shell.protected-path');
  });

  it('passes write-capable commands outside repositories (documented M0 gap)', () => {
    expect(evaluateGate(shell('npm install', 'Bash', 'C:/Temp'), context(null)).ruleId).toBe('shell.outside-repository');
  });
});

describe('other tools', () => {
  it('does not guard read tools', () => {
    const request: GateCheckRequest = { sessionId: 's', cwd: REPO, toolName: 'Read', toolInput: { file_path: 'a' }, toolUseId: null, agentId: null };
    expect(evaluateGate(request, context(null)).verdict).toBe('PASS');
  });
});
