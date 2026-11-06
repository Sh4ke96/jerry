import { storedEventSchema, type StoredEvent } from '@jerry/contracts';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';

/** Timeline in the terminal until the dashboard exists: oldest first, one line per event. */
export async function showEvents(options: { sessionId?: string; verdict?: string; limit: number }): Promise<void> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.sessionId !== undefined) params.set('sessionId', options.sessionId);
  if (options.verdict !== undefined) params.set('verdict', options.verdict.toUpperCase());
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const events = z.array(storedEventSchema).parse(await requestCore(info, { method: 'GET', path: `/api/v1/events?${params.toString()}`, timeoutMs: 5000 }));
  if (events.length === 0) {
    console.log('No events.');
    return;
  }
  for (const event of events.reverse()) console.log(formatEvent(event));
}

function formatEvent(event: StoredEvent): string {
  const when = new Date(event.timestamp);
  const today = new Date().toDateString() === when.toDateString();
  const time = today ? when.toLocaleTimeString() : when.toLocaleString();
  const actor = event.toolName ?? event.agentType ?? '';
  const verdict = event.verdict === null ? '' : `${event.verdict} ${event.ruleId ?? ''}`;
  const flags = [event.spooled ? 'spooled' : '', event.payload['evaluatedLate'] === true ? 'late' : ''].filter(Boolean).join(',');
  return [time.padEnd(10), event.eventType.padEnd(18), actor.padEnd(14), verdict.padEnd(36), detail(event), flags === '' ? '' : `(${flags})`].join(' ').trimEnd();
}

function detail(event: StoredEvent): string {
  const input = (event.payload['input'] ?? {}) as Record<string, unknown>;
  for (const value of [input['path'], input['command'], event.payload['slashCommand'], event.payload['reason'], event.payload['source']]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  if (typeof event.payload['promptLength'] === 'number') return `prompt (${event.payload['promptLength']} chars)`;
  return event.sessionId === null ? '' : `session ${event.sessionId.slice(0, 8)}`;
}
