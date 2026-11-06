import type { GateCheckRequest, GateDecision } from '@jerry/contracts';
import type { ApprovedPlan } from './approvals.js';
import { absolutePath, comparablePath, isComparableInside, matchesAnyGlob, relativeInside } from './paths.js';
import { assessShellCommand } from './shell.js';
import { classifyToolCall } from './tool-call.js';

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
}

const SELF_APPROVAL_PATTERN = /\bjerry(?:\.mjs|\.cmd|\.ps1)?\s+(?:approve|reject)\b/i;
const CORE_API_PATTERN = /\/api\/v1\//i;
/** Catches %LOCALAPPDATA%\JERRY and $env:LOCALAPPDATA\JERRY, which never contain the literal path. */
const JERRY_HOME_VARIABLE_PATTERN = /localappdata[%)]?[\\/]+jerry\b|jerry_home/i;

export function evaluateGate(request: GateCheckRequest, context: GateContext): GateDecision {
  const action = classifyToolCall(request.toolName, request.toolInput);
  switch (action.kind) {
    case 'not-guarded':
      return decision('PASS', 'tool.not-guarded', `${request.toolName} is not a write or shell tool`);
    case 'file-write-unknown':
      return decision('DENY', 'write.unknown-target', `${action.detail}; JERRY cannot verify the target, so the write is blocked`);
    case 'file-write':
      return evaluateFileWrites(action.paths, request.cwd, context);
    case 'shell':
      return evaluateShell(action.command, request.cwd, context, assessShellCommand(action.command, action.dialect));
    case 'shell-opaque':
      return evaluateShell(action.command, request.cwd, context, { readOnly: false, reason: `${request.toolName} runs commands JERRY does not classify` });
  }
}

function evaluateFileWrites(paths: readonly string[], cwd: string, context: GateContext): GateDecision {
  let lastPass: GateDecision | null = null;
  for (const target of paths) {
    const result = evaluateFileWrite(target, cwd, context);
    if (result.verdict !== 'PASS') return result;
    lastPass = result;
  }
  return lastPass ?? decision('DENY', 'write.unknown-target', 'write without target paths');
}

function evaluateFileWrite(target: string, cwd: string, context: GateContext): GateDecision {
  const { platform } = context;
  const requested = absolutePath(target, cwd, platform);
  const real = absolutePath(context.realPath(requested), cwd, platform);

  for (const candidate of new Set([requested, real])) {
    const key = comparablePath(candidate, cwd, platform);
    const hit = context.protectedRoots.find((root) => isComparableInside(key, comparablePath(root, cwd, platform)));
    if (hit !== undefined) {
      return decision('DENY', 'write.protected-path', `${requested} is inside a JERRY-protected location (${hit}); agents may not modify JERRY or Claude Code guard configuration`);
    }
  }

  const repoRoot = context.findRepoRoot(real);
  if (repoRoot === null) {
    return decision('PASS', 'write.outside-repository', `${requested} is not inside a Git repository governed by JERRY`);
  }

  const relative = relativeInside(real, repoRoot, platform);
  if (relative === null) {
    return decision('DENY', 'write.unknown-target', `${requested} could not be related to repository ${repoRoot}`, null, repoRoot);
  }
  const caseInsensitive = platform === 'win32';
  if (relative === '.git' || /^\.git\//i.test(relative)) {
    return decision('DENY', 'write.git-metadata', `${requested} is Git metadata; JERRY never lets agents modify .git`, null, repoRoot);
  }

  const plans = context.approvedPlans(repoRoot);
  if (plans.length === 0) {
    return decision('DENY', 'write.no-approved-plan', `No approved JERRY plan for repository ${repoRoot}. Prepare a plan and wait for the user to approve it in JERRY before editing files.`, null, repoRoot);
  }
  const covering = plans.find((plan) => matchesAnyGlob(relative, plan.scope, caseInsensitive));
  if (covering === undefined) {
    const ids = plans.map((plan) => `${plan.taskId} v${plan.planVersion}`).join(', ');
    return decision('DENY', 'write.out-of-scope', `${relative} is outside the approved scope of ${ids}. A scope change needs a new plan version and a new approval.`, plans[0]?.taskId ?? null, repoRoot);
  }
  return decision('PASS', 'write.in-approved-scope', `${relative} is within the approved scope of ${covering.taskId} v${covering.planVersion}`, covering.taskId, repoRoot);
}

function evaluateShell(command: string, cwd: string, context: GateContext, assessment: { readOnly: boolean; reason: string }): GateDecision {
  const { platform } = context;
  if (SELF_APPROVAL_PATTERN.test(command)) {
    return decision('DENY', 'shell.self-approval', 'Approvals are a user action in the JERRY dashboard or an interactive terminal; agents may not run jerry approve/reject');
  }
  if (CORE_API_PATTERN.test(command)) {
    return decision('DENY', 'shell.core-api', 'Agents may not call the JERRY Core API directly');
  }
  if (JERRY_HOME_VARIABLE_PATTERN.test(command)) {
    return decision('DENY', 'shell.protected-path', 'The command references the JERRY data directory');
  }
  const commandKey = platform === 'win32' ? command.replaceAll('\\', '/').toLowerCase() : command;
  const cwdKey = comparablePath(cwd, cwd, platform);
  for (const root of context.protectedRoots) {
    const rootKey = comparablePath(root, cwd, platform);
    if (commandKey.includes(rootKey) || isComparableInside(cwdKey, rootKey)) {
      return decision('DENY', 'shell.protected-path', `The command touches a JERRY-protected location (${root})`);
    }
  }

  if (assessment.readOnly) {
    return decision('PASS', 'shell.read-only', `Read-only command: ${assessment.reason}`);
  }

  const repoRoot = context.findRepoRoot(absolutePath(context.realPath(absolutePath(cwd, cwd, platform)), cwd, platform));
  if (repoRoot === null) {
    // Known M0 gap: a write-capable command run outside any repository can still
    // target a repository (e.g. "cd D:/repo && ..."). Hooks are not an OS sandbox.
    return decision('PASS', 'shell.outside-repository', `Working directory is not inside a Git repository (${assessment.reason})`);
  }
  if (context.approvedPlans(repoRoot).length === 0) {
    return decision('DENY', 'shell.no-approved-plan', `No approved JERRY plan for repository ${repoRoot}, and this command may modify files (${assessment.reason}).`, null, repoRoot);
  }
  return decision('ASK', 'shell.write-capable-needs-confirmation', `JERRY cannot verify that this command stays within the approved scope (${assessment.reason}). Confirm it manually.`, null, repoRoot);
}

function decision(verdict: GateDecision['verdict'], ruleId: string, reason: string, taskId: string | null = null, repoRoot: string | null = null): GateDecision {
  return { verdict, ruleId, reason, taskId, repoRoot };
}
