import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_SCHEMA_VERSION, eventEnvelopeSchema, gateVerdictSchema, type EventEnvelope, type GateCheckRequest, type GateDecision } from '@jerry/contracts';
import { quarantineSpoolFile, readSpool } from '@jerry/platform';
import { findGitRoot, realPathOfNearestExisting } from './repo-fs.js';
import type { StateStore } from './state-store.js';

export type Evaluate = (request: GateCheckRequest) => GateDecision;

const SPOOL_BATCH = 500;

/**
 * A PreToolUse recorded while Core was down carries only the bridge's local verdict. Core now
 * evaluates it against the current plans, so edits made during an outage still show up as
 * deviations (marked evaluatedLate).
 */
export function evaluatePending(event: EventEnvelope, evaluate: Evaluate): EventEnvelope {
  if (!event.pendingEvaluation || event.eventType !== 'PreToolUse' || event.toolName === null) return event;
  const input = (event.payload['input'] ?? {}) as Record<string, unknown>;
  const toolInput: Record<string, unknown> = {};
  if (typeof input['path'] === 'string') toolInput['file_path'] = input['path'];
  if (typeof input['command'] === 'string') toolInput['command'] = input['command'];
  const decision = evaluate({
    sessionId: event.sessionId ?? 'unknown',
    cwd: event.cwd ?? '.',
    toolName: event.toolName,
    toolInput,
    toolUseId: event.toolUseId,
    agentId: event.agentId,
  });
  return {
    ...event,
    verdict: decision.verdict,
    ruleId: decision.ruleId,
    taskId: decision.taskId,
    repoRoot: decision.repoRoot,
    payload: { ...event.payload, reason: decision.reason, evaluatedLate: true },
    pendingEvaluation: false,
  };
}

/**
 * Gives an event the repository its working directory lies in, when it has none: hard-rule blocks
 * are decided before the repository is resolved, and telemetry hooks carry only the cwd.
 */
export function withRepoRoot(event: EventEnvelope): EventEnvelope {
  if (event.repoRoot !== null || event.cwd === null) return event;
  return { ...event, repoRoot: findGitRoot(realPathOfNearestExisting(event.cwd)) };
}

/**
 * True when the event happened inside a project the user added: its target path if it has one,
 * else its working directory. Events from anywhere else are not stored.
 */
export function isMonitoredEvent(store: StateStore, event: EventEnvelope): boolean {
  const input = event.payload['input'];
  const target = typeof input === 'object' && input !== null && typeof (input as Record<string, unknown>)['path'] === 'string' ? ((input as Record<string, unknown>)['path'] as string) : null;
  const base = event.cwd ?? event.repoRoot;
  if (base === null) return target !== null && path.isAbsolute(target) && store.isMonitored(realPathOfNearestExisting(target));
  return store.isMonitored(realPathOfNearestExisting(target === null ? base : path.resolve(base, target)));
}

/** Moves events from the spool into the database. Returns how many files were processed. */
export async function drainSpool(home: string, store: StateStore, evaluate: Evaluate, now: () => Date = () => new Date()): Promise<number> {
  const files = readSpool(home, SPOOL_BATCH);
  if (files.length === 0) return 0;
  const accepted: Array<{ file: string; event: EventEnvelope }> = [];
  for (const { file, content } of files) {
    let parsed: ReturnType<typeof eventEnvelopeSchema.safeParse>;
    try {
      parsed = eventEnvelopeSchema.safeParse(JSON.parse(content));
    } catch {
      quarantineSpoolFile(home, file);
      continue;
    }
    if (!parsed.success) {
      quarantineSpoolFile(home, file);
      continue;
    }
    accepted.push({ file, event: withRepoRoot(evaluatePending(parsed.data, evaluate)) });
  }
  // Spooled events from outside the projects are dropped with their files, never stored.
  const events = accepted.map((entry) => entry.event).filter((event) => isMonitoredEvent(store, event));
  await store.recordEvents(events, now(), true);
  for (const event of events) {
    if (event.eventType === 'SessionStart' && event.sessionId !== null && event.cwd !== null) {
      await store.registerSession({ sessionId: event.sessionId, cwd: event.cwd, source: typeof event.payload['source'] === 'string' ? event.payload['source'] : null }, new Date(event.timestamp));
    }
  }
  for (const { file } of accepted) fs.rmSync(file, { force: true });
  return files.length;
}

/**
 * One-time import of the gate log written before events moved into the database. Event IDs are
 * derived from the line content, so an interrupted import can safely run again.
 */
export async function importLegacyGateLog(file: string, store: StateStore, now: Date): Promise<number> {
  if (!fs.existsSync(file)) return 0;
  const events: EventEnvelope[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const str = (key: string): string | null => (typeof entry[key] === 'string' ? (entry[key] as string) : null);
    const timestamp = str('at');
    if (timestamp === null || Number.isNaN(Date.parse(timestamp))) continue;
    const paths = Array.isArray(entry['paths']) ? (entry['paths'] as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    const verdict = gateVerdictSchema.safeParse(entry['verdict']);
    events.push({
      eventId: `evt_legacy_${createHash('sha256').update(line).digest('hex').slice(0, 32)}`,
      schemaVersion: EVENT_SCHEMA_VERSION,
      source: 'jerry-core',
      eventType: 'PreToolUse',
      timestamp: new Date(timestamp).toISOString(),
      sessionId: str('sessionId'),
      agentId: str('agentId'),
      agentType: null,
      cwd: str('cwd'),
      toolName: str('toolName'),
      toolUseId: str('toolUseId'),
      taskId: str('taskId'),
      repoRoot: str('repoRoot'),
      verdict: verdict.success ? verdict.data : null,
      ruleId: str('ruleId'),
      payload: {
        input: { ...(paths[0] === undefined ? {} : { path: paths[0] }), ...(str('commandHead') === null ? {} : { command: str('commandHead'), commandLength: entry['commandLength'] }) },
        reason: str('reason'),
        importedFrom: 'gate-decisions.jsonl',
      },
      redaction: { applied: false, reasons: [] },
      pendingEvaluation: false,
    });
  }
  for (let index = 0; index < events.length; index += 500) {
    await store.recordEvents(events.slice(index, index + 500), now, false);
  }
  fs.renameSync(file, `${file}.imported-${now.toISOString().replace(/[:.]/g, '-')}`);
  return events.length;
}
