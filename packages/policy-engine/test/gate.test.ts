import type { CoreState, GateCheckRequest, Task, WorkflowState } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { approvedPlansForRepo, computePlanHash, computeReportHash } from '../src/approvals.js';
import { evaluateGate, type GateContext } from '../src/gate.js';

const REPO = 'D:/Work/Repo';
const JERRY_HOME = 'C:/Users/u/AppData/Local/JERRY';

function task(scope: string[], version = 1, repoRoot = REPO, state: WorkflowState = 'IMPLEMENTATION'): Task {
  const taskId = 'JRY-0001';
  return {
    taskId,
    title: 'Add feature',
    repoRoot,
    createdAt: '2026-11-06T10:00:00.000Z',
    state,
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
    // The fixture repository is a project unless a test says otherwise.
    isMonitored: (repoRoot) => repoRoot.toLowerCase() === REPO.toLowerCase(),
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

  it('warns about editing a file that had the user’s uncommitted changes, within the scope too', () => {
    const state = approvedState(task(['src/**']));
    const userFiles = context(state, { isUserChangedFile: (taskId, relative) => taskId === 'JRY-0001' && relative === 'src/app.ts' });
    expect(evaluateGate(write('src/app.ts'), userFiles)).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.user-uncommitted-file', taskId: 'JRY-0001', reason: expect.stringContaining("user's uncommitted changes") });
    expect(evaluateGate(write('src/other.ts'), userFiles).verdict).toBe('PASS');
    // Outside the scope the out-of-scope warning comes first; with no plan there is no baseline.
    expect(evaluateGate(write('README.md'), userFiles).ruleId).toBe('monitor.out-of-scope');
  });

  it('covers edits only while the task is being implemented', () => {
    for (const state of ['WAIT_IMPLEMENTATION_ACCEPTANCE', 'PAUSED', 'FINAL_REPORT', 'DONE', 'CANCELLED', 'WAIT_PLAN_APPROVAL'] as const) {
      expect(evaluateGate(write('src/a.ts'), context(approvedState(task(['src/**'], 1, REPO, state)))).ruleId, state).toBe('monitor.no-approved-plan');
    }
    expect(evaluateGate(write('src/a.ts'), context(approvedState(task(['src/**'], 1, REPO, 'FIX_IMPLEMENTATION')))).verdict).toBe('PASS');
  });

  it('judges a write through a link by its real target', () => {
    const ctx = context(emptyState(), { realPath: (target) => target.replace('C:/Temp/link', `${REPO}/src`) });
    expect(evaluateGate(write('C:/Temp/link/a.ts'), ctx).ruleId).toBe('monitor.no-approved-plan');
  });

  it('passes writes outside any Git repository', () => {
    expect(evaluateGate(write('C:/Temp/scratch.txt'), context()).ruleId).toBe('monitor.outside-repository');
  });

  it('does not monitor repositories that are not added as projects', () => {
    const notAdded = context(approvedState(task(['src/**'])), { isMonitored: () => false });
    expect(evaluateGate(write('README.md'), notAdded)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.not-a-project', taskId: null, repoRoot: REPO });
    expect(evaluateGate(shell('npm install'), notAdded)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.not-a-project' });
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

describe('hard rules: always blocked, with or without a plan, outside projects too', () => {
  const approved = approvedState(task(['**']));
  const notAdded = (state: CoreState = emptyState()): GateContext => context(state, { isMonitored: () => false });

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
    for (const ctx of [context(), context(approved), notAdded(approved)]) {
      expect(evaluateGate(shell(command, tool), ctx)).toMatchObject({ verdict: 'DENY', ruleId: 'hard.git-mutation' });
    }
  });

  it('blocks Git changes started from outside a repository', () => {
    expect(evaluateGate(shell('git -C D:/Work/Repo commit -m x', 'Bash', 'C:/Temp'), context()).ruleId).toBe('hard.git-mutation');
  });

  it('blocks writes inside .git, even with a plan covering everything', () => {
    expect(evaluateGate(write('.git/config'), context(approved))).toMatchObject({ verdict: 'DENY', ruleId: 'hard.git-metadata' });
    expect(evaluateGate(write('sub/.git/hooks/pre-commit'), notAdded()).ruleId).toBe('hard.git-metadata');
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
    expect(evaluateGate(shell('node dist/cli/jerry.mjs ui --print-url'), context()).ruleId).toBe('hard.user-only-command');
    for (const action of ['pause', 'resume', 'cancel', 'recheck']) {
      expect(evaluateGate(shell(`jerry task ${action} JRY-0001`), context()).ruleId, action).toBe('hard.user-only-command');
    }
    // Re-running the final checks can set DONE: the user's decision, in every spelling of the CLI.
    for (const command of ['node dist/cli/jerry.mjs task recheck JRY-0001', 'jerry.cmd TASK  RECHECK JRY-0001', 'jerry.ps1 task recheck jry-0001']) {
      expect(evaluateGate(shell(command), context()).ruleId, command).toBe('hard.user-only-command');
      expect(evaluateGate(shell(command), notAdded()).ruleId, command).toBe('hard.user-only-command');
    }
    for (const command of ['jerry project add .', 'jerry project add', 'node dist/cli/jerry.mjs project remove D:/Work/Repo', 'jerry.cmd PROJECT  ADD', 'jerry data prune --done-older-than 30', 'jerry data forget D:/Work/Repo', 'jerry repo include .']) {
      expect(evaluateGate(shell(command), context()).ruleId, command).toBe('hard.user-only-command');
      expect(evaluateGate(shell(command), notAdded()).ruleId, command).toBe('hard.user-only-command');
    }
    // Changing a setting is the user's decision too.
    for (const command of ['jerry settings set review.mode required', 'jerry settings set review.mode inherit --project .', 'node dist/cli/jerry.mjs settings set qa.language en', 'jerry.cmd SETTINGS  SET qa.language pl']) {
      expect(evaluateGate(shell(command), context()).ruleId, command).toBe('hard.user-only-command');
      expect(evaluateGate(shell(command), notAdded()).ruleId, command).toBe('hard.user-only-command');
    }
    // Turning JERRY's status line on or off edits the Claude Code settings: the user's decision.
    for (const command of ['jerry statusline enable', 'jerry statusline disable', 'node dist/cli/jerry.mjs statusline enable', 'jerry.cmd STATUSLINE  DISABLE']) {
      expect(evaluateGate(shell(command), context()).ruleId, command).toBe('hard.user-only-command');
      expect(evaluateGate(shell(command), notAdded()).ruleId, command).toBe('hard.user-only-command');
    }
    // Turning usage collection (status line and telemetry) on or off edits them too.
    for (const command of ['jerry usage enable', 'jerry usage disable', 'node dist/cli/jerry.mjs usage enable', 'jerry.cmd USAGE  DISABLE', 'jerry.ps1 usage enable']) {
      expect(evaluateGate(shell(command), context()).ruleId, command).toBe('hard.user-only-command');
      expect(evaluateGate(shell(command), notAdded()).ruleId, command).toBe('hard.user-only-command');
    }
    // Adding, switching, updating and removing a Claude Code skill is the user's decision.
    for (const command of ['jerry skill add https://github.com/acme/skills/tree/main/pdf', 'jerry skill enable pdf', 'jerry skill disable pdf', 'node dist/cli/jerry.mjs skill update pdf', 'jerry.cmd SKILL  REMOVE pdf', 'jerry.ps1 skill add ./my-skill']) {
      expect(evaluateGate(shell(command), context()).ruleId, command).toBe('hard.user-only-command');
      expect(evaluateGate(shell(command), notAdded()).ruleId, command).toBe('hard.user-only-command');
    }
    // Listing and showing skills is read-only.
    for (const command of ['jerry skill list', 'jerry skill show pdf', 'node dist/cli/jerry.mjs skill list --json']) expect(evaluateGate(shell(command), context()).verdict, command).not.toBe('DENY');
    // Reading projects, data usage, settings, the status line and the usage state is not a user-only action.
    for (const command of ['jerry project list', 'jerry data', 'jerry data --json', 'jerry settings', 'jerry settings --json', 'jerry settings show', 'jerry statusline status', 'jerry statusline status --json', 'jerry usage', 'jerry usage status', 'jerry usage status --json', 'jerry data usage']) expect(evaluateGate(shell(command), context()).verdict, command).not.toBe('DENY');
    expect(evaluateGate(shell('jerry task show JRY-0001'), context()).verdict).toBe('PASS');
    expect(evaluateGate(shell('jerry task list'), context()).verdict).toBe('PASS');
    expect(evaluateGate(shell('node dist/cli/jerry.mjs task list --all'), context()).verdict).toBe('PASS');
    expect(evaluateGate(shell('jerry repo scan . --json'), context()).verdict).toBe('PASS');
    expect(evaluateGate(shell('jerry repo scan; rm -rf src'), context()).verdict).not.toBe('PASS');
    expect(evaluateGate(shell('curl -c c.txt "http://127.0.0.1:47823/ui/login?code=abc"'), context()).ruleId).toBe('hard.core-api');
    expect(evaluateGate(shell('curl -X POST http://127.0.0.1:5555/api/v1/tasks/JRY-0001/approvals'), context(approved)).ruleId).toBe('hard.core-api');
    expect(evaluateGate(shell('curl -X POST http://127.0.0.1:5555/api/v1/tasks/JRY-0001/final-checks'), context(approved)).ruleId).toBe('hard.core-api');
  });

  it('blocks commands that reference JERRY data, even read-only ones', () => {
    expect(evaluateGate(shell(`cat ${JERRY_HOME}/run/core.json`), context()).ruleId).toBe('hard.protected-path');
    expect(evaluateGate(shell('Get-Content $env:LOCALAPPDATA\\JERRY\\run\\core.json', 'PowerShell'), context()).ruleId).toBe('hard.protected-path');
    for (const command of ['cat $JERRY_HOME/run/core.json', 'cat ${JERRY_HOME}/run/core.json', 'type %JERRY_HOME%\\run\\core.json', 'Get-Content $env:JERRY_HOME\\run\\core.json']) {
      expect(evaluateGate(shell(command), context()).ruleId).toBe('hard.protected-path');
    }
  });

  it('does not treat source code that mentions the JERRY_HOME identifier as JERRY data', () => {
    const command = `sed -i "s#{ JERRY_HOME: home }#{ JERRY_HOME: home, JERRY_CORE_PORT: '0' }#" scripts/e2e-live.mjs`;
    expect(evaluateGate(shell(command), context(approvedState(task(['**'])))).verdict).not.toBe('DENY');
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

describe('computePlanHash', () => {
  const base = { taskId: 'JRY-0001', title: 't', repoRoot: REPO, version: 1, scope: ['src/**'] };

  it('keeps the hash of plans without a document (approvals made before documents stay valid)', () => {
    expect(computePlanHash(base)).toBe(computePlanHash({ ...base, document: undefined }));
  });

  it('binds the approval to the whole document, independent of key order', () => {
    const document = { goal: 'g', steps: [{ step: 's', files: [] }] };
    const reordered = { steps: [{ files: [], step: 's' }], goal: 'g' };
    expect(computePlanHash({ ...base, document })).toBe(computePlanHash({ ...base, document: reordered }));
    expect(computePlanHash({ ...base, document })).not.toBe(computePlanHash(base));
    expect(computePlanHash({ ...base, document })).not.toBe(computePlanHash({ ...base, document: { ...document, goal: 'other' } }));
  });

  it('keeps the exact hash of a single-repository plan (stored approvals stay valid)', () => {
    const fixed = 'sha256:657e69c1b0d8aea2370dc64c7d7cd8f26c7a6859a3943ca51c180715b562c38d';
    expect(computePlanHash(base)).toBe(fixed);
    expect(computePlanHash({ ...base, repositories: undefined })).toBe(fixed);
    expect(computePlanHash({ ...base, repositories: [] })).toBe(fixed);
  });

  it('binds the other repositories and their scopes, in any order', () => {
    const shop = { repoRoot: 'D:/Work/shop', scope: ['src/**'], exclude: [] };
    const admin = { repoRoot: 'D:/Work/admin', scope: ['app/**'], exclude: ['app/legacy/**'] };
    const both = computePlanHash({ ...base, repositories: [shop, admin] });
    expect(both).toBe(computePlanHash({ ...base, repositories: [admin, shop] }));
    expect(both).not.toBe(computePlanHash(base));
    expect(both).not.toBe(computePlanHash({ ...base, repositories: [shop, { ...admin, scope: ['app/x/**'] }] }));
    expect(both).not.toBe(computePlanHash({ ...base, repositories: [shop] }));
  });
});

describe('a plan across several repositories', () => {
  const SHOP = 'D:/Work/Shop';
  const multi = (): Task => {
    const base = task(['src/**']);
    const repositories = [{ repoRoot: SHOP, scope: ['web/**'], exclude: [] }];
    return { ...base, plan: { ...base.plan, repositories, contentHash: computePlanHash({ taskId: base.taskId, title: base.title, repoRoot: REPO, version: 1, scope: ['src/**'], repositories }) } };
  };
  const inEither = (target: string): string | null => {
    const lower = target.toLowerCase();
    for (const root of [REPO, SHOP]) if (lower === root.toLowerCase() || lower.startsWith(root.toLowerCase() + '/')) return root;
    return null;
  };
  const both = (state: CoreState, overrides: Partial<GateContext> = {}): GateContext => context(state, { findRepoRoot: inEither, isMonitored: (root) => inEither(root) !== null, ...overrides });

  it('covers each repository with its own scope, and nothing else', () => {
    const state = approvedState(multi());
    expect(approvedPlansForRepo(state, SHOP, 'win32')).toEqual([{ taskId: 'JRY-0001', planVersion: 1, scope: ['web/**'] }]);
    expect(approvedPlansForRepo(state, REPO, 'win32')).toEqual([{ taskId: 'JRY-0001', planVersion: 1, scope: ['src/**'] }]);
    expect(approvedPlansForRepo(state, 'D:/Work/Admin', 'win32')).toEqual([]);
    expect(evaluateGate(write(`${SHOP}/web/a.ts`), both(state))).toMatchObject({ verdict: 'PASS', taskId: 'JRY-0001', repoRoot: SHOP });
    // src/** is the scope of the task's own repository, not of the shop.
    expect(evaluateGate(write(`${SHOP}/src/a.ts`), both(state))).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.out-of-scope', repoRoot: SHOP });
    expect(evaluateGate(write('src/a.ts'), both(state))).toMatchObject({ verdict: 'PASS', repoRoot: REPO });
  });

  it('asks about the user\'s uncommitted files per repository: the same path in two repositories is two files', () => {
    const asked: Array<[string, string | undefined]> = [];
    const state = approvedState(multi());
    const ctx = both(state, {
      isUserChangedFile: (_taskId, relative, repoRoot) => {
        asked.push([relative, repoRoot]);
        return repoRoot === SHOP && relative === 'web/a.ts';
      },
    });
    expect(evaluateGate(write(`${SHOP}/web/a.ts`), ctx)).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.user-uncommitted-file' });
    const own = { ...state, tasks: [{ ...multi(), plan: { ...multi().plan, scope: ['src/**', 'web/**'] } }] };
    const ownHash = computePlanHash({ taskId: 'JRY-0001', title: 'Add feature', repoRoot: REPO, version: 1, scope: ['src/**', 'web/**'], repositories: multi().plan.repositories });
    own.tasks[0]!.plan.contentHash = ownHash;
    own.approvals = [{ ...own.approvals[0]!, contentHash: ownHash }];
    expect(evaluateGate(write('web/a.ts'), both(own, { isUserChangedFile: ctx.isUserChangedFile! })).verdict).toBe('PASS');
    expect(asked).toEqual([
      ['web/a.ts', SHOP],
      ['web/a.ts', REPO],
    ]);
  });

  it('records a modifying command in a workspace\'s parent folder as a deviation of its open tasks', () => {
    const state = approvedState(multi());
    const ctx = both(state, {
      workspaceFolder: (folder) => (folder.toLowerCase() === 'd:/work' ? { name: 'Shop', repoRoots: [REPO, SHOP] } : null),
      openTasks: (root) => (inEither(root) !== null ? [{ taskId: 'JRY-0001', state: 'IMPLEMENTATION' as const }] : []),
    });
    expect(evaluateGate(shell('npm install', 'Bash', 'D:/Work'), ctx)).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.workspace-folder-command', taskId: 'JRY-0001' });
    expect(evaluateGate(shell('ls', 'Bash', 'D:/Work'), ctx).verdict).toBe('PASS');
    expect(evaluateGate(shell('npm install', 'Bash', 'D:/Other'), ctx)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.outside-repository' });
  });
});

describe('computeReportHash', () => {
  const base = { taskId: 'JRY-0001', version: 1, planVersion: 2, document: { summary: 's', checks: [{ command: 'npm test', result: 'PASS' }] } };

  it('binds an acceptance to the report version, its plan version and its whole content', () => {
    const reordered = { ...base, document: { checks: [{ result: 'PASS', command: 'npm test' }], summary: 's' } };
    expect(computeReportHash(base)).toBe(computeReportHash(reordered));
    expect(computeReportHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const changed of [{ ...base, version: 2 }, { ...base, planVersion: 3 }, { ...base, document: { ...base.document, summary: 'other' } }]) {
      expect(computeReportHash(changed)).not.toBe(computeReportHash(base));
    }
    // Never equal to a plan hash of the same task, even with the same document.
    expect(computeReportHash(base)).not.toBe(computePlanHash({ taskId: 'JRY-0001', title: 's', repoRoot: REPO, version: 1, scope: ['x'], document: base.document }));
  });
});

describe('subagents', () => {
  const spawn = (toolName = 'Task'): GateCheckRequest => ({ sessionId: 's1', cwd: REPO, toolName, toolInput: {}, toolUseId: null, agentId: null });

  it('passes the implementer checks the edit and its agent, and warns on their verdict', () => {
    const state = approvedState(task(['src/**']));
    const seen: Array<[string, string | null, string]> = [];
    const check = (taskId: string, agentId: string | null, file: string) => {
      seen.push([taskId, agentId, file]);
      return file === 'src/b.ts' ? { ruleId: 'monitor.concurrent-write', reason: 'another subagent writes src/b.ts' } : null;
    };
    expect(evaluateGate({ ...write('src/a.ts'), agentId: 'impl-1' }, context(state, { implementerCheck: check }))).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.in-approved-scope' });
    expect(evaluateGate(write('src/b.ts'), context(state, { implementerCheck: check }))).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.concurrent-write', taskId: 'JRY-0001' });
    expect(seen).toEqual([
      ['JRY-0001', 'impl-1', 'src/a.ts'],
      ['JRY-0001', null, 'src/b.ts'],
    ]);
    // Never asked outside the approved scope, and never a block.
    expect(evaluateGate(write('README.md'), context(state, { implementerCheck: () => ({ ruleId: 'monitor.concurrent-write', reason: 'x' }) })).ruleId).toBe('monitor.out-of-scope');
  });

  it('warns when a read-only JERRY agent writes or runs a modifying command', () => {
    const state = approvedState(task(['src/**']));
    const types: Record<string, string> = { rev: 'jerry:jerry-security-reviewer', ana: 'jerry:jerry-risk-analyst', imp: 'jerry:jerry-implementer' };
    const ctx = context(state, { agentType: (agentId) => types[agentId] ?? null });
    expect(evaluateGate({ ...write('src/a.ts'), agentId: 'rev' }, ctx)).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.read-only-agent-write' });
    expect(evaluateGate({ ...shell('npm install left-pad'), agentId: 'ana' }, ctx)).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.read-only-agent-write' });
    expect(evaluateGate({ ...shell('git status'), agentId: 'rev' }, ctx)).toMatchObject({ verdict: 'PASS' });
    expect(evaluateGate({ ...write('src/a.ts'), agentId: 'imp' }, ctx)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.in-approved-scope' });
    // Hard rules still come first.
    expect(evaluateGate({ ...shell('git commit -am x'), agentId: 'rev' }, ctx).verdict).toBe('DENY');
  });

  it('passes an added skill in its states, warns outside them, and ignores skills JERRY does not start', () => {
    const skill = (name: unknown, cwd = REPO): GateCheckRequest => ({ sessionId: 's1', cwd, toolName: 'Skill', toolInput: { skill: name, args: 'x' }, toolUseId: null, agentId: null });
    const states = (name: string) => (name === 'release-notes' ? (['CODE_REVIEW', 'REVERIFICATION'] as const) : name === 'unassigned' ? ([] as const) : null);
    const inReview = context(emptyState(), { skillStates: states, openTasks: () => [{ taskId: 'JRY-0001', state: 'CODE_REVIEW' }] });
    const implementing = context(emptyState(), { skillStates: states, openTasks: () => [{ taskId: 'JRY-0001', state: 'IMPLEMENTATION' }] });

    expect(evaluateGate(skill('release-notes'), inReview)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.skill-in-state', taskId: 'JRY-0001', repoRoot: REPO });
    expect(evaluateGate(skill('/release-notes'), inReview)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.skill-in-state' });
    expect(evaluateGate(skill('release-notes'), implementing)).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.skill-out-of-state', taskId: 'JRY-0001', reason: expect.stringContaining('CODE_REVIEW, REVERIFICATION') });
    expect(evaluateGate(skill('release-notes'), context(emptyState(), { skillStates: states }))).toMatchObject({ verdict: 'WARN', reason: expect.stringContaining('no open task') });
    expect(evaluateGate(skill('unassigned'), inReview)).toMatchObject({ verdict: 'WARN', reason: expect.stringContaining('no task state yet') });
    expect(evaluateGate(skill('pdf'), implementing)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.skill' });
    expect(evaluateGate(skill('jerry:review'), implementing).verdict).toBe('PASS');
    expect(evaluateGate(skill(undefined), implementing)).toMatchObject({ verdict: 'PASS', ruleId: 'tool.not-guarded' });
    expect(evaluateGate(skill('release-notes'), context(emptyState(), { skillStates: states, isMonitored: () => false }))).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.not-a-project' });
    expect(evaluateGate(skill('release-notes', 'C:/Temp'), implementing)).toMatchObject({ verdict: 'PASS', ruleId: 'monitor.outside-repository' });
  });

  it('keeps assigning skills to task states a user-only command', () => {
    expect(evaluateGate(shell('jerry skill states release-notes CODE_REVIEW'), context())).toMatchObject({ verdict: 'DENY', ruleId: 'hard.user-only-command' });
  });

  it('keeps changing workspaces user-only, and reading them open', () => {
    for (const command of ['jerry workspace create shop D:/Work/api', 'jerry workspace add shop D:/Work/admin', 'jerry workspace remove shop D:/Work/admin', 'jerry workspace rename shop sklep', 'jerry workspace delete shop', 'jerry.cmd workspaces create x D:/a']) {
      expect(evaluateGate(shell(command), context()), command).toMatchObject({ verdict: 'DENY', ruleId: 'hard.user-only-command' });
    }
    for (const command of ['jerry workspace list', 'jerry workspace show shop']) expect(evaluateGate(shell(command), context()).verdict, command).not.toBe('DENY');
  });

  it('warns before a fourth concurrent subagent, and never blocks one', () => {
    expect(evaluateGate(spawn(), context(emptyState(), { activeSubagents: () => 2 }))).toMatchObject({ verdict: 'PASS' });
    expect(evaluateGate(spawn('Agent'), context(emptyState(), { activeSubagents: () => 3 }))).toMatchObject({ verdict: 'WARN', ruleId: 'monitor.subagent-cap', reason: expect.stringContaining('at most 3') });
    expect(evaluateGate(spawn(), context(emptyState()))).toMatchObject({ verdict: 'PASS' });
    expect(evaluateGate(spawn('Read'), context(emptyState(), { activeSubagents: () => 9 })).verdict).toBe('PASS');
  });
});

describe('other tools', () => {
  it('does not monitor read tools', () => {
    const request: GateCheckRequest = { sessionId: 's', cwd: REPO, toolName: 'Read', toolInput: { file_path: 'a' }, toolUseId: null, agentId: null };
    expect(evaluateGate(request, context()).verdict).toBe('PASS');
  });
});
