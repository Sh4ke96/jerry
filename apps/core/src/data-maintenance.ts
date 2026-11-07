import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_CATEGORIES,
  type DataCategory,
  type DataUsage,
  type ForgetPreview,
  type ForgetResult,
  type PruneOptions,
  type PrunePreview,
  type PruneResult,
  type WorkflowState,
} from '@jerry/contracts';
import { listBackups, type JerryDatabase } from '@jerry/database';
import { comparablePath, isComparableInside } from '@jerry/policy-engine';
import { isTerminal } from '@jerry/workflow';
import { StateError, type StateStore } from './state-store.js';

/**
 * What JERRY stores, and deleting old data on the user's request. Every deletion is previewed the
 * same way it runs: the preview performs the deletion inside a transaction and rolls it back, so the
 * numbers the user confirms are the numbers that get deleted. A real deletion first backs up the
 * database, deletes in one transaction, then compacts the file (VACUUM) and writes an audit row.
 */

type Raw = JerryDatabase['raw'];
type Param = string | number | null;

/** One DELETE: rows of `table` matching `where`. */
interface Step {
  table: string;
  where: string;
  params: Param[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which category each table counts under in the usage report; tables not listed are "system". */
const TABLE_CATEGORY: Readonly<Record<string, DataCategory>> = {
  tasks: 'tasks',
  plans: 'tasks',
  approvals: 'tasks',
  workflow_transitions: 'tasks',
  implementation_reports: 'tasks',
  task_completion_checks: 'tasks',
  task_checkpoints: 'tasks',
  session_tasks: 'tasks',
  artifact_decisions: 'tasks',
  implementer_assignments: 'tasks',
  analysis_reports: 'analysis',
  agent_runs: 'analysis',
  review_rounds: 'review',
  review_submissions: 'review',
  review_finding_sources: 'review',
  findings: 'quality',
  finding_events: 'quality',
  quality_batches: 'quality',
  test_runs: 'quality',
  hook_events: 'events',
  // Claude usage is kept, and deleted, like events.
  usage_tokens: 'events',
  usage_snapshots: 'events',
  usage_limits: 'events',
  usage_jerry_share: 'events',
  sessions: 'sessions',
  git_snapshots: 'git',
  projects: 'projects',
  repositories: 'projects',
  project_profiles: 'projects',
  eval_runs: 'evals',
  eval_baselines: 'evals',
  eval_labels: 'evals',
};

/** Tables whose rows belong to a task through their task_id column, deleted with the task. */
const TASK_TABLES = [
  'plan_repositories',
  'approvals',
  'workflow_transitions',
  'session_tasks',
  'task_checkpoints',
  'implementation_reports',
  'task_completion_checks',
  'git_snapshots',
  'analysis_reports',
  'quality_batches',
  'test_runs',
  'implementer_assignments',
  'review_rounds',
  'review_submissions',
  'artifact_decisions',
  'hook_events',
] as const;

/** Task rows that name a subagent run; a run still named by one of them is kept. */
const AGENT_REFERENCES = ['analysis_reports', 'review_submissions', 'implementer_assignments', 'findings', 'test_runs'] as const;
const AGENT_STILL_REFERENCED = AGENT_REFERENCES.map((table) => `SELECT agent_id FROM ${table} WHERE agent_id IS NOT NULL`).join(' UNION ');

const IN_JSON = 'IN (SELECT value FROM json_each(?))';

export interface DataContext {
  store: StateStore;
  logsDir: string;
  retentionDays: number;
}

// --- Usage ------------------------------------------------------------------------------------

export async function dataUsage(context: DataContext, now: Date): Promise<DataUsage> {
  const { store } = context;
  const { tables, eventsByRepo, repositories } = await store.exclusive((raw) => {
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    // dbstat: bytes per table and index, as SQLite stores them; indexes count toward their table.
    const owner = new Map((raw.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string; tbl_name: string }>).map((row) => [row.name, row.tbl_name]));
    const bytes = new Map<string, number>();
    for (const row of raw.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all() as Array<{ name: string; bytes: number }>) {
      const table = owner.get(row.name) ?? row.name;
      bytes.set(table, (bytes.get(table) ?? 0) + Number(row.bytes));
    }
    const tables = names.map((name) => ({ table: name, rows: Number((raw.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count), bytes: bytes.get(name) ?? 0 }));
    const eventsByRepo = raw.prepare('SELECT repo_root, COUNT(*) AS count FROM hook_events WHERE repo_root IS NOT NULL GROUP BY repo_root').all() as Array<{ repo_root: string; count: number }>;
    const repositories = (raw.prepare('SELECT root_path FROM repositories ORDER BY root_path').all() as Array<{ root_path: string }>).map((row) => row.root_path);
    return { tables, eventsByRepo, repositories };
  });

  const categories = DATA_CATEGORIES.map((category) => {
    const own = tables.filter((table) => (TABLE_CATEGORY[table.table] ?? 'system') === category);
    return { category, rows: own.reduce((sum, table) => sum + table.rows, 0), bytes: own.reduce((sum, table) => sum + table.bytes, 0), tables: own };
  });

  // Projects first, then every other repository JERRY still has data of.
  const snapshot = store.snapshot();
  const activity = await store.lastActivityByRepository();
  const roots: string[] = [];
  for (const root of [...store.projects().map((project) => project.repoRoot), ...repositories]) {
    if (!roots.some((known) => keyOf(known) === keyOf(root))) roots.push(root);
  }
  const projects = roots.map((repoRoot) => {
    const key = keyOf(repoRoot);
    const tasks = snapshot.tasks.filter((task) => isComparableInside(keyOf(task.repoRoot), key));
    return {
      repoRoot,
      project: store.isMonitored(repoRoot),
      tasks: tasks.length,
      openTasks: tasks.filter((task) => !isTerminal(task.state)).length,
      events: eventsByRepo.filter((row) => isComparableInside(keyOf(row.repo_root), key)).reduce((sum, row) => sum + Number(row.count), 0),
      lastActivityAt: [...activity.entries()].filter(([root]) => isComparableInside(root, key)).map(([, at]) => at).sort().at(-1) ?? null,
    };
  });

  const backups = listBackups(store.backupsDir);
  const backupBytes = backups.reduce((sum, backup) => sum + backup.size, 0);
  const databaseBytes = databaseFileBytes(store.databaseFile);
  const logsBytes = directoryBytes(context.logsDir);
  return {
    at: now.toISOString(),
    database: { file: store.databaseFile, bytes: databaseBytes },
    categories,
    projects,
    backups: { dir: store.backupsDir, count: backups.length, bytes: backupBytes, newestAt: backups.at(-1)?.modifiedAt ?? null },
    logs: { dir: context.logsDir, bytes: logsBytes },
    totalBytes: databaseBytes + backupBytes + logsBytes,
    retentionDays: context.retentionDays,
  };
}

// --- Prune ------------------------------------------------------------------------------------

export function hasPruneOptions(options: PruneOptions): boolean {
  return options.doneOlderThanDays !== undefined || options.eventsOlderThanDays !== undefined || options.evalsOlderThanDays !== undefined || options.backupsKeep !== undefined;
}

interface PrunePlan {
  cutoffs: PrunePreview['cutoffs'];
  tasks: string[];
  steps: Step[];
  backups: Array<{ file: string; size: number }>;
}

function cutoff(now: Date, days: number | undefined): string | null {
  return days === undefined ? null : new Date(now.getTime() - days * DAY_MS).toISOString();
}

function planPrune(raw: Raw, store: StateStore, options: PruneOptions, now: Date): PrunePlan {
  const cutoffs = { done: cutoff(now, options.doneOlderThanDays), events: cutoff(now, options.eventsOlderThanDays), evals: cutoff(now, options.evalsOlderThanDays) };
  const steps: Step[] = [];
  let tasks: string[] = [];
  if (cutoffs.done !== null) {
    tasks = (raw.prepare("SELECT task_id FROM tasks WHERE state IN ('DONE', 'CANCELLED') AND updated_at < ? ORDER BY task_id").all(cutoffs.done) as Array<{ task_id: string }>).map((row) => row.task_id);
    steps.push(...taskSteps(raw, tasks));
  }
  if (cutoffs.events !== null) {
    steps.push(
      { table: 'hook_events', where: 'occurred_at < ?', params: [cutoffs.events] },
      { table: 'sessions', where: 'last_seen_at < ?', params: [cutoffs.events] },
      { table: 'agent_runs', where: `started_at < ? AND agent_id NOT IN (${AGENT_STILL_REFERENCED})`, params: [cutoffs.events] },
      // Batches and test runs not tied to a task are telemetry like events.
      { table: 'quality_batches', where: 'started_at < ? AND task_id IS NULL', params: [cutoffs.events] },
      { table: 'test_runs', where: 'at < ? AND task_id IS NULL', params: [cutoffs.events] },
      // Claude usage, like events.
      { table: 'usage_tokens', where: 'bucket_minute < ?', params: [cutoffs.events] },
      { table: 'usage_snapshots', where: 'at < ?', params: [cutoffs.events] },
      { table: 'usage_limits', where: 'at < ?', params: [cutoffs.events] },
      { table: 'usage_jerry_share', where: 'bucket_minute < ?', params: [cutoffs.events] },
    );
  }
  if (cutoffs.evals !== null) {
    // A run that was ever a baseline stays: the baseline history refers to it.
    const runs = 'SELECT id FROM eval_runs WHERE started_at < ? AND id NOT IN (SELECT run_id FROM eval_baselines)';
    steps.push({ table: 'eval_labels', where: `run_id IN (${runs})`, params: [cutoffs.evals] }, { table: 'eval_runs', where: `id IN (${runs})`, params: [cutoffs.evals] });
  }
  const backups = options.backupsKeep === undefined ? [] : listBackups(store.backupsDir).reverse().slice(options.backupsKeep).map((backup) => ({ file: backup.file, size: backup.size }));
  return { cutoffs, tasks, steps, backups };
}

/**
 * Every row tied to the given tasks, children before parents (foreign keys stay on). Subagent runs
 * named only by these rows go too; their IDs are taken before the rows that name them are deleted.
 */
function taskSteps(raw: Raw, taskIds: readonly string[]): Step[] {
  if (taskIds.length === 0) return [];
  const ids = JSON.stringify(taskIds);
  const agents = new Set<string>();
  for (const table of AGENT_REFERENCES) {
    for (const row of raw.prepare(`SELECT DISTINCT agent_id FROM ${table} WHERE agent_id IS NOT NULL AND task_id ${IN_JSON}`).all(ids) as Array<{ agent_id: string }>) agents.add(row.agent_id);
  }
  const findings = `SELECT id FROM findings WHERE task_id ${IN_JSON}`;
  return [
    { table: 'finding_events', where: `finding_id IN (${findings})`, params: [ids] },
    { table: 'review_finding_sources', where: `finding_id IN (${findings}) OR task_id ${IN_JSON}`, params: [ids, ids] },
    { table: 'findings', where: `task_id ${IN_JSON}`, params: [ids] },
    ...TASK_TABLES.map((table) => ({ table, where: `task_id ${IN_JSON}`, params: [ids] })),
    { table: 'audit_log', where: `subject ${IN_JSON}`, params: [ids] },
    { table: 'plans', where: `task_id ${IN_JSON}`, params: [ids] },
    { table: 'tasks', where: `task_id ${IN_JSON}`, params: [ids] },
    { table: 'agent_runs', where: `agent_id ${IN_JSON} AND agent_id NOT IN (${AGENT_STILL_REFERENCED})`, params: [JSON.stringify([...agents])] },
  ];
}

export async function previewPrune(context: DataContext, options: PruneOptions, now: Date): Promise<PrunePreview> {
  requireOptions(options);
  return context.store.exclusive((raw) => {
    const plan = planPrune(raw, context.store, options, now);
    return pruneSummary(options, plan, dryRun(raw, plan.steps));
  });
}

export async function prune(context: DataContext, options: PruneOptions, now: Date, channel: string): Promise<PruneResult> {
  requireOptions(options);
  const { store } = context;
  const before = databaseFileBytes(store.databaseFile);
  // Planned before the safety backup exists, so the backup just taken is never among the files deleted.
  const planned = await store.exclusive((raw) => planPrune(raw, store, options, now));
  const backupFile = await store.backup('pre-prune');
  const rows = await store.exclusive((raw) => {
    const plan = planPrune(raw, store, options, now);
    const deleted = commit(raw, plan.steps, (counts) => auditRow(raw, now, 'data.prune', { channel, options, tasks: plan.tasks.length, rows: counts, backups: planned.backups.length, backupFile }));
    compact(raw);
    return { deleted, plan };
  });
  for (const backup of planned.backups) {
    if (path.resolve(backup.file) !== path.resolve(backupFile)) fs.rmSync(backup.file, { force: true });
  }
  await store.refresh();
  const summary = pruneSummary(options, { ...rows.plan, backups: planned.backups }, rows.deleted);
  return { ...summary, at: now.toISOString(), backupFile, databaseBytesBefore: before, databaseBytesAfter: databaseFileBytes(store.databaseFile) };
}

function requireOptions(options: PruneOptions): void {
  if (!hasPruneOptions(options)) throw new StateError(400, 'Say what to delete: doneOlderThanDays, eventsOlderThanDays, evalsOlderThanDays or backupsKeep');
}

function pruneSummary(options: PruneOptions, plan: PrunePlan, rows: Record<string, number>): PrunePreview {
  return {
    options,
    cutoffs: plan.cutoffs,
    tasks: plan.tasks,
    rows,
    totalRows: Object.values(rows).reduce((sum, value) => sum + value, 0),
    backups: { count: plan.backups.length, bytes: plan.backups.reduce((sum, backup) => sum + backup.size, 0), files: plan.backups.map((backup) => backup.file) },
  };
}

// --- Forget -----------------------------------------------------------------------------------

interface ForgetPlan {
  repoRoot: string;
  project: boolean;
  tasks: string[];
  openTasks: string[];
  steps: Step[];
}

/**
 * Everything JERRY stores about the repository at or below `repoRoot`: its tasks with every row tied
 * to them, its sessions and events, findings, Git snapshots, profiles, the project entry and the
 * audit entries that name it.
 */
function planForget(raw: Raw, store: StateStore, repoRoot: string): ForgetPlan {
  registerPathFunctions(raw);
  const repos = (raw.prepare('SELECT repo_id FROM repositories WHERE jerry_inside(root_path, ?)').all(repoRoot) as Array<{ repo_id: string }>).map((row) => row.repo_id);
  const repoIds = JSON.stringify(repos);
  const tasks = raw.prepare(`SELECT task_id, state FROM tasks WHERE repo_id ${IN_JSON} ORDER BY task_id`).all(repoIds) as Array<{ task_id: string; state: string }>;
  // Open tasks of other repositories whose current plan also covers this one keep it too.
  const covering = raw
    .prepare(`SELECT DISTINCT t.task_id, t.state FROM plan_repositories p JOIN tasks t ON t.task_id = p.task_id AND t.current_plan_version = p.version WHERE p.repo_id ${IN_JSON} ORDER BY t.task_id`)
    .all(repoIds) as Array<{ task_id: string; state: string }>;
  const openTasks = [...new Set([...tasks, ...covering].filter((task) => !isTerminal(task.state as WorkflowState)).map((task) => task.task_id))].sort();
  const taskIds = tasks.map((task) => task.task_id);
  const findings = 'SELECT id FROM findings WHERE jerry_inside(repo_root, ?)';
  const sessions = 'SELECT session_id FROM sessions WHERE jerry_inside(cwd, ?)';
  const steps: Step[] = [
    ...taskSteps(raw, taskIds),
    { table: 'finding_events', where: `finding_id IN (${findings})`, params: [repoRoot] },
    { table: 'review_finding_sources', where: `finding_id IN (${findings})`, params: [repoRoot] },
    { table: 'findings', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    { table: 'hook_events', where: 'jerry_inside(repo_root, ?) OR jerry_inside(cwd, ?) OR jerry_mentions(payload_json, ?)', params: [repoRoot, repoRoot, repoRoot] },
    { table: 'agent_runs', where: `session_id IN (${sessions}) AND agent_id NOT IN (${AGENT_STILL_REFERENCED})`, params: [repoRoot] },
    { table: 'sessions', where: 'jerry_inside(cwd, ?)', params: [repoRoot] },
    { table: 'quality_batches', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    { table: 'test_runs', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    { table: 'git_snapshots', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    // Claude usage of its sessions (plan limits name no repository and stay).
    { table: 'usage_tokens', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    { table: 'usage_snapshots', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    { table: 'usage_jerry_share', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    { table: 'project_profiles', where: `repo_id ${IN_JSON}`, params: [repoIds] },
    // Finished tasks of other repositories that also covered this one forget it.
    { table: 'plan_repositories', where: `repo_id ${IN_JSON}`, params: [repoIds] },
    { table: 'projects', where: 'jerry_inside(repo_root, ?)', params: [repoRoot] },
    { table: 'repositories', where: `repo_id ${IN_JSON}`, params: [repoIds] },
    { table: 'audit_log', where: 'jerry_inside(subject, ?) OR jerry_mentions(details_json, ?)', params: [repoRoot, repoRoot] },
  ];
  return { repoRoot, project: store.isMonitored(repoRoot), tasks: taskIds, openTasks, steps };
}

export async function previewForget(context: DataContext, repoRoot: string): Promise<ForgetPreview> {
  return context.store.exclusive((raw) => {
    const plan = planForget(raw, context.store, repoRoot);
    return forgetSummary(plan, dryRun(raw, plan.steps));
  });
}

export async function forget(context: DataContext, repoRoot: string, now: Date, channel: string): Promise<ForgetResult> {
  const { store } = context;
  const preview = await previewForget(context, repoRoot);
  refuseOpenTasks(preview);
  const before = databaseFileBytes(store.databaseFile);
  const backupFile = await store.backup('pre-forget');
  const result = await store.exclusive((raw) => {
    const plan = planForget(raw, store, repoRoot);
    refuseOpenTasks(plan);
    // The audit row names nothing of the repository: forgetting it is the point.
    const deleted = commit(raw, plan.steps, (counts) => auditRow(raw, now, 'data.forget', { channel, tasks: plan.tasks.length, rows: Object.values(counts).reduce((sum, value) => sum + value, 0), backupFile }));
    compact(raw);
    return forgetSummary(plan, deleted);
  });
  await store.refresh();
  return { ...result, at: now.toISOString(), backupFile, databaseBytesBefore: before, databaseBytesAfter: databaseFileBytes(store.databaseFile) };
}

function refuseOpenTasks(plan: { repoRoot: string; openTasks: readonly string[] }): void {
  if (plan.openTasks.length > 0) {
    throw new StateError(409, `${plan.repoRoot} has open tasks (${plan.openTasks.join(', ')}); finish or cancel them before JERRY forgets the repository`);
  }
}

function forgetSummary(plan: ForgetPlan, rows: Record<string, number>): ForgetPreview {
  return { repoRoot: plan.repoRoot, project: plan.project, tasks: plan.tasks, openTasks: plan.openTasks, rows, totalRows: Object.values(rows).reduce((sum, value) => sum + value, 0) };
}

// --- Running the steps ------------------------------------------------------------------------

function runSteps(raw: Raw, steps: readonly Step[]): Record<string, number> {
  const rows: Record<string, number> = {};
  for (const step of steps) {
    const changes = Number(raw.prepare(`DELETE FROM ${step.table} WHERE ${step.where}`).run(...step.params).changes);
    if (changes > 0) rows[step.table] = (rows[step.table] ?? 0) + changes;
  }
  return rows;
}

/** The deletion as it would run, rolled back: exact counts, nothing deleted. */
function dryRun(raw: Raw, steps: readonly Step[]): Record<string, number> {
  raw.exec('BEGIN IMMEDIATE');
  try {
    return runSteps(raw, steps);
  } finally {
    raw.exec('ROLLBACK');
  }
}

/** All steps and the audit row in one transaction: everything is deleted, or nothing. */
function commit(raw: Raw, steps: readonly Step[], audit: (rows: Record<string, number>) => void): Record<string, number> {
  raw.exec('BEGIN IMMEDIATE');
  try {
    const rows = runSteps(raw, steps);
    audit(rows);
    raw.exec('COMMIT');
    return rows;
  } catch (error) {
    raw.exec('ROLLBACK');
    throw error;
  }
}

function auditRow(raw: Raw, now: Date, action: string, details: Record<string, unknown>): void {
  const at = now.toISOString();
  raw.prepare("INSERT INTO audit_log (at, actor, action, subject, details_json, created_at) VALUES (?, 'local-user', ?, NULL, ?, ?)").run(at, action, JSON.stringify(details), at);
}

/** Gives the freed pages back to the file system; outside any transaction, as VACUUM requires. */
function compact(raw: Raw): void {
  raw.exec('VACUUM');
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

// --- Paths in SQL -----------------------------------------------------------------------------

const registered = new WeakSet<object>();

function keyOf(target: string): string {
  return comparablePath(target, target, process.platform);
}

function isAbsoluteAnywhere(value: string): boolean {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

/** True when `text` names `root` or a path below it (as a whole path, not a prefix of another name). */
export function mentionsPath(text: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalize = (value: string): string => {
    const forward = value.replaceAll('\\\\', '/').replaceAll('\\', '/');
    return platform === 'win32' ? forward.toLowerCase() : forward;
  };
  const haystack = normalize(text);
  const needle = comparablePath(root, root, platform);
  const pathChar = /[\w.\-/]/;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    const before = index === 0 ? '' : haystack[index - 1]!;
    const after = haystack[index + needle.length] ?? '';
    if ((before === '' || !pathChar.test(before)) && (after === '' || after === '/' || !pathChar.test(after))) return true;
  }
  return false;
}

/**
 * jerry_inside(value, root): the value is an absolute path at or below root (Windows: any case and
 * separator). jerry_mentions(text, root): the text names root or a path below it.
 */
function registerPathFunctions(raw: Raw): void {
  if (registered.has(raw)) return;
  raw.function('jerry_inside', { deterministic: true }, (value: unknown, root: unknown) =>
    typeof value === 'string' && typeof root === 'string' && isAbsoluteAnywhere(value) && isComparableInside(keyOf(value), keyOf(root)) ? 1 : 0,
  );
  raw.function('jerry_mentions', { deterministic: true }, (text: unknown, root: unknown) => (typeof text === 'string' && typeof root === 'string' && mentionsPath(text, root) ? 1 : 0));
  registered.add(raw);
}

// --- Files ------------------------------------------------------------------------------------

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The database with its write-ahead log and shared-memory file. */
function databaseFileBytes(file: string): number {
  return fileBytes(file) + fileBytes(`${file}-wal`) + fileBytes(`${file}-shm`);
}

function directoryBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directoryBytes(full) : fileBytes(full);
  }
  return total;
}
