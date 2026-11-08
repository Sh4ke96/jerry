import fs from 'node:fs';
import path from 'node:path';
import type { EventEnvelope, TargetedTestsAnswer, Task } from '@jerry/contracts';
import { taskTouchesRepo } from '@jerry/policy-engine';
import { exitCodeOf, isTestCommand, selectTargetedTests } from '@jerry/quality';
import { WORK_STATES } from '@jerry/workflow';
import type { StateStore } from './state-store.js';

/**
 * The test results collector. Claude runs the tests; JERRY watches how its test
 * commands end: PostToolUse is a pass, PostToolUseFailure a failure (with the exit code), plus the
 * runner's one-line totals. The output itself is never stored.
 */

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);

export async function collectTestRun(store: StateStore, event: EventEnvelope): Promise<void> {
  if ((event.eventType !== 'PostToolUse' && event.eventType !== 'PostToolUseFailure') || event.toolName === null || !SHELL_TOOLS.has(event.toolName) || event.repoRoot === null) return;
  const input = (event.payload['input'] ?? {}) as Record<string, unknown>;
  const command = typeof input['command'] === 'string' ? input['command'] : null;
  if (command === null) return;
  const projectCommands = await testCommandsOf(store, event.repoRoot);
  if (!isTestCommand(command, projectCommands)) return;

  const response = (event.payload['response'] ?? {}) as Record<string, unknown>;
  const failure = event.eventType === 'PostToolUseFailure';
  const interrupted = event.payload['interrupted'] === true || response['interrupted'] === true;
  const exitCode = failure ? exitCodeOf(typeof event.payload['error'] === 'string' ? event.payload['error'] : null) : 0;
  const summary = typeof response['testSummary'] === 'string' ? response['testSummary'] : null;
  // A runner can exit 0 while reporting failures (some wrappers do): its totals win.
  const reportsFailure = summary !== null && /\b[1-9]\d* (failed|errors?)\b|^FAIL\b/.test(summary);
  const result = interrupted ? 'INTERRUPTED' : failure || reportsFailure ? 'FAIL' : 'PASS';
  const task = await workingTask(store, event.sessionId, event.repoRoot);
  await store.recordTestRun({
    taskId: task?.taskId ?? null,
    repoRoot: event.repoRoot,
    sessionId: event.sessionId,
    agentId: event.agentId,
    eventId: event.eventId,
    command,
    result,
    exitCode,
    summary,
    at: event.timestamp,
  });
}

async function testCommandsOf(store: StateStore, repoRoot: string): Promise<string[]> {
  const stored = await store.storedProfile(repoRoot);
  return (stored?.profile.commands ?? []).filter((command) => command.kind === 'test').flatMap((command) => [command.command, command.run]);
}

/** The task in implementation the session works on in this repository, if any. */
async function workingTask(store: StateStore, sessionId: string | null, repoRoot: string): Promise<Task | null> {
  // Its own repository, or another one of its multi-repository plan.
  const same = (task: Task): boolean => taskTouchesRepo(task, repoRoot, process.platform);
  const working = store.snapshot().tasks.filter((task) => WORK_STATES.has(task.state) && same(task));
  if (sessionId !== null) {
    const linked = new Set(await store.tasksOfSession(sessionId));
    const mine = working.find((task) => linked.has(task.taskId));
    if (mine !== undefined) return mine;
  }
  return working.length === 1 ? working[0]! : null;
}

/** The folder of the manifest a profile command comes from ("" for the repository root). */
function manifestDir(source: string): string {
  const manifest = source.trim().split(/\s+/)[0] ?? '';
  const dir = path.posix.dirname(manifest.replaceAll('\\', '/'));
  return dir === '.' ? '' : dir;
}

/**
 * The test command for these changed files: the one of the deepest package that holds all of them
 * (a change inside apps/web runs apps/web's tests), else the repository root's, else the first
 * found. Profile commands come in manifest order, so the first one is not necessarily the root's.
 */
export function testCommandFor(commands: ReadonlyArray<{ kind: string; run: string; source: string }>, changedFiles: readonly string[]): string | null {
  const tests = commands.filter((command) => command.kind === 'test').map((command) => ({ run: command.run, dir: manifestDir(command.source) }));
  if (tests.length === 0) return null;
  const inside = (file: string, dir: string): boolean => dir === '' || file.replaceAll('\\', '/').startsWith(`${dir}/`);
  const holding = changedFiles.length === 0 ? [] : tests.filter((command) => command.dir !== '' && changedFiles.every((file) => inside(file, command.dir)));
  const deepest = holding.sort((a, b) => b.dir.split('/').length - a.dir.split('/').length)[0];
  return (deepest ?? tests.find((command) => command.dir === '') ?? tests[0]!).run;
}

/** Targeted tests for a task's changes since its plan was approved. */
export async function targetedTestsFor(store: StateStore, task: Task): Promise<TargetedTestsAnswer> {
  const changes = await store.changesSincePlanApproval(task);
  const stored = await store.storedProfile(task.repoRoot);
  const command = testCommandFor(stored?.profile.commands ?? [], changes);
  const exists = (file: string): boolean => {
    try {
      return fs.statSync(path.join(task.repoRoot, file)).isFile();
    } catch {
      return false;
    }
  };
  const selection = selectTargetedTests(changes, exists, command);
  return { changed: changes, ...selection, projectCommand: command, lastRuns: await store.testRunsOf(task.taskId, 5) };
}
