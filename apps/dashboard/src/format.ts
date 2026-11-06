import type { StoredEvent, TaskWithDecision, WorkflowState } from '@jerry/contracts';
import { isTerminal, WORK_STATES } from '@jerry/workflow';
import type { Tone } from './components/Badge';

/** States in which the next step is the user's (FINAL_REPORT remains only when Core refused DONE). */
const WAITING_FOR_USER: ReadonlySet<WorkflowState> = new Set(['WAIT_PLAN_APPROVAL', 'WAIT_IMPLEMENTATION_ACCEPTANCE', 'WAIT_REVIEW_FIX_APPROVAL', 'FINAL_REPORT']);

export function waitsForUser(task: TaskWithDecision): boolean {
  return WAITING_FOR_USER.has(task.state);
}

/** Being implemented under its approved plan, so edits in its scope pass. */
export function inImplementation(task: TaskWithDecision): boolean {
  return WORK_STATES.has(task.state) && task.planDecision?.decision === 'APPROVED';
}

export function isOpen(task: TaskWithDecision): boolean {
  return !isTerminal(task.state);
}

/** Taken in for analysis and still without a real plan: its scope is only the analysis focus (ADR 0024). */
export function isIntake(task: TaskWithDecision): boolean {
  return task.goal !== undefined && task.plan.version === 1 && task.plan.document === undefined;
}

export function stateTone(state: WorkflowState): Tone {
  if (WORK_STATES.has(state)) return 'pass';
  if (WAITING_FOR_USER.has(state)) return 'warn';
  if (state === 'PLAN_DRAFT' || state === 'BLOCKED') return 'deny';
  if (state === 'DONE') return 'accent';
  return 'neutral';
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString() : date.toLocaleString();
}

export function formatDuration(fromIso: string, now = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(fromIso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days`;
}

export function startOfToday(): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString();
}

/** What the event was about, in one line: a path, a command or the hook's own detail. */
export function eventTarget(event: StoredEvent): string {
  const input = (event.payload['input'] ?? {}) as Record<string, unknown>;
  for (const value of [input['path'], input['command'], event.payload['slashCommand'], event.payload['source'], event.payload['reason']]) {
    if (typeof value === 'string' && value !== '') return value;
  }
  if (typeof event.payload['promptLength'] === 'number') return `prompt, ${event.payload['promptLength']} characters`;
  return '';
}

export function eventReason(event: StoredEvent): string {
  return typeof event.payload['reason'] === 'string' ? event.payload['reason'] : '';
}

export function shortPath(path: string, max = 64): string {
  return path.length <= max ? path : `…${path.slice(path.length - max + 1)}`;
}
