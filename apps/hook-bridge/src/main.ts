import fs from 'node:fs';
// Types only from the contracts index: the bridge must not load Zod (ADR 0010; checked by the build).
import type { EventEnvelope, GateCheckRequest, GateDecision, OpenTask, SessionRegistrationResponse, SessionStartInput } from '@jerry/contracts';
import { isGateDecision, isPreToolUseInput, isSessionRegistrationResponse, isSessionStartInput } from '@jerry/contracts/guards';
import { autostartCore, protectedRoots, readCoreRuntimeInfo, requestCore, resolveJerryHome, spoolEvent } from '@jerry/platform';
import { classifyToolCall, evaluateHardRules } from '@jerry/policy-engine';
import { buildEventEnvelope, newEventId, type EnvelopeOverrides } from '@jerry/trace-engine';
import { STATE_LABELS } from '@jerry/workflow';

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
/** SessionStart has a 5 s hook timeout; leave room for registration after Core comes up. */
const AUTOSTART_WAIT_MS = 3000;
const WATCHDOG_MS = 8000;
const MAX_STDIN_BYTES = 64 * 1024 * 1024;
/** Only these tool_input fields are forwarded to Core: never file contents or edit payloads. */
const FORWARDED_TOOL_INPUT_FIELDS = ['file_path', 'notebook_path', 'command'] as const;

/** pre-tool-use and session-start answer Claude Code; event records telemetry hooks. */
type BridgeEvent = 'pre-tool-use' | 'session-start' | 'event';
/** Telemetry hooks run asynchronously; a short timeout keeps a hung Core from piling up processes. */
const EVENT_TIMEOUT_MS = 1000;

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
  // Only pre-tool-use enforces hard rules; session-start and telemetry events never block.
  if (process.argv[2] !== 'pre-tool-use' || hardRulesCleared) proceed();
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
  const input: unknown = JSON.parse(raw);
  if (!isPreToolUseInput(input)) onFailure('unrecognised PreToolUse input');

  const forwardedInput: Record<string, unknown> = {};
  for (const field of FORWARDED_TOOL_INPUT_FIELDS) {
    if (field in input.tool_input) forwardedInput[field] = input.tool_input[field];
  }
  const eventId = newEventId();
  const request: GateCheckRequest = {
    eventId,
    sessionId: input.session_id,
    cwd: input.cwd,
    toolName: input.tool_name,
    toolInput: forwardedInput,
    toolUseId: input.tool_use_id ?? null,
    agentId: input.agent_id ?? null,
  };
  // What gets spooled if Core cannot record the call itself (same event ID: replay stays idempotent).
  const spoolable = (overrides: EnvelopeOverrides) => buildEventEnvelope({ ...input, tool_input: forwardedInput }, { eventId, ...overrides });

  const hardRule = evaluateHardRules(classifyToolCall(request.toolName, request.toolInput), request.cwd, {
    platform: process.platform,
    protectedRoots: protectedRoots(),
    realPath: (target) => target,
  });
  if (hardRule !== null) {
    // Core records the blocked attempt; if it is down, the attempt is spooled instead.
    const recorded = await askCore(request).then(
      () => true,
      () => false,
    );
    if (!recorded) spool(spoolable({ verdict: 'DENY', ruleId: hardRule.ruleId, extraPayload: { reason: hardRule.reason } }));
    block(`${hardRule.reason} [${hardRule.ruleId}]`);
  }
  hardRulesCleared = true;

  const decision = await askCore(request).catch(() => null);
  if (decision === null) {
    // Core unavailable: the call proceeds; it is spooled and evaluated against the plan once Core
    // is back. Start Core in the background; never make Claude wait for it.
    spool(spoolable({ pendingEvaluation: true, ruleId: 'core.unavailable' }));
    tryAutostart();
    proceed();
  }
  emit(decision);
}

function spool(event: EventEnvelope | null): void {
  if (event === null) return;
  try {
    spoolEvent(resolveJerryHome(), event);
  } catch {
    // Losing one event must never affect Claude's work.
  }
}

/**
 * Telemetry hooks (PostToolUse, SubagentStart/Stop, Stop, SessionEnd, UserPromptSubmit). They run
 * asynchronously and never block or fail: the event goes to Core, or to the spool if Core is down.
 */
async function recordEvent(raw: string): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    proceed();
  }
  if (typeof input !== 'object' || input === null) proceed();
  const event = buildEventEnvelope(input as Record<string, unknown>);
  if (event === null) proceed();
  try {
    const info = readCoreRuntimeInfo(resolveJerryHome());
    await requestCore(info, { method: 'POST', path: '/api/v1/events', body: { events: [event] }, timeoutMs: EVENT_TIMEOUT_MS });
  } catch {
    spool(event);
    tryAutostart();
  }
  proceed();
}

function tryAutostart(): 'started' | 'throttled' | 'unavailable' {
  try {
    return autostartCore(resolveJerryHome());
  } catch {
    return 'unavailable';
  }
}

async function registerSession(input: SessionStartInput): Promise<SessionRegistrationResponse> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const body = await requestCore(info, {
    method: 'POST',
    path: '/api/v1/sessions',
    body: { sessionId: input.session_id, cwd: input.cwd, source: input.source ?? null },
    timeoutMs: CORE_TIMEOUT_MS,
  });
  if (!isSessionRegistrationResponse(body)) throw new Error('Core answered the session registration with an unexpected shape');
  return body;
}

/** After an automatic start, waits for Core to accept the session (bounded by the SessionStart hook timeout). */
async function registerSessionAfterAutostart(input: SessionStartInput): Promise<SessionRegistrationResponse> {
  const deadline = Date.now() + AUTOSTART_WAIT_MS;
  let lastError: unknown = new Error('Core did not start in time');
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      return await registerSession(input);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function askCore(request: GateCheckRequest): Promise<GateDecision> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const body = await requestCore(info, { method: 'POST', path: '/api/v1/gate/check', body: request, timeoutMs: CORE_TIMEOUT_MS });
  if (!isGateDecision(body)) throw new Error('Core answered the gate check with an unexpected shape');
  return body;
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
            additionalContext: `JERRY warning: ${decision.reason} [${decision.ruleId}]${decision.feedback === undefined ? '' : `\n${decision.feedback}`}`,
          },
        }),
      );
      proceed();
      break;
    case 'PASS':
      // Quality findings go to Claude only; the user sees them in the dashboard (ADR 0029).
      if (decision.feedback !== undefined) writeOut(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.feedback } }));
      proceed();
  }
}

/**
 * The full hard-rule statement, verbatim. The product owner requires it unchanged (2026-11-06):
 * token savings never come from shortening the safety rules Claude is told about.
 */
const HARD_RULES_TEXT =
  'Hard rules, always enforced: you may not run any Git command that changes anything (commit, push, merge, rebase, checkout, switch, reset, restore, stash, fetch, pull, tag, branch changes, config changes, gh/npm version and similar), and you may not use MCP tools of Git servers that push, commit, create branches or files, or open or merge pull requests; the user does all Git operations manually. Read-only Git (status, diff, log, show, blame) is fine. You may not write inside .git, modify JERRY data or the Claude Code settings that enable JERRY, run "jerry approve/reject/install/uninstall/ui", "jerry repo exclude/include", "jerry core start/stop" or "jerry db restore", or call the JERRY API or dashboard.';

/**
 * Tells the model what is actually approved right now. A generic message made models refuse
 * even in-scope edits of an already approved plan (M0 live finding).
 */
function monitoredSessionContext(registration: SessionRegistrationResponse): string {
  const lines = ['JERRY: monitoring this session; it never blocks edits, it records deviations from the approved plan and warns you.'];
  if (registration.repoRoot === null) {
    lines.push('Not inside a Git repository.');
  } else if (registration.excluded) {
    lines.push(`The user excluded ${registration.repoRoot} from monitoring.`);
  } else if (registration.approvedPlans.length === 0) {
    lines.push(`There is no approved JERRY plan for ${registration.repoRoot}.`);
  } else {
    const plans = registration.approvedPlans.map((plan) => `${plan.taskId} v${plan.planVersion} (scope: ${plan.scope.join(', ')})`).join('; ');
    lines.push(`Approved plan: ${plans}.`);
  }
  if (registration.repoRoot !== null && !registration.excluded) lines.push(...resumeContext(registration.openTasks ?? []));
  lines.push(
    'Mention JERRY warnings in your summary. If you need the current plan state (it can change mid-session), use the jerry MCP tools.',
    HARD_RULES_TEXT,
    'If JERRY blocks an action, report the reason to the user instead of working around it.',
  );
  return lines.join(' ');
}

/** Open tasks shown in full at session start; the rest are counted (jerry_get_state lists them). */
const OPEN_TASKS_IN_CONTEXT = 3;

/** One line of text, at most `max` characters: titles and notes come from Claude, not from JERRY. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * What the session needs to pick up the work after a restart, resume or compaction (ADR 0013):
 * open tasks with their state and Claude's last checkpoint. Kept short; it is in every session.
 */
function resumeContext(openTasks: readonly OpenTask[]): string[] {
  if (openTasks.length === 0) return [];
  const shown = openTasks.slice(0, OPEN_TASKS_IN_CONTEXT).map((task) => {
    let entry = `${task.taskId} "${oneLine(task.title, 80)}": ${STATE_LABELS[task.state].toLowerCase()}`;
    if (task.state === 'PAUSED') entry += ', do not continue it until the user resumes it';
    if (task.workedInThisSession) entry += ', you worked on it in this session';
    else if (task.lastActivityAt !== null) entry += `, last worked on ${task.lastActivityAt.slice(0, 16).replace('T', ' ')} UTC`;
    if (task.checkpoint !== null) {
      entry += `; last checkpoint: ${oneLine(task.checkpoint.summary, 300)}`;
      if (task.checkpoint.nextSteps.length > 0) entry += ` Next: ${task.checkpoint.nextSteps.slice(0, 3).map((step) => oneLine(step, 120)).join('; ')}`;
      const since = task.sinceCheckpoint;
      if (since !== undefined && (since.headBefore !== since.headNow || since.changedFiles > 0)) {
        const head = since.headBefore !== since.headNow ? `HEAD moved from ${since.headBefore?.slice(0, 7) ?? 'none'} to ${since.headNow?.slice(0, 7) ?? 'none'}` : 'HEAD unchanged';
        // No trailing period: the list of open tasks ends with one.
        entry += ` Since then: ${head}, ${since.changedFiles} file(s) changed (check git log and git diff first)`;
      }
    }
    return entry;
  });
  const more = openTasks.length - shown.length;
  const lines = [`Open JERRY tasks: ${shown.join(' | ')}${more > 0 ? ` (+${more} more)` : ''}.`];
  if (openTasks.slice(0, OPEN_TASKS_IN_CONTEXT).some((task) => task.checkpoint !== null)) {
    lines.push('Checkpoints are your notes from earlier sessions: check them against the current code (git status, git diff) before continuing.');
  }
  if (openTasks.some((task) => task.coversEdits)) lines.push('Save progress with jerry_save_checkpoint at milestones and before you finish.');
  return lines;
}

async function sessionStart(raw: string): Promise<void> {
  let context: string;
  try {
    const input: unknown = JSON.parse(raw);
    if (!isSessionStartInput(input)) throw new Error('unrecognised SessionStart input');
    let registration: SessionRegistrationResponse;
    try {
      registration = await registerSession(input);
    } catch (error) {
      if (tryAutostart() === 'unavailable') throw error;
      registration = await registerSessionAfterAutostart(input);
    }
    context = monitoredSessionContext(registration);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    context = `JERRY: Core unavailable (${cause}); edits are checked against the plan once it is back. ${HARD_RULES_TEXT}`;
    try {
      spool(buildEventEnvelope(JSON.parse(raw) as Record<string, unknown>));
    } catch {
      // unparseable input: nothing to record
    }
  }
  writeOut(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  proceed();
}

async function main(): Promise<void> {
  const event = process.argv[2] as BridgeEvent | undefined;
  if (event !== 'pre-tool-use' && event !== 'session-start' && event !== 'event') {
    block(`bridge invoked with unknown event "${String(event)}"`);
  }
  const watchdog = setTimeout(() => onFailure(`bridge exceeded ${WATCHDOG_MS} ms`), WATCHDOG_MS);
  watchdog.unref();

  const raw = await readStdin();
  if (event === 'pre-tool-use') {
    await preToolUse(raw);
  } else if (event === 'session-start') {
    await sessionStart(raw);
  } else {
    await recordEvent(raw);
  }
}

process.on('uncaughtException', (error) => onFailure(`bridge crashed (${error.message})`));

main().catch((error: unknown) => onFailure(`bridge failed (${error instanceof Error ? error.message : String(error)})`));
