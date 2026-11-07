import fs from 'node:fs';
// Types only from the contracts index: the bridge runs on every tool call and must not load Zod
// (checked by the build). The guards and the emoji vocabulary are dependency-free.
import type { EventEnvelope, GateCheckRequest, GateDecision, OpenTask, SessionRegistrationResponse, SessionStartInput } from '@jerry/contracts';
import { EMOJI, STATE_EMOJI, decorate } from '@jerry/contracts/emoji';
import { isGateDecision, isPreToolUseInput, isSessionRegistrationResponse, isSessionStartInput } from '@jerry/contracts/guards';
import { autostartCore, protectedRoots, readCoreRuntimeInfo, readProjectsFile, requestCore, resolveJerryHome, spoolEvent } from '@jerry/platform';
import { absolutePath, classifyToolCall, comparablePath, evaluateHardRules, isComparableInside } from '@jerry/policy-engine';
import { buildEventEnvelope, newEventId, type EnvelopeOverrides } from '@jerry/trace-engine';
import { STATE_LABELS } from '@jerry/workflow';

/**
 * Claude Code command-hook adapter: JERRY monitors, and blocks only hard rules.
 *
 * PreToolUse flow:
 *   1. Parse stdin and evaluate the hard rules locally (Git state changes, .git, JERRY data).
 *      These need no Core, so they hold while Core is down. If the input cannot be parsed,
 *      the hard rules cannot be checked and the call is blocked.
 *   Outside the projects the user added (JERRY_HOME/run/projects.json) that is all: no Core call,
 *   no record, no Core start. Without that file Core decides, as it always did.
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
  fs.writeSync(2, `${decorate(EMOJI.blocked, `JERRY: ${reason}`)}\n`);
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
  // Outside the projects the user added only the hard rules apply: no Core, no record, no autostart.
  if (outsideProjects(toolTarget(input.tool_input), input.cwd)) {
    if (hardRule !== null) block(`${hardRule.reason} [${hardRule.ruleId}]`);
    hardRulesCleared = true;
    proceed();
  }
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
  const fields = input as Record<string, unknown>;
  if (typeof fields['cwd'] === 'string' && outsideProjects(toolTarget(fields['tool_input']), fields['cwd'])) proceed();
  const event = buildEventEnvelope(fields);
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
    // Claude Code sets CLAUDE_CODE_ENTRYPOINT (cli, claude-vscode, …) for its hooks; its metrics do
    // not carry it, so Core attributes a session's telemetry by this registration.
    body: { sessionId: input.session_id, cwd: input.cwd, source: input.source ?? null, entrypoint: process.env['CLAUDE_CODE_ENTRYPOINT'] ?? null },
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
          systemMessage: decorate(EMOJI.warning, `JERRY: ${decision.reason} [${decision.ruleId}]`),
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `${decorate(EMOJI.warning, `JERRY warning: ${decision.reason} [${decision.ruleId}]`)}${decision.feedback === undefined ? '' : `\n${decision.feedback}`}`,
          },
        }),
      );
      proceed();
      break;
    case 'PASS':
      // Quality findings go to Claude only; the user sees them in the dashboard. Core formats them.
      if (decision.feedback !== undefined) writeOut(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.feedback } }));
      proceed();
  }
}

/**
 * The full hard-rule statement, kept verbatim: token savings never come from shortening the safety
 * rules Claude is told about.
 */
const HARD_RULES_TEXT =
  'Hard rules, always enforced: you may not run any Git command that changes anything (commit, push, merge, rebase, checkout, switch, reset, restore, stash, fetch, pull, tag, branch changes, config changes, gh/npm version and similar), and you may not use MCP tools of Git servers that push, commit, create branches or files, or open or merge pull requests; the user does all Git operations manually. Read-only Git (status, diff, log, show, blame) is fine. You may not write inside .git, modify JERRY data or the Claude Code settings that enable JERRY, run "jerry approve/reject/install/uninstall/ui", "jerry repo exclude/include", "jerry project add/remove", "jerry data prune/forget", "jerry core start/stop" or "jerry db restore", or call the JERRY API or dashboard.';

/** The whole session context outside the projects the user added, followed by the hard rules. */
const NOT_A_PROJECT_LINE = decorate(EMOJI.jerry, 'JERRY: this project is not added; only hard rules apply. The user can add it with jerry project add.');

/** Project roots from JERRY_HOME/run/projects.json; null when unknown, and then Core decides as before. */
function projectRoots(): string[] | null {
  try {
    return readProjectsFile(resolveJerryHome());
  } catch {
    return null;
  }
}

/** The file a tool call targets, if it names one. */
function toolTarget(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) return null;
  const fields = toolInput as Record<string, unknown>;
  const target = fields['file_path'] ?? fields['notebook_path'];
  return typeof target === 'string' && target !== '' ? target : null;
}

/** Resolves links of the nearest existing ancestor (missing trailing segments are kept as they are). */
function nearestRealPath(target: string): string {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length === 0 ? real : `${real}/${missing.reverse().join('/')}`;
    } catch {
      const cut = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'));
      if (cut <= 0 || current.slice(0, cut).endsWith(':')) return target;
      missing.push(current.slice(cut + 1));
      current = current.slice(0, cut);
    }
  }
}

/**
 * True only when projects.json lists the projects and the path (the tool's target, else the working
 * directory) lies in none of them, by path boundaries and on Windows in any case.
 */
function outsideProjects(target: string | null, cwd: string): boolean {
  const roots = projectRoots();
  if (roots === null) return false;
  const keys = roots.map((root) => comparablePath(root, root, process.platform));
  const inside = (candidate: string): boolean => {
    const key = comparablePath(candidate, cwd, process.platform);
    return keys.some((root) => isComparableInside(key, root));
  };
  const requested = absolutePath(target ?? cwd, cwd, process.platform);
  if (inside(requested)) return false;
  // Reached through a link or junction: judged by where it really is.
  return !inside(nearestRealPath(requested));
}

/**
 * Tells the model what is actually approved right now. A generic message made models refuse
 * even in-scope edits of an already approved plan.
 */
function monitoredSessionContext(registration: SessionRegistrationResponse): string {
  // Core says the directory is not in a project (the bridge could not tell without projects.json).
  if (registration.monitored === false || registration.excluded) return `${NOT_A_PROJECT_LINE}\n${HARD_RULES_TEXT}`;
  const lines = [decorate(EMOJI.jerry, 'JERRY: monitoring this session; it never blocks edits, it records deviations from the approved plan and warns you.')];
  if (registration.repoRoot === null) {
    lines.push('Not inside a Git repository.');
  } else if (registration.approvedPlans.length === 0) {
    lines.push(`There is no approved JERRY plan for ${registration.repoRoot}.`);
  } else {
    const plans = registration.approvedPlans.map((plan) => `${plan.taskId} v${plan.planVersion} (scope: ${plan.scope.join(', ')})`).join('; ');
    lines.push(decorate(EMOJI.plan, `Approved plan: ${plans}.`));
  }
  if (registration.repoRoot !== null) lines.push(...resumeContext(registration.openTasks ?? []));
  lines.push(
    'Mention JERRY warnings in your summary. If you need the current plan state (it can change mid-session), use the JERRY Guardian MCP tools (get_state).',
    decorate(EMOJI.security, HARD_RULES_TEXT),
    'If JERRY blocks an action, report the reason to the user instead of working around it.',
  );
  return lines.join(' ');
}

/** Open tasks shown in full at session start; the rest are counted (get_state lists them). */
const OPEN_TASKS_IN_CONTEXT = 3;

/** One line of text, at most `max` characters: titles and notes come from Claude, not from JERRY. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * What the session needs to pick up the work after a restart, resume or compaction: open tasks
 * with their state and Claude's last checkpoint. Kept short; it is in every session.
 */
function resumeContext(openTasks: readonly OpenTask[]): string[] {
  if (openTasks.length === 0) return [];
  const shown = openTasks.slice(0, OPEN_TASKS_IN_CONTEXT).map((task) => {
    let entry = decorate(STATE_EMOJI[task.state], `${task.taskId} "${oneLine(task.title, 80)}": ${STATE_LABELS[task.state].toLowerCase()}`);
    if (task.state === 'PAUSED') entry += ', do not continue it until the user resumes it';
    if (task.workedInThisSession) entry += ', you worked on it in this session';
    else if (task.lastActivityAt !== null) entry += `, last worked on ${task.lastActivityAt.slice(0, 16).replace('T', ' ')} UTC`;
    if (task.checkpoint !== null) {
      entry += `; ${EMOJI.report} last checkpoint: ${oneLine(task.checkpoint.summary, 300)}`;
      if (task.checkpoint.nextSteps.length > 0) entry += ` ${EMOJI.next} Next: ${task.checkpoint.nextSteps.slice(0, 3).map((step) => oneLine(step, 120)).join('; ')}`;
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
  if (openTasks.some((task) => task.coversEdits)) lines.push('Save progress with the save_checkpoint tool at milestones and before you finish.');
  return lines;
}

/** The share report waits at most this long; the context is already written by then. */
const SHARE_TIMEOUT_MS = 300;

/**
 * JERRY's share of Claude's context: the length of the session-start context, reported after it is
 * written (Core keeps it only for a session it registered in a project). Never fails.
 */
async function reportSessionStartShare(sessionId: string, chars: number): Promise<void> {
  try {
    const info = readCoreRuntimeInfo(resolveJerryHome());
    await requestCore(info, { method: 'POST', path: '/api/v1/usage/jerry-share', body: { kind: 'sessionStart', chars, origin: { sessionId } }, timeoutMs: SHARE_TIMEOUT_MS });
  } catch {
    // Only a statistic: losing it never matters.
  }
}

async function sessionStart(raw: string): Promise<void> {
  let context: string;
  /** Set when Core registered the session in a project: then the context counts toward JERRY's share. */
  let counted: string | null = null;
  try {
    const input: unknown = JSON.parse(raw);
    if (!isSessionStartInput(input)) throw new Error('unrecognised SessionStart input');
    if (outsideProjects(null, input.cwd)) {
      writeOut(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${NOT_A_PROJECT_LINE}\n${HARD_RULES_TEXT}` } }));
      proceed();
    }
    let registration: SessionRegistrationResponse;
    try {
      registration = await registerSession(input);
    } catch (error) {
      if (tryAutostart() === 'unavailable') throw error;
      registration = await registerSessionAfterAutostart(input);
    }
    context = monitoredSessionContext(registration);
    if (registration.monitored !== false && !registration.excluded) counted = input.session_id;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    context = `${decorate(EMOJI.warning, `JERRY: Core unavailable (${cause}); edits are checked against the plan once it is back.`)} ${decorate(EMOJI.security, HARD_RULES_TEXT)}`;
    try {
      spool(buildEventEnvelope(JSON.parse(raw) as Record<string, unknown>));
    } catch {
      // unparseable input: nothing to record
    }
  }
  writeOut(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  if (counted !== null) await reportSessionStartShare(counted, context.length);
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
