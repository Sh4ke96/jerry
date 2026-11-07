import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '@jerry/contracts';
import { matchesAnyGlob, relativeInside, taskRepository } from '@jerry/policy-engine';
import { BUILT_IN_RULES, changedLinesFromDiff, checkFile, type CheckedFile, type DetectedFinding, type Rule } from '@jerry/quality';
import { WORK_STATES } from '@jerry/workflow';
import type { GitReader } from './git-reader.js';
import type { StateStore } from './state-store.js';

/**
 * The diff collector and quality scheduler. Edits reported by PostToolUse
 * are queued per session; after a quiet period (debounce) the batch is checked: each file is read
 * (never written), its changed lines come from a read-only `git diff`, and the static rules run
 * within a time budget. JERRY never runs project commands here.
 */

export interface QualitySchedulerOptions {
  store: StateStore;
  git: GitReader;
  /** Quiet period after the last edit of a session before its batch runs (1–3 s: soon after the work, not on every keystroke). */
  debounceMs?: number;
  /** Time budget of one batch; files left over are recorded as not checked. */
  budgetMs?: number;
  rules?: readonly Rule[];
  /** Larger files are skipped (generated or vendored code). */
  maxFileBytes?: number;
  /** A rule the user marked as a false positive this often is muted (calibration). */
  muteAfterFalsePositives?: number;
  now?: () => Date;
}

interface PendingEdit {
  repoRoot: string;
  file: string;
  agentId: string | null;
}

interface Pending {
  timer: NodeJS.Timeout;
  edits: Map<string, PendingEdit>;
}

const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class QualityScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly running = new Set<Promise<void>>();
  private readonly debounceMs: number;
  private readonly budgetMs: number;
  private readonly rules: readonly Rule[];
  private readonly maxFileBytes: number;
  private readonly muteAfter: number;
  private readonly now: () => Date;
  private stopped = false;

  constructor(private readonly options: QualitySchedulerOptions) {
    this.debounceMs = options.debounceMs ?? 1500;
    this.budgetMs = options.budgetMs ?? 2000;
    this.rules = options.rules ?? BUILT_IN_RULES;
    this.maxFileBytes = options.maxFileBytes ?? 512 * 1024;
    this.muteAfter = options.muteAfterFalsePositives ?? 3;
    this.now = options.now ?? (() => new Date());
  }

  /** A hook event Core received; file edits are queued, everything else is ignored. */
  observe(event: { eventType: string; toolName: string | null; sessionId: string | null; agentId: string | null; cwd: string | null; repoRoot: string | null; payload: Record<string, unknown> }): void {
    if (this.stopped || event.eventType !== 'PostToolUse' || event.toolName === null || !FILE_TOOLS.has(event.toolName) || event.repoRoot === null) return;
    const input = (event.payload['input'] ?? {}) as Record<string, unknown>;
    const target = typeof input['path'] === 'string' ? input['path'] : null;
    if (target === null) return;
    const absolute = path.isAbsolute(target) ? target : path.resolve(event.cwd ?? event.repoRoot, target);
    const relative = relativeInside(absolute, event.repoRoot, process.platform);
    if (relative === null || relative === '') return;
    this.enqueue(event.sessionId ?? 'no-session', { repoRoot: event.repoRoot, file: relative.replaceAll('\\', '/'), agentId: event.agentId });
  }

  enqueue(sessionKey: string, edit: PendingEdit): void {
    const current = this.pending.get(sessionKey);
    if (current !== undefined) clearTimeout(current.timer);
    const edits = current?.edits ?? new Map<string, PendingEdit>();
    edits.set(`${edit.repoRoot}\n${edit.file}`, edit);
    // Later edits within the quiet period join the same batch.
    const timer = setTimeout(() => this.flush(sessionKey), this.debounceMs);
    timer.unref();
    this.pending.set(sessionKey, { timer, edits });
  }

  /** Runs a session's queued batch now. */
  flush(sessionKey: string): Promise<void> {
    const current = this.pending.get(sessionKey);
    if (current === undefined) return Promise.resolve();
    clearTimeout(current.timer);
    this.pending.delete(sessionKey);
    const run = this.check(sessionKey === 'no-session' ? null : sessionKey, [...current.edits.values()]).catch(() => {
      // A failed batch is recorded inside check(); nothing may escape into Core's request handling.
    });
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
    return run;
  }

  /** Waits for every queued and running batch (tests and shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((key) => this.flush(key)));
    await Promise.all([...this.running]);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private async check(sessionId: string | null, edits: readonly PendingEdit[]): Promise<void> {
    const { store, git } = this.options;
    const started = this.now();
    const deadline = Date.now() + this.budgetMs;
    const falsePositives = await store.falsePositivesByRule();
    const disabled = new Set([...falsePositives].filter(([, count]) => count >= this.muteAfter).map(([rule]) => rule));

    // One batch per repository and task: the task whose approved plan covers the file.
    const groups = new Map<string, { task: Task; repoRoot: string; files: Array<{ file: string; findings: DetectedFinding[]; planRelated: boolean }>; agentId: string | null; skipped: string[] }>();
    for (const edit of edits) {
      const task = coveringTask(store, edit.repoRoot, edit.file);
      if (task === null) continue;
      const key = `${task.taskId}\n${edit.repoRoot}`;
      const group = groups.get(key) ?? { task, repoRoot: edit.repoRoot, files: [], agentId: edit.agentId, skipped: [] };
      groups.set(key, group);
      if (Date.now() > deadline) {
        group.skipped.push(edit.file);
        continue;
      }
      const checked = await this.read(git, edit.repoRoot, edit.file);
      if (checked === 'skip') continue;
      group.files.push({ file: edit.file, findings: checked === null ? [] : checkFile(checked, this.rules, { disabled }), planRelated: planNames(task, edit.file) });
    }
    for (const group of groups.values()) {
      await store.applyQualityBatch({
        taskId: group.task.taskId,
        repoRoot: group.repoRoot,
        sessionId,
        agentId: group.agentId,
        files: group.files,
        startedAt: started,
        durationMs: this.now().getTime() - started.getTime(),
        error: group.skipped.length > 0 ? `time budget of ${this.budgetMs} ms used up; not checked: ${group.skipped.join(', ')}` : null,
      });
    }
  }

  /** The file and its changed lines; null for a deleted file (its findings are resolved), 'skip' when it cannot be checked. */
  private async read(git: GitReader, repoRoot: string, file: string): Promise<CheckedFile | null | 'skip'> {
    const absolute = path.join(repoRoot, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > this.maxFileBytes) return 'skip';
    const content = fs.readFileSync(absolute, 'utf8');
    if (content.includes('\0')) return 'skip';
    let changedLines: CheckedFile['changedLines'] = 'all';
    try {
      const diff = await git.fileDiff(repoRoot, file);
      if (diff !== null) changedLines = changedLinesFromDiff(diff);
    } catch {
      // Without Git every line counts as changed; the findings are still about this file only.
    }
    return { path: file, content, changedLines };
  }
}

/** The task in implementation whose approved plan covers the file, if any. */
function coveringTask(store: StateStore, repoRoot: string, file: string): Task | null {
  const insensitive = process.platform === 'win32';
  for (const task of store.snapshot().tasks) {
    if (!WORK_STATES.has(task.state)) continue;
    // Its own repository, or another one of its plan, with that repository's scope.
    const repository = taskRepository(task, repoRoot, process.platform);
    if (repository === null) continue;
    if (store.planDecision(task.taskId)?.decision !== 'APPROVED') continue;
    if (matchesAnyGlob(file, repository.scope, insensitive)) return task;
  }
  return null;
}

/** Whether the plan names the file in a step or change (not only through a scope glob). */
function planNames(task: Task, file: string): boolean {
  const document = task.plan.document;
  if (document === undefined) return false;
  const key = (value: string): string => value.trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const target = key(file);
  const named = [...document.steps.flatMap((step) => step.files), ...document.changes.map((change) => change.target)].map(key);
  return named.some((entry) => entry === target || (entry.endsWith('/') && target.startsWith(entry)) || (!/\.\w+$/.test(entry) && target.startsWith(`${entry}/`)));
}
