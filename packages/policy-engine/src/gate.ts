import type { GateCheckRequest, GateDecision, WorkflowState } from '@jerry/contracts';
import type { ApprovedPlan } from './approvals.js';
import { absolutePath, comparablePath, isComparableInside, matchesAnyGlob, relativeInside } from './paths.js';
import { assessMcpGitUsage } from './mcp.js';
import { assessGitUsage, assessShellCommand } from './shell.js';
import { classifyToolCall, type ToolAction } from './tool-call.js';
import { MAX_SUBAGENTS } from '@jerry/contracts/agents';

/**
 * Gate policy: JERRY monitors Claude Code and blocks only hard rules.
 *
 * Hard rules (DENY, evaluated first, need no Core and no state):
 *   - any command or Git-server MCP tool that changes Git state; only the user runs Git operations
 *   - any write into a .git directory
 *   - any write to, or command touching, JERRY data or Claude Code guard configuration
 *   - an agent running JERRY's user-only commands (approve, reject, project add, data prune, ...) or its API
 * Everything else is monitoring, only inside projects the user added: PASS, or WARN when Claude acts
 * outside an approved plan.
 */

/** Side-effecting lookups are injected so the policy itself stays pure and testable. */
export interface GateContext {
  platform: NodeJS.Platform;
  /** Absolute paths that agents must never write to (JERRY_HOME, Claude settings/plugins). */
  protectedRoots: readonly string[];
  /** Resolves symlinks/junctions of the nearest existing ancestor; returns an absolute path. */
  realPath(absolutePath: string): string;
  /** Git working tree root containing the path, or null when it is not inside a repository. */
  findRepoRoot(absolutePath: string): string | null;
  approvedPlans(repoRoot: string): readonly ApprovedPlan[];
  /**
   * True when the repository lies in a project the user added to JERRY. Elsewhere only the hard
   * rules apply: nothing is checked against plans.
   */
  isMonitored(repoRoot: string): boolean;
  /**
   * True when the file had the user's uncommitted changes when the task's plan was approved and
   * Claude was not warned about it yet. Absent where Git baselines are not known.
   */
  isUserChangedFile?(taskId: string, relativePath: string, repoRoot?: string): boolean;
  /** Subagents the session started and has not finished; absent where unknown. */
  activeSubagents?(sessionId: string): number;
  /**
   * Implementer checks of an in-scope edit: concurrent writes to one file, and an
   * implementer outside its assignment. `agentId` is null for the main session. Warnings only.
   */
  implementerCheck?(taskId: string, agentId: string | null, relativePath: string, repoRoot?: string): { ruleId: string; reason: string } | null;
  /** The plugin agent type of a subagent (e.g. "jerry:jerry-security-reviewer"), when known. */
  agentType?(agentId: string): string | null;
  /**
   * The task states JERRY starts an added skill in (empty: none assigned), or null when JERRY does
   * not start that skill (not added through JERRY, switched off or not converted). Absent where unknown.
   */
  skillStates?(name: string): readonly WorkflowState[] | null;
  /** The repository's open tasks and their states. Absent where unknown. */
  openTasks?(repoRoot: string): ReadonlyArray<{ taskId: string; state: WorkflowState }>;
  /**
   * The workspace whose parent folder this is (a folder holding its repositories, not one of
   * them), or null. Absent where unknown.
   */
  workspaceFolder?(absolutePath: string): { name: string; repoRoots: readonly string[] } | null;
}

/** JERRY's read-only roles: analysts and reviewers never write. */
const READ_ONLY_AGENT = /jerry-[\w-]*-(?:analyst|reviewer)$/;

/**
 * Commands only the user may run. Read-only ones (status, doctor, task list/show, project list, data
 * usage, core status, settings, statusline status, usage status) stay available. Pausing, resuming,
 * cancelling a task and re-running its final checks are user decisions, and so are adding or removing a project, deleting JERRY's data,
 * changing a setting and turning JERRY's status line or usage collection on or off (they edit the
 * Claude Code settings).
 */
const USER_ONLY_JERRY_COMMAND = /\bjerry(?:\.mjs|\.cmd|\.ps1)?\s+(?:approve|reject|install|uninstall|ui|repo\s+(?:exclude|include)|project\s+(?:add|remove)|data\s+(?:prune|forget)|task\s+(?:pause|resume|cancel|recheck)|core\s+(?:start|stop)|db\s+restore|settings\s+set|statusline\s+(?:enable|disable)|usage\s+(?:enable|disable)|skills?\s+(?:add|enable|disable|update|remove|states)|workspaces?\s+(?:create|add|remove|rename|delete))\b/i;
/** Tools that start a Claude Code subagent. */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);
/** The Core API and the dashboard login: an agent holding a session could approve its own plan. */
const CORE_API_PATTERN = /\/api\/v1\/|\/ui\/(?:login|logout)\b/i;
/**
 * Catches %LOCALAPPDATA%\JERRY, $env:LOCALAPPDATA\JERRY and references to the JERRY_HOME variable
 * ($JERRY_HOME, ${JERRY_HOME}, %JERRY_HOME%, $env:JERRY_HOME), which never contain the literal path.
 * The bare identifier is not matched: source code that mentions JERRY_HOME is not JERRY data.
 */
const JERRY_HOME_VARIABLE_PATTERN = /localappdata[%)]?[\\/]+jerry\b|(?:\$env:|\$\{?|%)jerry_home\b/i;

export function evaluateGate(request: GateCheckRequest, context: GateContext): GateDecision {
  const action = classifyToolCall(request.toolName, request.toolInput);
  return evaluateHardRules(action, request.cwd, context) ?? evaluateMonitoring(action, request, context);
}

/** Hard rules only. The bridge runs this locally before contacting Core, so it holds while Core is down. */
export function evaluateHardRules(action: ToolAction, cwd: string, context: Pick<GateContext, 'platform' | 'protectedRoots' | 'realPath'>): GateDecision | null {
  switch (action.kind) {
    case 'file-write':
      for (const target of action.paths) {
        const verdict = hardRulesForWrite(target, cwd, context);
        if (verdict !== null) return verdict;
      }
      return null;
    case 'shell':
    case 'shell-opaque':
      return hardRulesForShell(action.command, action.kind === 'shell' ? action.dialect : 'bash', cwd, context);
    case 'mcp': {
      const git = assessMcpGitUsage(action);
      return git.mutating
        ? decision('DENY', 'hard.git-mutation', `Only the user changes Git state (${git.reason}). Read-only tools of this server are fine.`)
        : null;
    }
    case 'file-write-unknown':
    case 'skill':
    case 'not-guarded':
      return null;
  }
}

function hardRulesForWrite(target: string, cwd: string, context: Pick<GateContext, 'platform' | 'protectedRoots' | 'realPath'>): GateDecision | null {
  const { platform } = context;
  const requested = absolutePath(target, cwd, platform);
  const real = absolutePath(context.realPath(requested), cwd, platform);
  for (const candidate of new Set([requested, real])) {
    const key = comparablePath(candidate, cwd, platform);
    const hit = context.protectedRoots.find((root) => isComparableInside(key, comparablePath(root, cwd, platform)));
    if (hit !== undefined) {
      return decision('DENY', 'hard.protected-path', `${requested} is inside a JERRY-protected location (${hit}). Agents may not modify JERRY data or the Claude Code configuration that keeps JERRY enabled.`);
    }
    if (/(^|\/)\.git(\/|$)/i.test(candidate)) {
      return decision('DENY', 'hard.git-metadata', `${requested} is Git metadata. Only the user changes Git state; do not write inside .git.`);
    }
  }
  return null;
}

function hardRulesForShell(command: string, dialect: 'bash' | 'powershell', cwd: string, context: Pick<GateContext, 'platform' | 'protectedRoots'>): GateDecision | null {
  const { platform } = context;
  if (USER_ONLY_JERRY_COMMAND.test(command)) {
    return decision('DENY', 'hard.user-only-command', 'Approvals, repository exclusions and JERRY lifecycle commands are user actions; agents may not run them.');
  }
  if (CORE_API_PATTERN.test(command)) {
    return decision('DENY', 'hard.core-api', 'Agents may not call the JERRY Core API directly.');
  }
  if (JERRY_HOME_VARIABLE_PATTERN.test(command)) {
    return decision('DENY', 'hard.protected-path', 'The command references the JERRY data directory.');
  }
  const commandKey = platform === 'win32' ? command.replaceAll('\\', '/').toLowerCase() : command;
  const cwdKey = comparablePath(cwd, cwd, platform);
  for (const root of context.protectedRoots) {
    const rootKey = comparablePath(root, cwd, platform);
    if (commandKey.includes(rootKey) || isComparableInside(cwdKey, rootKey)) {
      return decision('DENY', 'hard.protected-path', `The command touches a JERRY-protected location (${root}).`);
    }
  }
  const git = assessGitUsage(command, dialect);
  if (git.mutating) {
    return decision('DENY', 'hard.git-mutation', `Only the user runs Git operations that change anything (${git.reason}). Read-only Git (status, diff, log, show) is fine. Leave commits, pushes, merges, checkouts, resets, stashes and similar to the user.`);
  }
  return null;
}

function evaluateMonitoring(action: ToolAction, request: GateCheckRequest, context: GateContext): GateDecision {
  // A read-only JERRY agent that writes or runs a modifying command: warned, not blocked;
  // blocking would be a new hard rule, and hard rules change only by the maintainer's explicit decision.
  if (request.agentId !== null && request.agentId !== undefined) {
    const type = context.agentType?.(request.agentId) ?? null;
    const writes = action.kind === 'file-write' || action.kind === 'file-write-unknown' || action.kind === 'shell-opaque' || (action.kind === 'shell' && !assessShellCommand(action.command, action.dialect).readOnly);
    if (writes && type !== null && READ_ONLY_AGENT.test(type)) {
      return decision('WARN', 'monitor.read-only-agent-write', `${type} is a read-only JERRY agent, but ${request.toolName} may change files. It proceeds and is recorded; a review or analysis must not change the code it judges.`);
    }
  }
  switch (action.kind) {
    case 'not-guarded': {
      // At most three subagents at a time. A fourth is warned about, not blocked.
      if (SUBAGENT_TOOLS.has(request.toolName)) {
        const active = context.activeSubagents?.(request.sessionId) ?? 0;
        if (active >= MAX_SUBAGENTS) {
          return decision('WARN', 'monitor.subagent-cap', `${active} subagents are already running in this session; JERRY works with at most ${MAX_SUBAGENTS} at a time. Wait for one to finish instead of starting another.`);
        }
      }
      return decision('PASS', 'tool.not-guarded', `${request.toolName} is not a write or shell tool`);
    }
    case 'mcp':
      return decision('PASS', 'monitor.mcp-tool', `${action.server}/${action.tool} does not change Git state`);
    case 'skill':
      return monitorSkill(action.name, request.cwd, context);
    case 'file-write-unknown':
      return decision('WARN', 'monitor.unknown-target', `${action.detail}; JERRY could not check it against the approved plan.`);
    case 'file-write':
      return worstOf(action.paths.map((target) => monitorWrite(target, request.cwd, context, request.agentId ?? null)));
    case 'shell':
      return monitorShell(request.cwd, context, assessShellCommand(action.command, action.dialect));
    case 'shell-opaque':
      return monitorShell(request.cwd, context, { readOnly: false, reason: `${request.toolName} runs commands JERRY does not classify` });
  }
}

/**
 * Added skills are started only by JERRY, in the task states the user assigned them to. A call to
 * one while no open task of the repository is in those states is warned about and recorded as a
 * deviation, never blocked: blocking would be a new hard rule.
 */
function monitorSkill(name: string | null, cwd: string, context: GateContext): GateDecision {
  if (name === null) return decision('PASS', 'tool.not-guarded', 'Skill call without a skill name');
  const states = context.skillStates?.(name) ?? null;
  if (states === null) return decision('PASS', 'monitor.skill', `${name} is not a skill JERRY starts`);
  const repoRoot = context.findRepoRoot(absolutePath(context.realPath(absolutePath(cwd, cwd, context.platform)), cwd, context.platform));
  if (repoRoot === null) return decision('PASS', 'monitor.outside-repository', `Working directory is not inside a Git repository (skill ${name})`);
  if (!context.isMonitored(repoRoot)) return decision('PASS', 'monitor.not-a-project', `${repoRoot} is not added to JERRY; only hard rules apply there`, null, repoRoot);
  const open = context.openTasks?.(repoRoot) ?? [];
  const match = open.find((task) => states.includes(task.state));
  if (match !== undefined) return decision('PASS', 'monitor.skill-in-state', `JERRY starts ${name} in ${states.join(', ')}; ${match.taskId} is in ${match.state}`, match.taskId, repoRoot);
  const assigned = states.length === 0 ? 'no task state yet (the user assigns them on its page in the JERRY dashboard)' : states.join(', ');
  const now = open.length === 0 ? 'there is no open task here' : `the open tasks here are in ${[...new Set(open.map((task) => task.state))].join(', ')}`;
  return decision('WARN', 'monitor.skill-out-of-state', `${name} is a skill JERRY starts only while a task is in ${assigned}, and ${now}. It proceeds and is recorded as a deviation; use it only when JERRY's next action names it.`, open[0]?.taskId ?? null, repoRoot);
}

function monitorWrite(target: string, cwd: string, context: GateContext, agentId: string | null = null): GateDecision {
  const { platform } = context;
  const requested = absolutePath(target, cwd, platform);
  const real = absolutePath(context.realPath(requested), cwd, platform);
  const repoRoot = context.findRepoRoot(real);
  if (repoRoot === null) {
    return decision('PASS', 'monitor.outside-repository', `${requested} is not inside a Git repository`);
  }
  if (!context.isMonitored(repoRoot)) {
    return decision('PASS', 'monitor.not-a-project', `${repoRoot} is not added to JERRY; only hard rules apply there`, null, repoRoot);
  }
  const relative = relativeInside(real, repoRoot, platform) ?? requested;
  const plans = context.approvedPlans(repoRoot);
  if (plans.length === 0) {
    return decision('WARN', 'monitor.no-approved-plan', `No approved JERRY plan covers ${relative} in ${repoRoot}. The edit proceeds and is recorded as a deviation.`, null, repoRoot);
  }
  const covering = plans.find((plan) => matchesAnyGlob(relative, plan.scope, platform === 'win32'));
  if (covering === undefined) {
    const ids = plans.map((plan) => `${plan.taskId} v${plan.planVersion}`).join(', ');
    return decision('WARN', 'monitor.out-of-scope', `${relative} is outside the approved scope of ${ids}. The edit proceeds and is recorded as a deviation.`, plans[0]?.taskId ?? null, repoRoot);
  }
  if (context.isUserChangedFile?.(covering.taskId, relative, repoRoot) === true) {
    return decision(
      'WARN',
      'monitor.user-uncommitted-file',
      `${relative} had the user's uncommitted changes when ${covering.taskId} v${covering.planVersion} was approved. The edit proceeds; keep the user's changes (they are not in Git).`,
      covering.taskId,
      repoRoot,
    );
  }
  const implementer = context.implementerCheck?.(covering.taskId, agentId, relative, repoRoot) ?? null;
  if (implementer !== null) return decision('WARN', implementer.ruleId, implementer.reason, covering.taskId, repoRoot);
  return decision('PASS', 'monitor.in-approved-scope', `${relative} is within the approved scope of ${covering.taskId} v${covering.planVersion}`, covering.taskId, repoRoot);
}

function monitorShell(cwd: string, context: GateContext, assessment: { readOnly: boolean; reason: string }): GateDecision {
  const { platform } = context;
  if (assessment.readOnly) {
    return decision('PASS', 'monitor.read-only-command', `Read-only command: ${assessment.reason}`);
  }
  const folder = absolutePath(context.realPath(absolutePath(cwd, cwd, platform)), cwd, platform);
  const repoRoot = context.findRepoRoot(folder);
  if (repoRoot === null) {
    const workspace = context.workspaceFolder?.(folder) ?? null;
    if (workspace !== null) return monitorWorkspaceShell(workspace, context, assessment);
    return decision('PASS', 'monitor.outside-repository', `Working directory is not inside a Git repository (${assessment.reason})`);
  }
  if (!context.isMonitored(repoRoot)) {
    return decision('PASS', 'monitor.not-a-project', `${repoRoot} is not added to JERRY; only hard rules apply there`, null, repoRoot);
  }
  const plans = context.approvedPlans(repoRoot);
  if (plans.length === 0) {
    return decision('WARN', 'monitor.no-approved-plan', `No approved JERRY plan for ${repoRoot}, and this command may modify files (${assessment.reason}). It proceeds and is recorded as a deviation.`, null, repoRoot);
  }
  return decision('PASS', 'monitor.command-with-approved-plan', `Approved plan exists; JERRY cannot verify the command's file scope (${assessment.reason})`, plans[0]?.taskId ?? null, repoRoot);
}

/**
 * A command that may modify files, run in a workspace's parent folder: JERRY cannot tell which of
 * its repositories it changes, so it is recorded as a deviation of the workspace's open tasks (the
 * first one carries it) and Claude is told to run it inside the repository.
 */
function monitorWorkspaceShell(workspace: { name: string; repoRoots: readonly string[] }, context: GateContext, assessment: { readOnly: boolean; reason: string }): GateDecision {
  const open = workspace.repoRoots.flatMap((root) => context.openTasks?.(root) ?? []);
  const taskIds = [...new Set(open.map((task) => task.taskId))];
  const owner = taskIds.length === 0 ? '' : ` It is recorded as a deviation of ${taskIds.join(', ')}.`;
  return decision(
    'WARN',
    'monitor.workspace-folder-command',
    `This command runs in the parent folder of the workspace ${workspace.name}, outside its repositories, and may modify files (${assessment.reason}). JERRY cannot tell which repository it changes; run it inside the repository instead.${owner}`,
    taskIds[0] ?? null,
    null,
  );
}

const VERDICT_RANK: Readonly<Record<GateDecision['verdict'], number>> = { PASS: 0, WARN: 1, DENY: 2 };

function worstOf(decisions: readonly GateDecision[]): GateDecision {
  return decisions.reduce<GateDecision | null>((worst, current) => (worst === null || VERDICT_RANK[current.verdict] > VERDICT_RANK[worst.verdict] ? current : worst), null)
    ?? decision('WARN', 'monitor.unknown-target', 'write without target paths');
}

function decision(verdict: GateDecision['verdict'], ruleId: string, reason: string, taskId: string | null = null, repoRoot: string | null = null): GateDecision {
  return { verdict, ruleId, reason, taskId, repoRoot };
}
