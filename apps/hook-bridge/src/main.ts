import fs from 'node:fs';
import {
  gateDecisionSchema,
  preToolUseInputSchema,
  sessionRegistrationResponseSchema,
  sessionStartInputSchema,
  type GateCheckRequest,
  type GateDecision,
  type SessionRegistrationResponse,
} from '@jerry/contracts';
import { protectedRoots, readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { classifyToolCall, evaluateHardRules } from '@jerry/policy-engine';

/**
 * Claude Code command-hook adapter (ADR 0003: JERRY monitors, and blocks only hard rules).
 *
 * PreToolUse flow:
 *   1. Parse stdin and evaluate the hard rules locally (Git state changes, .git, JERRY data).
 *      These need no Core, so they hold while Core is down. If the input cannot be parsed,
 *      the hard rules cannot be checked and the call is blocked.
 *   2. Ask Core for the monitoring verdict (recorded in the gate log).
 *      Once the hard rules passed, any Core problem lets the call proceed: an outage costs
 *      monitoring, never Claude's ability to work.
 *
 * Output protocol:
 *   exit 2 + reason on stderr                       -> blocked (hard rule)
 *   exit 0 + JSON systemMessage/additionalContext   -> proceeds, user and Claude are warned
 *   exit 0, no output                               -> proceeds; Claude Code permissions decide
 */

const CORE_TIMEOUT_MS = 1500;
const WATCHDOG_MS = 8000;
const MAX_STDIN_BYTES = 64 * 1024 * 1024;
/** Only these tool_input fields are forwarded to Core: never file contents or edit payloads. */
const FORWARDED_TOOL_INPUT_FIELDS = ['file_path', 'notebook_path', 'command'] as const;

type BridgeEvent = 'pre-tool-use' | 'session-start';

/** Set once the hard rules passed; from then on every failure lets the tool call proceed. */
let hardRulesCleared = false;

/** Synchronous fd writes: process.stdout/stderr can be asynchronous pipes on Windows and lose data on exit. */
function writeOut(text: string): void {
  fs.writeSync(1, text);
}

function block(reason: string): never {
  fs.writeSync(2, `JERRY: ${reason}\n`);
  process.exit(2);
}

function proceed(): never {
  process.exit(0);
}

/** Called on unexpected failures: block only while the hard rules have not been verified. */
function onFailure(reason: string): never {
  if (process.argv[2] === 'session-start' || hardRulesCleared) proceed();
  block(`${reason}; the hard rules could not be checked, so the call is blocked`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`hook input larger than ${MAX_STDIN_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function preToolUse(raw: string): Promise<void> {
  const parsed = preToolUseInputSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) onFailure(`unrecognised PreToolUse input (${parsed.error.issues[0]?.message ?? 'invalid'})`);
  const input = parsed.data;

  const forwardedInput: Record<string, unknown> = {};
  for (const field of FORWARDED_TOOL_INPUT_FIELDS) {
    if (field in input.tool_input) forwardedInput[field] = input.tool_input[field];
  }
  const request: GateCheckRequest = {
    sessionId: input.session_id,
    cwd: input.cwd,
    toolName: input.tool_name,
    toolInput: forwardedInput,
    toolUseId: input.tool_use_id ?? null,
    agentId: input.agent_id ?? null,
  };

  const hardRule = evaluateHardRules(classifyToolCall(request.toolName, request.toolInput), request.cwd, {
    platform: process.platform,
    protectedRoots: protectedRoots(),
    realPath: (target) => target,
  });
  if (hardRule !== null) {
    // Best effort: record the blocked attempt in Core's gate log; never wait long for it.
    await askCore(request).catch(() => null);
    block(`${hardRule.reason} [${hardRule.ruleId}]`);
  }
  hardRulesCleared = true;

  const decision = await askCore(request).catch(() => null);
  if (decision === null) proceed(); // Core unavailable: monitoring is off, work continues.
  emit(decision);
}

async function askCore(request: GateCheckRequest): Promise<GateDecision> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const body = await requestCore(info, { method: 'POST', path: '/api/v1/gate/check', body: request, timeoutMs: CORE_TIMEOUT_MS });
  return gateDecisionSchema.parse(body);
}

function emit(decision: GateDecision): never {
  switch (decision.verdict) {
    case 'DENY':
      // Core also enforces hard rules, e.g. a .git write reached through a link that only
      // Core can resolve on disk.
      block(`${decision.reason} [${decision.ruleId}]`);
      break;
    case 'WARN':
      writeOut(
        JSON.stringify({
          systemMessage: `JERRY: ${decision.reason} [${decision.ruleId}]`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `JERRY warning: ${decision.reason} [${decision.ruleId}] Mention this deviation to the user in your summary; JERRY does not block it.`,
          },
        }),
      );
      proceed();
      break;
    case 'PASS':
      proceed();
  }
}

const HARD_RULES_TEXT =
  'Hard rules, always enforced: you may not run any Git command that changes anything (commit, push, merge, rebase, checkout, switch, reset, restore, stash, fetch, pull, tag, branch changes, config changes, gh/npm version and similar), and you may not use MCP tools of Git servers that push, commit, create branches or files, or open or merge pull requests; the user does all Git operations manually. Read-only Git (status, diff, log, show, blame) is fine. You may not write inside .git, modify JERRY data or the Claude Code settings that enable JERRY, run "jerry approve/reject/install/uninstall", "jerry repo exclude/include" or "jerry core start/stop", or call the JERRY API.';

/**
 * Tells the model what is actually approved right now. A generic message made models refuse
 * even in-scope edits of an already approved plan (M0 live finding).
 */
function monitoredSessionContext(registration: SessionRegistrationResponse): string {
  const lines = ['JERRY: monitoring this session. JERRY does not block your edits; it records deviations from the user-approved plan and warns you about them.'];
  if (registration.repoRoot === null) {
    lines.push('The working directory is not inside a Git repository.');
  } else if (registration.excluded) {
    lines.push(`The user excluded ${registration.repoRoot} from JERRY monitoring.`);
  } else if (registration.approvedPlans.length === 0) {
    lines.push(`There is no approved JERRY plan for ${registration.repoRoot}; edits there will be recorded as deviations.`);
  } else {
    const plans = registration.approvedPlans.map((plan) => `${plan.taskId} v${plan.planVersion} (scope: ${plan.scope.join(', ')})`).join('; ');
    lines.push(`Approved JERRY plan(s) for ${registration.repoRoot}: ${plans}. Edits outside that scope are recorded as deviations.`);
  }
  lines.push(HARD_RULES_TEXT, 'If JERRY blocks an action, report the reason to the user instead of working around it.');
  return lines.join(' ');
}

async function sessionStart(raw: string): Promise<void> {
  let context: string;
  try {
    const input = sessionStartInputSchema.parse(JSON.parse(raw));
    const info = readCoreRuntimeInfo(resolveJerryHome());
    const registration = sessionRegistrationResponseSchema.parse(
      await requestCore(info, {
        method: 'POST',
        path: '/api/v1/sessions',
        body: { sessionId: input.session_id, cwd: input.cwd, source: input.source ?? null },
        timeoutMs: CORE_TIMEOUT_MS,
      }),
    );
    context = monitoredSessionContext(registration);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    context = `JERRY: Core unavailable (${cause}); monitoring is off and actions are not recorded until the user runs "jerry core start". ${HARD_RULES_TEXT}`;
  }
  writeOut(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  proceed();
}

async function main(): Promise<void> {
  const event = process.argv[2] as BridgeEvent | undefined;
  if (event !== 'pre-tool-use' && event !== 'session-start') {
    block(`bridge invoked with unknown event "${String(event)}"`);
  }
  const watchdog = setTimeout(() => onFailure(`bridge exceeded ${WATCHDOG_MS} ms`), WATCHDOG_MS);
  watchdog.unref();

  const raw = await readStdin();
  if (event === 'pre-tool-use') {
    await preToolUse(raw);
  } else {
    await sessionStart(raw);
  }
}

process.on('uncaughtException', (error) => onFailure(`bridge crashed (${error.message})`));

main().catch((error: unknown) => onFailure(`bridge failed (${error instanceof Error ? error.message : String(error)})`));
