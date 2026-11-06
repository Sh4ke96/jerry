import type { GateCheckRequest, GateDecision } from '@jerry/contracts';
import type { ApprovedPlan } from './approvals.js';
import { absolutePath, comparablePath, isComparableInside, matchesAnyGlob, relativeInside } from './paths.js';
import { assessGitUsage, assessShellCommand } from './shell.js';
import { classifyToolCall, type ToolAction } from './tool-call.js';

/**
 * Gate policy (ADR 0003): JERRY monitors Claude Code and blocks only hard rules.
 *
 * Hard rules (DENY, evaluated first, need no Core and no state):
 *   - any command that changes Git state; only the user runs Git operations
 *   - any write into a .git directory
 *   - any write to, or command touching, JERRY data or Claude Code guard configuration
 *   - an agent running JERRY's user-only commands (approve, reject, repo exclude, ...) or its API
 * Everything else is monitoring: PASS, or WARN when Claude acts outside an approved plan.
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
  /** True when the user excluded the repository from monitoring (hard rules still apply). */
  isExcluded(repoRoot: string): boolean;
}

const USER_ONLY_JERRY_COMMAND = /\bjerry(?:\.mjs|\.cmd|\.ps1)?\s+(?:approve|reject|repo|install|uninstall|core)\b/i;
const CORE_API_PATTERN = /\/api\/v1\//i;
/** Catches %LOCALAPPDATA%\JERRY and $env:LOCALAPPDATA\JERRY, which never contain the literal path. */
const JERRY_HOME_VARIABLE_PATTERN = /localappdata[%)]?[\\/]+jerry\b|jerry_home/i;

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
    case 'file-write-unknown':
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
  switch (action.kind) {
    case 'not-guarded':
      return decision('PASS', 'tool.not-guarded', `${request.toolName} is not a write or shell tool`);
    case 'file-write-unknown':
      return decision('WARN', 'monitor.unknown-target', `${action.detail}; JERRY could not check it against the approved plan.`);
    case 'file-write':
      return worstOf(action.paths.map((target) => monitorWrite(target, request.cwd, context)));
    case 'shell':
      return monitorShell(request.cwd, context, assessShellCommand(action.command, action.dialect));
    case 'shell-opaque':
      return monitorShell(request.cwd, context, { readOnly: false, reason: `${request.toolName} runs commands JERRY does not classify` });
  }
}

function monitorWrite(target: string, cwd: string, context: GateContext): GateDecision {
  const { platform } = context;
  const requested = absolutePath(target, cwd, platform);
  const real = absolutePath(context.realPath(requested), cwd, platform);
  const repoRoot = context.findRepoRoot(real);
  if (repoRoot === null) {
    return decision('PASS', 'monitor.outside-repository', `${requested} is not inside a Git repository`);
  }
  if (context.isExcluded(repoRoot)) {
    return decision('PASS', 'monitor.repo-excluded', `${repoRoot} is excluded from JERRY monitoring by the user`, null, repoRoot);
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
  return decision('PASS', 'monitor.in-approved-scope', `${relative} is within the approved scope of ${covering.taskId} v${covering.planVersion}`, covering.taskId, repoRoot);
}

function monitorShell(cwd: string, context: GateContext, assessment: { readOnly: boolean; reason: string }): GateDecision {
  const { platform } = context;
  if (assessment.readOnly) {
    return decision('PASS', 'monitor.read-only-command', `Read-only command: ${assessment.reason}`);
  }
  const repoRoot = context.findRepoRoot(absolutePath(context.realPath(absolutePath(cwd, cwd, platform)), cwd, platform));
  if (repoRoot === null) {
    return decision('PASS', 'monitor.outside-repository', `Working directory is not inside a Git repository (${assessment.reason})`);
  }
  if (context.isExcluded(repoRoot)) {
    return decision('PASS', 'monitor.repo-excluded', `${repoRoot} is excluded from JERRY monitoring by the user`, null, repoRoot);
  }
  const plans = context.approvedPlans(repoRoot);
  if (plans.length === 0) {
    return decision('WARN', 'monitor.no-approved-plan', `No approved JERRY plan for ${repoRoot}, and this command may modify files (${assessment.reason}). It proceeds and is recorded as a deviation.`, null, repoRoot);
  }
  return decision('PASS', 'monitor.command-with-approved-plan', `Approved plan exists; JERRY cannot verify the command's file scope (${assessment.reason})`, plans[0]?.taskId ?? null, repoRoot);
}

const VERDICT_RANK: Readonly<Record<GateDecision['verdict'], number>> = { PASS: 0, WARN: 1, DENY: 2 };

function worstOf(decisions: readonly GateDecision[]): GateDecision {
  return decisions.reduce<GateDecision | null>((worst, current) => (worst === null || VERDICT_RANK[current.verdict] > VERDICT_RANK[worst.verdict] ? current : worst), null)
    ?? decision('WARN', 'monitor.unknown-target', 'write without target paths');
}

function decision(verdict: GateDecision['verdict'], ruleId: string, reason: string, taskId: string | null = null, repoRoot: string | null = null): GateDecision {
  return { verdict, ruleId, reason, taskId, repoRoot };
}
