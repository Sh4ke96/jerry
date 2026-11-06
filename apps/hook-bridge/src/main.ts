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
import { evaluateGate } from '@jerry/policy-engine';

/**
 * Claude Code command-hook adapter. Thin by design: parse stdin, ask Core, translate the
 * answer into the hook protocol. Workflow logic lives in Core.
 *
 * PreToolUse protocol used here:
 *   exit 2 + reason on stderr  -> tool call blocked (works even if JSON parsing changes)
 *   exit 0 + JSON "ask"        -> user must confirm
 *   exit 0, no output          -> no objection; Claude Code permissions decide
 * Any unexpected failure exits 2 (fail-closed). hooks.json also sets onFailure: "block"
 * for crashes that happen before this code runs (e.g. node missing).
 */

const CORE_TIMEOUT_MS = 3000;
const WATCHDOG_MS = 8000;
const MAX_STDIN_BYTES = 64 * 1024 * 1024;
/** Only these tool_input fields are forwarded to Core: never file contents or edit payloads. */
const FORWARDED_TOOL_INPUT_FIELDS = ['file_path', 'notebook_path', 'command'] as const;

type BridgeEvent = 'pre-tool-use' | 'session-start';

/** Synchronous fd writes: process.stdout/stderr can be asynchronous pipes on Windows and lose data on exit. */
function writeOut(text: string): void {
  fs.writeSync(1, text);
}

function block(reason: string): never {
  fs.writeSync(2, `JERRY guard: ${reason}\n`);
  process.exit(2);
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
  if (!parsed.success) block(`unrecognised PreToolUse input (${parsed.error.issues[0]?.message ?? 'invalid'}); blocking by default`);
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

  const decision = await decideWithCore(request).catch((error: unknown) => decideOffline(request, error));
  emitPreToolUse(decision);
}

async function decideWithCore(request: GateCheckRequest): Promise<GateDecision> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const body = await requestCore(info, { method: 'POST', path: '/api/v1/gate/check', body: request, timeoutMs: CORE_TIMEOUT_MS });
  return gateDecisionSchema.parse(body);
}

/**
 * Core unreachable: only commands the local classifier proves read-only may run.
 * Everything else fails closed (JR-018: a safety gate outage blocks writes, not safe reads).
 */
function decideOffline(request: GateCheckRequest, error: unknown): GateDecision {
  const cause = error instanceof Error ? error.message : String(error);
  const local = evaluateGate(request, {
    platform: process.platform,
    protectedRoots: protectedRoots(),
    realPath: (target) => target,
    findRepoRoot: () => null,
    approvedPlans: () => [],
  });
  if (local.verdict === 'PASS' && local.ruleId === 'shell.read-only') {
    return { ...local, ruleId: 'core.unavailable.read-only-allowed' };
  }
  if (local.verdict === 'PASS' && local.ruleId === 'tool.not-guarded') {
    return local;
  }
  return {
    verdict: 'DENY',
    ruleId: 'core.unavailable',
    reason: `JERRY Core is unavailable (${cause}); writes are blocked until Core is running again (fail-closed). Ask the user to run "jerry core start".`,
    taskId: null,
    repoRoot: null,
  };
}

function emitPreToolUse(decision: GateDecision): void {
  switch (decision.verdict) {
    case 'DENY':
      block(`${decision.reason} [${decision.ruleId}]`);
      break;
    case 'ASK':
      writeOut(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `JERRY: ${decision.reason} [${decision.ruleId}]`,
          },
        }),
      );
      process.exit(0);
      break;
    case 'PASS':
      process.exit(0);
  }
}

/**
 * Tells the model what is actually approved right now. A generic "edits need approval" message
 * made models refuse even in-scope edits of an already approved plan (M0 live finding).
 */
function guardedSessionContext(registration: SessionRegistrationResponse): string {
  const lines = ['JERRY guard: GUARDED.'];
  if (registration.repoRoot === null) {
    lines.push('The working directory is not inside a Git repository. JERRY blocks edits inside Git repositories that are not covered by an approved plan.');
  } else if (registration.approvedPlans.length === 0) {
    lines.push(
      `There is no approved JERRY plan for the repository ${registration.repoRoot} yet. File edits and write-capable shell commands there will be blocked; read-only work is fine.`,
      'To change code, prepare a plan and ask the user to approve it in JERRY.',
    );
  } else {
    const plans = registration.approvedPlans.map((plan) => `${plan.taskId} v${plan.planVersion} (scope: ${plan.scope.join(', ')})`).join('; ');
    lines.push(
      `Approved JERRY plan(s) for the repository ${registration.repoRoot}: ${plans}.`,
      'You may edit files inside that scope. Edits outside it are blocked and need a new plan version approved by the user.',
    );
  }
  lines.push('Never run "jerry approve" or call the JERRY API yourself. If JERRY blocks an action, report the reason to the user instead of working around it.');
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
        timeoutMs: 1500,
      }),
    );
    context = guardedSessionContext(registration);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    context = `JERRY guard: Core unavailable (${cause}). File edits in repositories will be blocked (fail-closed) until the user runs "jerry core start". Read-only work can continue.`;
  }
  writeOut(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  process.exit(0);
}

async function main(): Promise<void> {
  const event = process.argv[2] as BridgeEvent | undefined;
  if (event !== 'pre-tool-use' && event !== 'session-start') {
    block(`bridge invoked with unknown event "${String(event)}"`);
  }
  const watchdog = setTimeout(() => {
    if (event === 'pre-tool-use') block(`bridge exceeded ${WATCHDOG_MS} ms; blocking by default`);
    process.exit(0);
  }, WATCHDOG_MS);
  watchdog.unref();

  const raw = await readStdin();
  if (event === 'pre-tool-use') {
    await preToolUse(raw);
  } else {
    await sessionStart(raw);
  }
}

process.on('uncaughtException', (error) => {
  if (process.argv[2] === 'session-start') process.exit(0);
  block(`bridge crashed (${error.message}); blocking by default`);
});

main().catch((error: unknown) => {
  if (process.argv[2] === 'session-start') process.exit(0);
  block(`bridge failed (${error instanceof Error ? error.message : String(error)}); blocking by default`);
});
