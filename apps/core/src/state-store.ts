import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  coreStateSchema,
  storedEventSchema,
  type ApprovalRecord,
  type ApprovalRequest,
  type CallOrigin,
  type Checkpoint,
  type CoreState,
  type CompletionCheck,
  type AgentRun,
  type AnalysisReport,
  type AnalysisReportRecord,
  analysisReportRecordSchema,
  type ProjectProfile,
  projectProfileSchema,
  type TaskDetail,
  type ImplementationReport,
  type ImplementationReportRecord,
  type ReportEvidence,
  approvalRecordSchema,
  completionCheckSchema,
  implementationReportRecordSchema,
  type TaskActivity,
  type TaskSession,
  type EventEnvelope,
  type SessionRegistration,
  type StoredEvent,
  type PlanDocument,
  type Task,
  type WorkflowActor,
  type WorkflowEvent,
  type WorkflowState,
  type WorkflowTransition,
  taskSchema,
  workflowStateSchema,
  workflowTransitionSchema,
} from '@jerry/contracts';
import { backupDatabase, openJerryDatabase, type JerryDatabase, type JerrySchema } from '@jerry/database';
import { absolutePath, comparablePath, computePlanHash, computeReportHash, currentPlanDecision, decisionFor, matchesAnyGlob, relativeInside } from '@jerry/policy-engine';
import { applyEvent, evaluateCompletion, isTerminal } from '@jerry/workflow';
import type { ProfileFingerprints } from '@jerry/discovery';
import { fingerprintFiles, gitReader, type GitReader, type GitSnapshot } from './git-reader.js';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';

/** Sessions kept in the in-memory snapshot; older ones stay in the database. */
const SNAPSHOT_SESSIONS = 200;
const NEXT_TASK_NUMBER = 'next_task_number';

/** Where a user decision came from; recorded in the audit log. */
export type Channel = 'cli' | 'dashboard';

/** What a session last did for a task. */
export type SessionActivity = 'plan.submitted' | 'plan.revised' | 'edit' | 'checkpoint' | 'report' | 'analysis';

/** A subagent run without SubagentStop after this long is timed-out; also the window for counting active ones. */
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Tools whose target path JERRY sees, so their edits count as observed. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Deviations listed in a report's evidence; the count covers all of them. */
const MAX_EVIDENCE_DEVIATIONS = 50;

/** User decisions about a whole task (approvals and plans have their own methods). */
export type TaskControlEvent = Extract<WorkflowEvent, 'task.paused' | 'task.resumed' | 'task.cancelled'>;

/** The M0 JSON state predates workflow states; its tasks get theirs from their approvals on import. */
const legacyStateSchema = coreStateSchema.extend({ tasks: z.array(taskSchema.omit({ state: true })) });

export class StateError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'StateError';
  }
}

export interface StateStoreOptions {
  databaseFile: string;
  backupsDir: string;
  /** M0 JSON state; imported once into an empty database, then renamed. */
  legacyStateFile: string;
  /** Read-only Git access (ADR 0017); tests may replace it. */
  git?: GitReader;
}

/** When a Git baseline is taken. */
export type SnapshotKind = 'plan.approved' | 'report' | 'checkpoint';

interface StoredSnapshot {
  head: string | null;
  fingerprints: Record<string, string>;
  createdAt: string;
}

/** A Git reading taken before a transaction (Git runs as a process; transactions stay short). */
interface PreparedSnapshot {
  snapshot: GitSnapshot | null;
  error: string | null;
  fingerprints: Record<string, string>;
  /** Files changed since the plan baseline (report and checkpoint snapshots). */
  changed: string[];
}

/**
 * JERRY state in SQLite (ADR 0005). Gate checks read an in-memory snapshot, so they never wait for
 * the database; every mutation is one transaction followed by a snapshot reload. Core is the only
 * writer, so the snapshot cannot go stale.
 */
export class StateStore {
  private state: CoreState = emptyState();
  private sessionTotal = 0;
  /** Per task: files with the user's uncommitted changes when its plan was approved (comparable keys). */
  private userDirty = new Map<string, Set<string>>();
  /** (task, file) pairs Claude was already warned about; one warning per file and task. */
  private readonly userFileWarnings = new Set<string>();

  private constructor(
    private readonly database: JerryDatabase,
    private readonly git: GitReader,
  ) {}

  static async open(options: StateStoreOptions): Promise<StateStore> {
    const database = await openJerryDatabase({ file: options.databaseFile, backupsDir: options.backupsDir });
    const store = new StateStore(database, options.git ?? gitReader);
    try {
      await store.importLegacyState(options.legacyStateFile);
      await store.reload();
    } catch (error) {
      await database.close();
      throw error;
    }
    return store;
  }

  get databaseFile(): string {
    return this.database.file;
  }

  get migration(): string | null {
    return this.database.migration;
  }

  get sessionCount(): number {
    return this.sessionTotal;
  }

  snapshot(): CoreState {
    return structuredClone(this.state);
  }

  planDecision(taskId: string): ApprovalRecord | null {
    return currentPlanDecision(this.requireTask(taskId), this.state.approvals);
  }

  async createTask(input: { repoRoot: string; title: string; scope: string[]; document?: PlanDocument; submittedBy?: 'user' | 'claude'; sessionId?: string | null }, now: Date): Promise<Task> {
    const at = now.toISOString();
    const taskId = await this.database.db.transaction().execute(async (trx) => {
      const repoId = await upsertRepository(trx, input.repoRoot, at);
      const setting = await trx.selectFrom('settings').select('value_json').where('key', '=', NEXT_TASK_NUMBER).executeTakeFirst();
      const number = setting === undefined ? 1 : Number(JSON.parse(setting.value_json));
      const id = `JRY-${String(number).padStart(4, '0')}`;
      const actor = input.submittedBy ?? 'user';
      const state = validTransition(id, null, 'plan.submitted', actor);
      await trx.insertInto('tasks').values({ task_id: id, title: input.title, repo_id: repoId, current_plan_version: 1, state, created_at: at, updated_at: at }).execute();
      await insertPlan(trx, { taskId: id, title: input.title, repoRoot: input.repoRoot, version: 1, scope: input.scope, document: input.document, at });
      await recordTransition(trx, { taskId: id, from: null, to: state, event: 'plan.submitted', actor, reason: 'plan version 1', at });
      if (input.sessionId != null) await linkSession(trx, input.sessionId, id, 'plan.submitted', at);
      await trx
        .insertInto('settings')
        .values({ key: NEXT_TASK_NUMBER, value_json: JSON.stringify(number + 1), created_at: at, updated_at: at })
        .onConflict((conflict) => conflict.column('key').doUpdateSet({ value_json: JSON.stringify(number + 1), updated_at: at }))
        .execute();
      await audit(trx, at, 'task.create', id, { repoRoot: input.repoRoot, scope: input.scope, withDocument: input.document !== undefined }, actorOf(input.submittedBy));
      return id;
    });
    await this.reload();
    return this.requireTask(taskId);
  }

  /** Creates the next plan version. Earlier versions and their approvals stay in history but no longer match. */
  async revisePlan(taskId: string, scope: string[], now: Date, document?: PlanDocument, submittedBy: 'user' | 'claude' = 'user', sessionId: string | null = null): Promise<Task> {
    const task = this.requireTask(taskId);
    const at = now.toISOString();
    const version = task.plan.version + 1;
    await this.database.db.transaction().execute(async (trx) => {
      await this.transition(trx, taskId, 'plan.revised', submittedBy, `plan version ${version}`, at);
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'plan.revised', at);
      await insertPlan(trx, { taskId, title: task.title, repoRoot: task.repoRoot, version, scope, document, at });
      await trx.updateTable('tasks').set({ current_plan_version: version, updated_at: at }).where('task_id', '=', taskId).execute();
      await audit(trx, at, 'plan.revise', taskId, { version, scope, withDocument: document !== undefined }, actorOf(submittedBy));
    });
    await this.reload();
    return this.requireTask(taskId);
  }

  /**
   * A user decision bound to exactly what the user saw: the current plan (stage PLAN) or the latest
   * implementation report (stage IMPLEMENTATION), by version and hash.
   */
  async recordApproval(taskId: string, request: ApprovalRequest, now: Date, channel: Channel = 'cli'): Promise<ApprovalRecord> {
    const task = this.requireTask(taskId);
    const at = now.toISOString();
    // Git is read before the transaction: a plan approval takes the baseline (the user's uncommitted
    // work at that moment); an acceptance compares the repository with the report's snapshot.
    const approvingPlan = request.stage === 'PLAN' && request.decision === 'APPROVED';
    const accepting = request.stage === 'IMPLEMENTATION' && request.decision === 'APPROVED';
    const gitNow = approvingPlan ? await this.prepareSnapshot(task, 'plan.approved') : accepting ? await this.prepareSnapshot(task, 'report') : null;
    const record = await this.database.db.transaction().execute(async (trx) => {
      const label = request.stage === 'PLAN' ? 'plan' : 'implementation report';
      const subject = request.stage === 'PLAN' ? { version: task.plan.version, contentHash: task.plan.contentHash } : await latestReportSubject(trx, taskId);
      if (subject === null) throw new StateError(409, `${taskId} has no implementation report to decide on`);
      if (request.version !== subject.version) {
        throw new StateError(409, `${taskId} ${label} is at version ${subject.version}; refusing a decision for version ${request.version}`);
      }
      const record: ApprovalRecord = {
        approvalId: `apr_${randomUUID()}`,
        taskId,
        stage: request.stage,
        version: subject.version,
        contentHash: subject.contentHash,
        decision: request.decision,
        approvedBy: 'local-user',
        approvedAt: at,
        comment: request.comment,
      };
      const event: WorkflowEvent =
        request.stage === 'PLAN' ? (record.decision === 'APPROVED' ? 'plan.approved' : 'plan.rejected') : record.decision === 'APPROVED' ? 'implementation.accepted' : 'changes.requested';
      await this.transition(trx, taskId, event, 'user', record.comment === '' ? `${label} version ${record.version}` : record.comment, at);
      await trx
        .insertInto('approvals')
        .values({
          approval_id: record.approvalId,
          task_id: taskId,
          stage: record.stage,
          version: record.version,
          content_hash: record.contentHash,
          decision: record.decision,
          approved_by: record.approvedBy,
          approved_at: at,
          comment: record.comment,
          created_at: at,
        })
        .execute();
      await audit(trx, at, `approval.${record.decision.toLowerCase()}`, taskId, { stage: record.stage, version: record.version, contentHash: record.contentHash, channel });
      if (event === 'plan.approved' && gitNow !== null) await insertSnapshot(trx, task, 'plan.approved', gitNow, at);
      // Accepting the implementation hands the task to Core's final checks, in the same transaction.
      if (event === 'implementation.accepted') await this.runFinalChecks(trx, task, at, gitNow);
      return record;
    });
    await this.reload();
    return record;
  }

  /**
   * Reads Git for a task's repository (ADR 0017). Never throws: when Git cannot be read the reason
   * is kept, and checks that depend on Git say so instead of guessing.
   */
  private async prepareSnapshot(task: Task, kind: SnapshotKind): Promise<PreparedSnapshot> {
    try {
      const snapshot = await this.git.snapshot(task.repoRoot);
      if (kind === 'plan.approved') {
        const dirty = [...new Set([...snapshot.staged, ...snapshot.unstaged, ...snapshot.untracked])];
        return { snapshot, error: null, fingerprints: fingerprintFiles(task.repoRoot, dirty), changed: dirty };
      }
      const baseline = await latestSnapshot(this.database.db, task.taskId, 'plan.approved');
      const changed = await this.git.changedSince(task.repoRoot, baseline?.head ?? snapshot.head);
      return { snapshot, error: null, fingerprints: fingerprintFiles(task.repoRoot, changed), changed };
    } catch (error) {
      return { snapshot: null, error: error instanceof Error ? error.message : String(error), fingerprints: {}, changed: [] };
    }
  }

  /**
   * True when a file had the user's uncommitted changes when the task's plan was approved and
   * Claude has not been warned about it yet (ADR 0017). Pure lookup: previews do not use it up.
   */
  isUserChangedFile(taskId: string, relativePath: string): boolean {
    const key = fileKey(relativePath);
    return this.userDirty.get(taskId)?.has(key) === true && !this.userFileWarnings.has(`${taskId}|${key}`);
  }

  /** Called once the warning was recorded for a real edit. */
  markUserFileWarned(taskId: string, relativePath: string): void {
    this.userFileWarnings.add(`${taskId}|${fileKey(relativePath)}`);
  }

  /** The Git baseline of the task's latest plan approval, as task details show it. */
  async taskBaseline(taskId: string): Promise<TaskDetail['baseline']> {
    const row = await this.database.db.selectFrom('git_snapshots').selectAll().where('task_id', '=', taskId).where('kind', '=', 'plan.approved').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (row === undefined) return null;
    const userFiles = [...new Set([...(JSON.parse(row.staged_json) as string[]), ...(JSON.parse(row.unstaged_json) as string[]), ...(JSON.parse(row.untracked_json) as string[])])].sort();
    return { at: row.created_at, head: row.head, branch: row.branch, upstream: row.upstream, remoteUrl: row.remote_url, userFiles, truncated: row.truncated === 1, error: row.error };
  }

  /** What changed in the repository since the task's last checkpoint, if one was taken. */
  async changesSinceCheckpoint(task: Task, budgetMs = 700): Promise<{ headBefore: string | null; headNow: string | null; changedFiles: number } | null> {
    const checkpoint = await latestSnapshot(this.database.db, task.taskId, 'checkpoint');
    if (checkpoint === null) return null;
    const now = await Promise.race([this.prepareSnapshot(task, 'checkpoint'), new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs))]);
    if (now === null || now.snapshot === null) return null;
    const files = new Set([...Object.keys(checkpoint.fingerprints), ...Object.keys(now.fingerprints)]);
    const changedFiles = [...files].filter((file) => checkpoint.fingerprints[file] !== now.fingerprints[file]).length;
    return { headBefore: checkpoint.head, headNow: now.snapshot.head, changedFiles };
  }

  /**
   * The DONE validator (ADR 0016): Core gathers the facts, records the result, and sets DONE only
   * when every blocking condition passed. No model and no API call can set DONE otherwise.
   */
  private async runFinalChecks(trx: Transaction<JerrySchema>, task: Task, at: string, gitNow: PreparedSnapshot | null): Promise<CompletionCheck> {
    const reportRow = await trx.selectFrom('implementation_reports').selectAll().where('task_id', '=', task.taskId).orderBy('version', 'desc').limit(1).executeTakeFirst();
    const report = reportRow === undefined ? null : reportFromRow(reportRow);
    // Edits after the report: seen by the hooks (file tools), and by Git (also shell commands).
    const hookEdits = report === null ? [] : await editsInScopeBetween(trx, task, report.createdAt, at);
    const reportSnapshot = await latestSnapshot(trx, task.taskId, 'report');
    const gitEdits = report === null || reportSnapshot === null || gitNow === null || gitNow.snapshot === null ? [] : changedInScope(task, reportSnapshot.fingerprints, gitNow.fingerprints);
    const decisions = await trx.selectFrom('approvals').selectAll().where('task_id', '=', task.taskId).orderBy('approved_at').orderBy(sql`rowid`).execute();
    const approvals = decisions.map((row) => approvalRecordSchema.parse({ approvalId: row.approval_id, taskId: row.task_id, stage: row.stage, version: row.version, contentHash: row.content_hash, decision: row.decision, approvedBy: row.approved_by, approvedAt: row.approved_at, comment: row.comment }));
    const result = evaluateCompletion({
      currentPlanVersion: task.plan.version,
      planApproved: currentPlanDecision(task, approvals)?.decision === 'APPROVED',
      report,
      reportAccepted: report !== null && decisionFor(approvals, { taskId: task.taskId, stage: 'IMPLEMENTATION', version: report.version, contentHash: report.contentHash })?.decision === 'APPROVED',
      editsSinceReport: [...new Set([...hookEdits, ...gitEdits])].sort(),
      definitionOfDone: task.plan.document?.definitionOfDone ?? [],
    });
    const check: CompletionCheck = { taskId: task.taskId, reportVersion: report?.version ?? null, at, passed: result.passed, conditions: result.conditions, definitionOfDone: task.plan.document?.definitionOfDone ?? [] };
    await trx
      .insertInto('task_completion_checks')
      .values({ task_id: task.taskId, report_version: check.reportVersion, passed: check.passed ? 1 : 0, conditions_json: JSON.stringify(check.conditions), definition_of_done_json: JSON.stringify(check.definitionOfDone), created_at: at })
      .execute();
    const blocking = check.conditions.filter((condition) => condition.blocking && !condition.passed).map((condition) => condition.id);
    if (check.passed) {
      await this.transition(trx, task.taskId, 'task.completed', 'core', `final checks passed (report v${check.reportVersion})`, at);
    }
    await audit(trx, at, check.passed ? 'task.complete' : 'task.final-checks-failed', task.taskId, { reportVersion: check.reportVersion, blocking }, 'jerry-core');
    return check;
  }

  /** The latest final checks of every task that had any. */
  async latestCompletionChecks(): Promise<Map<string, CompletionCheck>> {
    const rows = await this.database.db
      .selectFrom('task_completion_checks as c')
      .selectAll()
      .where('c.id', '=', (eb) => eb.selectFrom('task_completion_checks as latest').select((inner) => inner.fn.max('latest.id').as('id')).whereRef('latest.task_id', '=', 'c.task_id'))
      .execute();
    return new Map(
      rows.map((row) => [
        row.task_id,
        completionCheckSchema.parse({ taskId: row.task_id, reportVersion: row.report_version, at: row.created_at, passed: row.passed === 1, conditions: JSON.parse(row.conditions_json), definitionOfDone: JSON.parse(row.definition_of_done_json) }),
      ]),
    );
  }

  /**
   * Claude's implementation report (ADR 0014): the next report version, with what JERRY recorded
   * itself since the plan was approved. Only a task in implementation can report.
   */
  async submitReport(taskId: string, document: ImplementationReport, submittedBy: 'user' | 'claude', sessionId: string | null, now: Date): Promise<ImplementationReportRecord> {
    const task = this.requireTask(taskId);
    const at = now.toISOString();
    const gitNow = await this.prepareSnapshot(task, 'report');
    const record = await this.database.db.transaction().execute(async (trx) => {
      const previous = await latestReportSubject(trx, taskId);
      const version = (previous?.version ?? 0) + 1;
      await this.transition(trx, taskId, 'report.submitted', submittedBy, `implementation report version ${version}`, at);
      const baseline = await latestSnapshot(trx, taskId, 'plan.approved');
      const evidence = await collectEvidence(trx, task, document, at, gitEvidence(baseline, gitNow));
      await insertSnapshot(trx, task, 'report', gitNow, at);
      const record: ImplementationReportRecord = {
        taskId,
        version,
        planVersion: task.plan.version,
        contentHash: computeReportHash({ taskId, version, planVersion: task.plan.version, document }),
        document,
        evidence,
        submittedBy,
        sessionId,
        createdAt: at,
      };
      await trx
        .insertInto('implementation_reports')
        .values({
          task_id: taskId,
          version,
          plan_version: record.planVersion,
          content_hash: record.contentHash,
          document_json: JSON.stringify(document),
          evidence_json: JSON.stringify(evidence),
          submitted_by: submittedBy,
          session_id: sessionId,
          created_at: at,
        })
        .execute();
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'report', at);
      await audit(trx, at, 'report.submit', taskId, { version, contentHash: record.contentHash, deviations: evidence.deviationCount, unreportedEdits: evidence.unreportedEdits.length }, actorOf(submittedBy));
      return record;
    });
    await this.reload();
    return record;
  }

  /** The latest report of every task that has one. */
  async latestReports(): Promise<Map<string, ImplementationReportRecord>> {
    const rows = await this.database.db
      .selectFrom('implementation_reports as r')
      .selectAll()
      .where('r.version', '=', (eb) => eb.selectFrom('implementation_reports as latest').select((inner) => inner.fn.max('latest.version').as('version')).whereRef('latest.task_id', '=', 'r.task_id'))
      .execute();
    return new Map(rows.map((row) => [row.task_id, reportFromRow(row)]));
  }

  /** Every report version of a task, newest first. */
  async reportsOf(taskId: string): Promise<ImplementationReportRecord[]> {
    this.requireTask(taskId);
    const rows = await this.database.db.selectFrom('implementation_reports').selectAll().where('task_id', '=', taskId).orderBy('version', 'desc').execute();
    return rows.map(reportFromRow);
  }

  /** The user's decision on exactly this report version and hash. */
  reportDecision(report: ImplementationReportRecord): ApprovalRecord | null {
    return decisionFor(this.state.approvals, { taskId: report.taskId, stage: 'IMPLEMENTATION', version: report.version, contentHash: report.contentHash });
  }

  /** Pause, resume or cancel a task; only the user does this (CLI or dashboard). */
  async controlTask(taskId: string, event: TaskControlEvent, reason: string, now: Date, channel: Channel = 'cli'): Promise<Task> {
    this.requireTask(taskId);
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      const to = await this.transition(trx, taskId, event, 'user', reason, at);
      await audit(trx, at, event, taskId, { to, reason, channel });
    });
    await this.reload();
    return this.requireTask(taskId);
  }

  /** The task's history, oldest first. */
  async listTransitions(taskId: string): Promise<WorkflowTransition[]> {
    this.requireTask(taskId);
    const rows = await this.database.db.selectFrom('workflow_transitions').selectAll().where('task_id', '=', taskId).orderBy('id').execute();
    return rows.map((row) => workflowTransitionSchema.parse({ taskId: row.task_id, from: row.from_state, to: row.to_state, event: row.event, actor: row.actor, reason: row.reason, at: row.at }));
  }

  async registerSession(registration: SessionRegistration, now: Date): Promise<void> {
    const at = now.toISOString();
    await this.database.db
      .insertInto('sessions')
      .values({ session_id: registration.sessionId, cwd: registration.cwd, source: registration.source, first_seen_at: at, last_seen_at: at, created_at: at, updated_at: at })
      // A session that starts again (resume, compaction) is running again.
      .onConflict((conflict) => conflict.column('session_id').doUpdateSet({ cwd: registration.cwd, source: registration.source, last_seen_at: at, ended_at: null, end_reason: null, updated_at: at }))
      .execute();
    await this.reload();
  }

  /**
   * Records that a session worked on a task (ADR 0013). Unknown tasks are ignored: the link is
   * bookkeeping and must never fail the call that caused it.
   */
  async linkSession(sessionId: string, taskId: string, activity: SessionActivity, now: Date): Promise<void> {
    if (!this.state.tasks.some((task) => task.taskId === taskId)) return;
    await linkSession(this.database.db, sessionId, taskId, activity, now.toISOString());
  }

  /**
   * The session behind an MCP call: the PreToolUse event the hook recorded for the same tool use
   * (Claude Code passes the tool-use ID to MCP servers), else the session the MCP server reported.
   */
  async resolveOrigin(origin: CallOrigin | undefined): Promise<string | null> {
    if (origin === undefined) return null;
    if (origin.toolUseId !== undefined) {
      const row = await this.database.db
        .selectFrom('hook_events')
        .select('session_id')
        .where('tool_use_id', '=', origin.toolUseId)
        .where('event_type', '=', 'PreToolUse')
        .where('session_id', 'is not', null)
        .orderBy('occurred_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (row?.session_id != null) return row.session_id;
    }
    return origin.sessionId ?? null;
  }

  /** The subagent behind an MCP call: the agent ID the hook recorded for the same tool use. */
  async resolveAgent(origin: CallOrigin | undefined): Promise<string | null> {
    if (origin?.toolUseId === undefined) return null;
    const row = await this.database.db
      .selectFrom('hook_events')
      .select('agent_id')
      .where('tool_use_id', '=', origin.toolUseId)
      .where('event_type', '=', 'PreToolUse')
      .where('agent_id', 'is not', null)
      .limit(1)
      .executeTakeFirst();
    return row?.agent_id ?? null;
  }

  /** An analyst's report with Core's citation check (ADR 0023); open tasks only. */
  async saveAnalysisReport(
    taskId: string,
    report: AnalysisReport,
    citations: AnalysisReportRecord['citations'],
    sessionId: string | null,
    agentId: string | null,
    now: Date,
  ): Promise<AnalysisReportRecord> {
    const task = this.requireTask(taskId);
    if (isTerminal(task.state)) throw new StateError(409, `${taskId} is ${task.state}; analysis reports are for open tasks`);
    const at = now.toISOString();
    const id = await this.database.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('analysis_reports')
        .values({ task_id: taskId, role: report.role, agent_id: agentId, session_id: sessionId, report_json: JSON.stringify(report), citations_json: JSON.stringify(citations), created_at: at })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'analysis', at);
      return inserted.id;
    });
    return { id, taskId, report, citations, sessionId, agentId, createdAt: at };
  }

  async analysesOf(taskId: string): Promise<AnalysisReportRecord[]> {
    const rows = await this.database.db.selectFrom('analysis_reports').selectAll().where('task_id', '=', taskId).orderBy('id').execute();
    return rows.map((row) =>
      analysisReportRecordSchema.parse({ id: row.id, taskId: row.task_id, report: JSON.parse(row.report_json), citations: JSON.parse(row.citations_json), sessionId: row.session_id, agentId: row.agent_id, createdAt: row.created_at }),
    );
  }

  /**
   * Subagent runs of the sessions linked to a task. An analyst that stopped without a report is a
   * gap (no-report), never a success; a run without a stop after 30 minutes is timed-out.
   */
  async agentRunsOf(taskId: string, now: Date = new Date()): Promise<AgentRun[]> {
    const { db } = this.database;
    const rows = await db
      .selectFrom('agent_runs')
      .selectAll()
      .where('session_id', 'in', db.selectFrom('session_tasks').select('session_id').where('task_id', '=', taskId))
      .orderBy('started_at')
      .execute();
    const reports = await db.selectFrom('analysis_reports').select(['id', 'agent_id']).where('task_id', '=', taskId).where('agent_id', 'is not', null).execute();
    const reportOf = new Map(reports.map((report) => [report.agent_id!, report.id]));
    return rows.map((row) => {
      const reportId = reportOf.get(row.agent_id) ?? null;
      const analyst = (row.agent_type ?? '').includes('-analyst');
      let status: AgentRun['status'] = 'completed';
      if (row.stopped_at === null) status = now.getTime() - Date.parse(row.started_at) > SUBAGENT_TIMEOUT_MS ? 'timed-out' : 'running';
      else if (analyst && reportId === null) status = 'no-report';
      return { agentId: row.agent_id, agentType: row.agent_type, sessionId: row.session_id, startedAt: row.started_at, stoppedAt: row.stopped_at, status, reportId };
    });
  }

  /**
   * Subagents a session started in the last 30 minutes and has not finished, counted from the
   * hook's records (each Task/Agent call, minus each SubagentStop). Synchronous: the gate uses it.
   */
  activeSubagents(sessionId: string, now: Date = new Date()): number {
    const since = new Date(now.getTime() - SUBAGENT_TIMEOUT_MS).toISOString();
    const row = this.database.raw
      .prepare(
        "SELECT (SELECT COUNT(*) FROM hook_events WHERE session_id = ? AND event_type = 'PreToolUse' AND tool_name IN ('Task', 'Agent') AND (verdict IS NULL OR verdict != 'DENY') AND occurred_at >= ?) - (SELECT COUNT(*) FROM hook_events WHERE session_id = ? AND event_type = 'SubagentStop' AND occurred_at >= ?) AS active",
      )
      .get(sessionId, since, sessionId, since) as { active: number } | undefined;
    return Math.max(0, Number(row?.active ?? 0));
  }

  /** Claude's progress note; open tasks only. It changes no state. */
  async saveCheckpoint(taskId: string, note: { summary: string; nextSteps: string[] }, sessionId: string | null, now: Date): Promise<Checkpoint> {
    const task = this.requireTask(taskId);
    if (isTerminal(task.state)) throw new StateError(409, `${taskId} is ${task.state}; checkpoints are for open tasks`);
    const at = now.toISOString();
    // What the repository looked like at the checkpoint, so a resumed session learns what moved since.
    const gitNow = await this.prepareSnapshot(task, 'checkpoint');
    await this.database.db.transaction().execute(async (trx) => {
      await trx.insertInto('task_checkpoints').values({ task_id: taskId, session_id: sessionId, summary: note.summary, next_steps_json: JSON.stringify(note.nextSteps), created_at: at }).execute();
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'checkpoint', at);
      await insertSnapshot(trx, task, 'checkpoint', gitNow, at);
    });
    return { taskId, sessionId, summary: note.summary, nextSteps: note.nextSteps, at };
  }

  /** Session activity and the latest checkpoint of every task. */
  async taskActivity(): Promise<Map<string, { activity: TaskActivity; lastCheckpoint: Checkpoint | null }>> {
    const { db } = this.database;
    const links = await db
      .selectFrom('session_tasks')
      .leftJoin('sessions', 'sessions.session_id', 'session_tasks.session_id')
      .select(['session_tasks.task_id', 'session_tasks.session_id', 'session_tasks.last_at', 'sessions.ended_at'])
      .orderBy('session_tasks.last_at', 'desc')
      .execute();
    const latest = await db
      .selectFrom('task_checkpoints')
      .selectAll()
      .where('id', 'in', db.selectFrom('task_checkpoints').select((eb) => eb.fn.max('id').as('id')).groupBy('task_id'))
      .execute();

    const result = new Map<string, { activity: TaskActivity; lastCheckpoint: Checkpoint | null }>();
    for (const task of this.state.tasks) {
      result.set(task.taskId, { activity: { sessionCount: 0, lastSessionId: null, lastActivityAt: null, lastSessionEndedAt: null }, lastCheckpoint: null });
    }
    for (const link of links) {
      const entry = result.get(link.task_id);
      if (entry === undefined) continue;
      if (entry.activity.lastSessionId === null) {
        entry.activity = { sessionCount: 0, lastSessionId: link.session_id, lastActivityAt: link.last_at, lastSessionEndedAt: link.ended_at ?? null };
      }
      entry.activity.sessionCount += 1;
    }
    for (const row of latest) {
      const entry = result.get(row.task_id);
      if (entry !== undefined) entry.lastCheckpoint = checkpointFromRow(row);
    }
    return result;
  }

  /** Tasks the given session worked on. */
  async tasksOfSession(sessionId: string): Promise<string[]> {
    const rows = await this.database.db.selectFrom('session_tasks').select('task_id').where('session_id', '=', sessionId).orderBy('last_at', 'desc').execute();
    return rows.map((row) => row.task_id);
  }

  /** Sessions (most recent first) and checkpoints (newest first) of one task. */
  async taskHistory(taskId: string, checkpointLimit = 20): Promise<{ sessions: TaskSession[]; checkpoints: Checkpoint[] }> {
    this.requireTask(taskId);
    const { db } = this.database;
    const sessions = await db
      .selectFrom('session_tasks')
      .leftJoin('sessions', 'sessions.session_id', 'session_tasks.session_id')
      .select(['session_tasks.session_id', 'session_tasks.first_at', 'session_tasks.last_at', 'session_tasks.last_activity', 'sessions.ended_at', 'sessions.end_reason'])
      .where('session_tasks.task_id', '=', taskId)
      .orderBy('session_tasks.last_at', 'desc')
      .execute();
    const checkpoints = await db.selectFrom('task_checkpoints').selectAll().where('task_id', '=', taskId).orderBy('id', 'desc').limit(checkpointLimit).execute();
    return {
      sessions: sessions.map((row) => ({ sessionId: row.session_id, firstAt: row.first_at, lastAt: row.last_at, lastActivity: row.last_activity, endedAt: row.ended_at ?? null, endReason: row.end_reason ?? null })),
      checkpoints: checkpoints.map(checkpointFromRow),
    };
  }

  /** Excluding stops monitoring for the repository; hard rules keep applying there. */
  async setExcluded(repoRoot: string, excluded: boolean, now: Date, channel: Channel = 'cli'): Promise<void> {
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      const repoId = await upsertRepository(trx, repoRoot, at);
      await trx.updateTable('repositories').set({ excluded_at: excluded ? at : null, updated_at: at }).where('repo_id', '=', repoId).execute();
      await audit(trx, at, excluded ? 'repository.exclude' : 'repository.include', repoRoot, { channel });
    });
    await this.reload();
  }

  /**
   * Stores events; an event ID already present is ignored, so replays from the spool and retries
   * are idempotent. Returns how many events were new.
   */
  async recordEvents(events: readonly EventEnvelope[], receivedAt: Date, spooled: boolean): Promise<number> {
    if (events.length === 0) return 0;
    const at = receivedAt.toISOString();
    const rows = events.map((event) => ({
      event_id: event.eventId,
      schema_version: event.schemaVersion,
      source: event.source,
      event_type: event.eventType,
      occurred_at: event.timestamp,
      received_at: at,
      session_id: event.sessionId,
      agent_id: event.agentId,
      agent_type: event.agentType,
      cwd: event.cwd,
      tool_name: event.toolName,
      tool_use_id: event.toolUseId,
      task_id: event.taskId,
      repo_root: event.repoRoot,
      verdict: event.verdict,
      rule_id: event.ruleId,
      payload_json: JSON.stringify(event.payload),
      redaction_json: JSON.stringify(event.redaction),
      spooled: spooled ? 1 : 0,
      created_at: at,
    }));
    const results = await this.database.db
      .insertInto('hook_events')
      .values(rows)
      .onConflict((conflict) => conflict.column('event_id').doNothing())
      .execute();
    for (const event of events) {
      if (event.sessionId === null) continue;
      // An edit inside a task's approved scope means the session works on that task, also when the
      // decision was made late for an event from the spool.
      if (event.eventType === 'PreToolUse' && (event.ruleId === 'monitor.in-approved-scope' || event.ruleId === 'monitor.user-uncommitted-file') && event.taskId !== null) {
        await this.linkSession(event.sessionId, event.taskId, 'edit', new Date(event.timestamp));
      }
      // Subagent runs (ADR 0023): started and stopped as the hooks saw them.
      if (event.eventType === 'SubagentStart' && event.agentId !== null) {
        await this.database.db
          .insertInto('agent_runs')
          .values({ agent_id: event.agentId, agent_type: event.agentType, session_id: event.sessionId, started_at: event.timestamp, stopped_at: null, created_at: at, updated_at: at })
          .onConflict((conflict) => conflict.column('agent_id').doNothing())
          .execute();
      }
      if (event.eventType === 'SubagentStop' && event.agentId !== null) {
        await this.database.db
          .insertInto('agent_runs')
          .values({ agent_id: event.agentId, agent_type: event.agentType, session_id: event.sessionId, started_at: event.timestamp, stopped_at: event.timestamp, created_at: at, updated_at: at })
          .onConflict((conflict) => conflict.column('agent_id').doUpdateSet({ stopped_at: event.timestamp, updated_at: at }))
          .execute();
      }
      // SessionEnd closes the session (also when it arrives late through the spool).
      if (event.eventType !== 'SessionEnd') continue;
      const reason = typeof event.payload['reason'] === 'string' && event.payload['reason'] !== '' ? event.payload['reason'] : null;
      await this.database.db.updateTable('sessions').set({ ended_at: event.timestamp, end_reason: reason, updated_at: at }).where('session_id', '=', event.sessionId).execute();
    }
    return results.reduce((sum, result) => sum + Number(result.numInsertedOrUpdatedRows ?? 0n), 0);
  }

  /** Newest first. */
  async listEvents(filter: { sessionId?: string; verdicts?: readonly string[]; repoRoot?: string; since?: string; limit: number }): Promise<StoredEvent[]> {
    let query = this.database.db.selectFrom('hook_events').selectAll().orderBy('occurred_at', 'desc').orderBy(sql`rowid`, 'desc').limit(filter.limit);
    if (filter.sessionId !== undefined) query = query.where('session_id', '=', filter.sessionId);
    if (filter.verdicts !== undefined && filter.verdicts.length > 0) query = query.where('verdict', 'in', [...filter.verdicts]);
    if (filter.repoRoot !== undefined) {
      query = process.platform === 'win32' ? query.where(sql`lower(repo_root)`, '=', filter.repoRoot.toLowerCase()) : query.where('repo_root', '=', filter.repoRoot);
    }
    if (filter.since !== undefined) query = query.where('occurred_at', '>=', filter.since);
    const rows = await query.execute();
    return rows.map((row) =>
      storedEventSchema.parse({
        eventId: row.event_id,
        schemaVersion: row.schema_version,
        source: row.source,
        eventType: row.event_type,
        timestamp: row.occurred_at,
        receivedAt: row.received_at,
        sessionId: row.session_id,
        agentId: row.agent_id,
        agentType: row.agent_type,
        cwd: row.cwd,
        toolName: row.tool_name,
        toolUseId: row.tool_use_id,
        taskId: row.task_id,
        repoRoot: row.repo_root,
        verdict: row.verdict,
        ruleId: row.rule_id,
        payload: JSON.parse(row.payload_json),
        redaction: JSON.parse(row.redaction_json),
        spooled: row.spooled === 1,
      }),
    );
  }

  /**
   * Retention (spec §18.2): events and sessions older than `days` are deleted. Governance records
   * (tasks, plans, approvals, audit log) are kept. The database file shrinks after large deletions.
   */
  async applyRetention(now: Date, days: number): Promise<{ events: number; sessions: number }> {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const events = await this.database.db.deleteFrom('hook_events').where('occurred_at', '<', cutoff).executeTakeFirst();
    const sessions = await this.database.db.deleteFrom('sessions').where('last_seen_at', '<', cutoff).executeTakeFirst();
    const removed = { events: Number(events.numDeletedRows), sessions: Number(sessions.numDeletedRows) };
    if (removed.events + removed.sessions > 0) {
      await sql`INSERT INTO audit_log (at, actor, action, subject, details_json, created_at) VALUES (${now.toISOString()}, 'jerry-core', 'retention.apply', NULL, ${JSON.stringify({ days, ...removed })}, ${now.toISOString()})`.execute(this.database.db);
      if (removed.events > 5000) this.database.raw.exec('VACUUM');
      else this.database.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      await this.reload();
    }
    return removed;
  }

  /** SQLite's quick integrity check: "ok", or a description of the first problems found. */
  integrityCheck(): string {
    const rows = this.database.raw.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    return rows.map((row) => String(Object.values(row)[0])).join('; ');
  }

  /** Online backup into JERRY_HOME/backups while Core keeps running. */
  backup(label: string): Promise<string> {
    return backupDatabase(this.database.raw, this.database.backupsDir, label);
  }

  close(): Promise<void> {
    return this.database.close();
  }

  private requireTask(taskId: string): Task {
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) throw new StateError(404, `Unknown task ${taskId}`);
    return task;
  }

  /**
   * Validates and applies one workflow transition inside the caller's transaction. The current state
   * is read from the database, not the snapshot, so two concurrent requests cannot both pass the check.
   */
  private async transition(trx: Transaction<JerrySchema>, taskId: string, event: WorkflowEvent, actor: WorkflowActor, reason: string, at: string): Promise<WorkflowState> {
    const row = await trx.selectFrom('tasks').select('state').where('task_id', '=', taskId).executeTakeFirst();
    if (row === undefined) throw new StateError(404, `Unknown task ${taskId}`);
    const from = workflowStateSchema.parse(row.state);
    let pausedFrom: WorkflowState | null = null;
    if (event === 'task.resumed') {
      const paused = await trx.selectFrom('workflow_transitions').select('from_state').where('task_id', '=', taskId).where('to_state', '=', 'PAUSED').orderBy('id', 'desc').limit(1).executeTakeFirst();
      pausedFrom = paused === undefined || paused.from_state === null ? null : workflowStateSchema.parse(paused.from_state);
    }
    const to = validTransition(taskId, from, event, actor, pausedFrom);
    await trx.updateTable('tasks').set({ state: to, updated_at: at }).where('task_id', '=', taskId).execute();
    await recordTransition(trx, { taskId, from, to, event, actor, reason, at });
    return to;
  }

  private async reload(): Promise<void> {
    const { db } = this.database;
    const tasks = await db
      .selectFrom('tasks')
      .innerJoin('repositories', 'repositories.repo_id', 'tasks.repo_id')
      .innerJoin('plans', (join) => join.onRef('plans.task_id', '=', 'tasks.task_id').onRef('plans.version', '=', 'tasks.current_plan_version'))
      .select(['tasks.task_id', 'tasks.title', 'tasks.state', 'tasks.created_at', 'repositories.root_path', 'plans.version', 'plans.content_hash', 'plans.scope_json', 'plans.document_json', 'plans.created_at as plan_created_at'])
      .orderBy('tasks.task_id')
      .execute();
    const approvals = await db.selectFrom('approvals').selectAll().orderBy('approved_at').orderBy(sql`rowid`).execute();
    const sessions = await db.selectFrom('sessions').selectAll().orderBy('last_seen_at', 'desc').limit(SNAPSHOT_SESSIONS).execute();
    const excluded = await db.selectFrom('repositories').select(['root_path', 'excluded_at']).where('excluded_at', 'is not', null).execute();
    const sessionTotal = await db.selectFrom('sessions').select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
    const nextTaskNumber = await db.selectFrom('settings').select('value_json').where('key', '=', NEXT_TASK_NUMBER).executeTakeFirst();

    this.state = coreStateSchema.parse({
      schemaVersion: 1,
      nextTaskNumber: nextTaskNumber === undefined ? 1 : Number(JSON.parse(nextTaskNumber.value_json)),
      tasks: tasks.map((row) => ({
        taskId: row.task_id,
        title: row.title,
        repoRoot: row.root_path,
        createdAt: row.created_at,
        state: row.state,
        plan: { version: row.version, contentHash: row.content_hash, scope: JSON.parse(row.scope_json), createdAt: row.plan_created_at, ...(row.document_json === null ? {} : { document: JSON.parse(row.document_json) }) },
      })),
      approvals: approvals.map((row) => ({
        approvalId: row.approval_id,
        taskId: row.task_id,
        stage: row.stage,
        version: row.version,
        contentHash: row.content_hash,
        decision: row.decision,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at,
        comment: row.comment,
      })),
      sessions: sessions.reverse().map((row) => ({ sessionId: row.session_id, cwd: row.cwd, source: row.source, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at })),
      excludedRepos: excluded.map((row) => ({ repoRoot: row.root_path, excludedAt: row.excluded_at! })),
    });
    this.sessionTotal = Number(sessionTotal.count);

    // The user's uncommitted files at each open task's latest plan approval (ADR 0017).
    const userDirty = new Map<string, Set<string>>();
    for (const task of this.state.tasks.filter((candidate) => !isTerminal(candidate.state))) {
      const baseline = await latestSnapshot(db, task.taskId, 'plan.approved');
      if (baseline !== null) userDirty.set(task.taskId, new Set(Object.keys(baseline.fingerprints).map(fileKey)));
    }
    this.userDirty = userDirty;
  }

  /** The stored profile of a repository with its freshness fingerprints (ADR 0020). */
  async storedProfile(repoRoot: string): Promise<{ profile: ProjectProfile; fingerprints: ProfileFingerprints; scannedAt: string } | null> {
    const row = await this.database.db.selectFrom('project_profiles').selectAll().where('repo_id', '=', repositoryId(repoRoot)).executeTakeFirst();
    if (row === undefined) return null;
    const parsed = projectProfileSchema.safeParse(JSON.parse(row.profile_json));
    // A profile from an older format is simply rescanned.
    if (!parsed.success) return null;
    return { profile: parsed.data, fingerprints: JSON.parse(row.fingerprints_json) as ProfileFingerprints, scannedAt: row.scanned_at };
  }

  async saveProfile(repoRoot: string, profile: ProjectProfile, fingerprints: ProfileFingerprints, now: Date): Promise<void> {
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      const repoId = await upsertRepository(trx, repoRoot, at);
      await trx
        .insertInto('project_profiles')
        .values({ repo_id: repoId, profile_json: JSON.stringify(profile), fingerprints_json: JSON.stringify(fingerprints), scanned_at: profile.scannedAt, created_at: at, updated_at: at })
        .onConflict((conflict) => conflict.column('repo_id').doUpdateSet({ profile_json: JSON.stringify(profile), fingerprints_json: JSON.stringify(fingerprints), scanned_at: profile.scannedAt, updated_at: at }))
        .execute();
    });
  }

  /** Repositories JERRY knows: from tasks, sessions, exclusions and profiles. */
  async knownRepositories(): Promise<string[]> {
    const rows = await this.database.db.selectFrom('repositories').select('root_path').orderBy('root_path').execute();
    return rows.map((row) => row.root_path);
  }

  /** One-time import of the M0 JSON state into an empty database; the JSON file is kept, renamed. */
  private async importLegacyState(legacyStateFile: string): Promise<void> {
    if (!fs.existsSync(legacyStateFile)) return;
    const { db } = this.database;
    const existing = await db.selectFrom('tasks').select('task_id').limit(1).executeTakeFirst();
    if (existing !== undefined) return;

    const parsed = legacyStateSchema.safeParse(JSON.parse(fs.readFileSync(legacyStateFile, 'utf8')));
    if (!parsed.success) {
      throw new Error(`Legacy state file ${legacyStateFile} is invalid; refusing to start with unknown state: ${parsed.error.message}`);
    }
    const legacy = parsed.data;
    const at = new Date().toISOString();
    await db.transaction().execute(async (trx) => {
      for (const task of legacy.tasks) {
        const repoId = await upsertRepository(trx, task.repoRoot, task.createdAt);
        const decision = currentPlanDecision({ ...task, state: 'WAIT_PLAN_APPROVAL' }, legacy.approvals)?.decision;
        const state: WorkflowState = decision === 'APPROVED' ? 'IMPLEMENTATION' : decision === 'REJECTED' ? 'PLAN_DRAFT' : 'WAIT_PLAN_APPROVAL';
        await trx.insertInto('tasks').values({ task_id: task.taskId, title: task.title, repo_id: repoId, current_plan_version: task.plan.version, state, created_at: task.createdAt, updated_at: at }).execute();
        await trx.insertInto('plans').values({ task_id: task.taskId, version: task.plan.version, content_hash: task.plan.contentHash, scope_json: JSON.stringify(task.plan.scope), created_at: task.plan.createdAt }).execute();
      }
      for (const approval of legacy.approvals) {
        // M0 kept only the current plan version; approvals of older versions have no plan row to reference.
        if (!legacy.tasks.some((task) => task.taskId === approval.taskId && task.plan.version === approval.version)) continue;
        await trx
          .insertInto('approvals')
          .values({
            approval_id: approval.approvalId,
            task_id: approval.taskId,
            stage: approval.stage,
            version: approval.version,
            content_hash: approval.contentHash,
            decision: approval.decision,
            approved_by: approval.approvedBy,
            approved_at: approval.approvedAt,
            comment: approval.comment,
            created_at: approval.approvedAt,
          })
          .execute();
      }
      for (const session of legacy.sessions) {
        await trx
          .insertInto('sessions')
          .values({ session_id: session.sessionId, cwd: session.cwd, source: session.source, first_seen_at: session.firstSeenAt, last_seen_at: session.lastSeenAt, created_at: session.firstSeenAt, updated_at: at })
          .onConflict((conflict) => conflict.column('session_id').doNothing())
          .execute();
      }
      for (const exclusion of legacy.excludedRepos) {
        const repoId = await upsertRepository(trx, exclusion.repoRoot, exclusion.excludedAt);
        await trx.updateTable('repositories').set({ excluded_at: exclusion.excludedAt, updated_at: at }).where('repo_id', '=', repoId).execute();
      }
      await trx
        .insertInto('settings')
        .values({ key: NEXT_TASK_NUMBER, value_json: JSON.stringify(legacy.nextTaskNumber), created_at: at, updated_at: at })
        .onConflict((conflict) => conflict.column('key').doUpdateSet({ value_json: JSON.stringify(legacy.nextTaskNumber), updated_at: at }))
        .execute();
      await audit(trx, at, 'state.import-legacy', legacyStateFile, { tasks: legacy.tasks.length, approvals: legacy.approvals.length, sessions: legacy.sessions.length });
    });
    fs.renameSync(legacyStateFile, `${legacyStateFile}.imported-${at.replace(/[:.]/g, '-')}`);
  }
}

function emptyState(): CoreState {
  return { schemaVersion: 1, nextTaskNumber: 1, tasks: [], approvals: [], sessions: [], excludedRepos: [] };
}

/** Stable ID per working tree root, independent of path spelling (case, separators on Windows). */
function repositoryId(repoRoot: string): string {
  const key = comparablePath(repoRoot, repoRoot, process.platform);
  return `repo_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
}

async function upsertRepository(trx: Transaction<JerrySchema> | Kysely<JerrySchema>, repoRoot: string, at: string): Promise<string> {
  const repoId = repositoryId(repoRoot);
  await trx
    .insertInto('repositories')
    .values({ repo_id: repoId, root_path: repoRoot, excluded_at: null, created_at: at, updated_at: at })
    .onConflict((conflict) => conflict.column('repo_id').doNothing())
    .execute();
  return repoId;
}

async function insertPlan(trx: Transaction<JerrySchema>, plan: { taskId: string; title: string; repoRoot: string; version: number; scope: string[]; document?: PlanDocument | undefined; at: string }): Promise<void> {
  await trx
    .insertInto('plans')
    .values({
      task_id: plan.taskId,
      version: plan.version,
      content_hash: computePlanHash({ taskId: plan.taskId, title: plan.title, repoRoot: plan.repoRoot, version: plan.version, scope: plan.scope, ...(plan.document === undefined ? {} : { document: plan.document }) }),
      scope_json: JSON.stringify(plan.scope),
      document_json: plan.document === undefined ? null : JSON.stringify(plan.document),
      created_at: plan.at,
    })
    .execute();
}

/** Upsert; events can arrive out of order (spool), so the times only ever widen. */
async function linkSession(trx: Transaction<JerrySchema> | Kysely<JerrySchema>, sessionId: string, taskId: string, activity: SessionActivity, at: string): Promise<void> {
  await trx
    .insertInto('session_tasks')
    .values({ session_id: sessionId, task_id: taskId, first_at: at, last_at: at, last_activity: activity, created_at: at, updated_at: at })
    .onConflict((conflict) =>
      conflict.columns(['session_id', 'task_id']).doUpdateSet({
        first_at: sql`min(session_tasks.first_at, excluded.first_at)`,
        last_activity: sql`CASE WHEN excluded.last_at >= session_tasks.last_at THEN excluded.last_activity ELSE session_tasks.last_activity END`,
        last_at: sql`max(session_tasks.last_at, excluded.last_at)`,
        updated_at: at,
      }),
    )
    .execute();
}

async function latestReportSubject(trx: Transaction<JerrySchema>, taskId: string): Promise<{ version: number; contentHash: string } | null> {
  const row = await trx.selectFrom('implementation_reports').select(['version', 'content_hash']).where('task_id', '=', taskId).orderBy('version', 'desc').limit(1).executeTakeFirst();
  return row === undefined ? null : { version: row.version, contentHash: row.content_hash };
}

function reportFromRow(row: Selectable<JerrySchema['implementation_reports']>): ImplementationReportRecord {
  return implementationReportRecordSchema.parse({
    taskId: row.task_id,
    version: row.version,
    planVersion: row.plan_version,
    contentHash: row.content_hash,
    document: JSON.parse(row.document_json),
    evidence: JSON.parse(row.evidence_json),
    submittedBy: row.submitted_by,
    sessionId: row.session_id,
    createdAt: row.created_at,
  });
}

/**
 * What JERRY recorded in the task's repository since its plan was last approved: deviations,
 * blocks and the files edited with the file tools, compared with the files the report lists.
 */
/** Comparable key of a repo-relative path (case-insensitive on Windows). */
function fileKey(relative: string): string {
  const normalized = relative.replaceAll('\\', '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function latestSnapshot(trx: Transaction<JerrySchema> | Kysely<JerrySchema>, taskId: string, kind: SnapshotKind): Promise<StoredSnapshot | null> {
  const row = await trx.selectFrom('git_snapshots').select(['head', 'fingerprints_json', 'created_at', 'error']).where('task_id', '=', taskId).where('kind', '=', kind).orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (row === undefined || row.error !== null) return null;
  return { head: row.head, fingerprints: JSON.parse(row.fingerprints_json) as Record<string, string>, createdAt: row.created_at };
}

async function insertSnapshot(trx: Transaction<JerrySchema>, task: Task, kind: SnapshotKind, prepared: PreparedSnapshot, at: string): Promise<void> {
  const snapshot = prepared.snapshot;
  await trx
    .insertInto('git_snapshots')
    .values({
      task_id: task.taskId,
      repo_root: task.repoRoot,
      kind,
      head: snapshot?.head ?? null,
      branch: snapshot?.branch ?? null,
      upstream: snapshot?.upstream ?? null,
      remote_url: snapshot?.remoteUrl ?? null,
      staged_json: JSON.stringify(snapshot?.staged ?? []),
      unstaged_json: JSON.stringify(snapshot?.unstaged ?? []),
      untracked_json: JSON.stringify(snapshot?.untracked ?? []),
      truncated: snapshot?.truncated === true ? 1 : 0,
      fingerprints_json: JSON.stringify(prepared.fingerprints),
      error: prepared.error,
      created_at: at,
    })
    .execute();
}

/**
 * Git's view for a report: files changed since the plan baseline. A file the user had already
 * changed at baseline counts only if its content changed again since then.
 */
function gitEvidence(baseline: StoredSnapshot | null, now: PreparedSnapshot): ReportEvidence['git'] {
  if (now.snapshot === null) return null;
  const userAtBaseline = baseline?.fingerprints ?? {};
  const changed = now.changed.filter((file) => !(file in userAtBaseline) || userAtBaseline[file] !== now.fingerprints[file]);
  return { baselineHead: baseline?.head ?? null, baselineAt: baseline?.createdAt ?? null, changed, userChanged: changed.filter((file) => file in userAtBaseline) };
}

/** In-scope files whose content differs between two fingerprint sets (added, changed or removed). */
function changedInScope(task: Task, before: Record<string, string>, after: Record<string, string>): string[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...files].filter((file) => before[file] !== after[file] && matchesAnyGlob(file, task.plan.scope, process.platform === 'win32')).sort();
}

async function collectEvidence(trx: Transaction<JerrySchema>, task: Task, document: ImplementationReport, until: string, git: ReportEvidence['git']): Promise<ReportEvidence> {
  const platform = process.platform;
  const approved = await trx.selectFrom('workflow_transitions').select('at').where('task_id', '=', task.taskId).where('event', '=', 'plan.approved').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const since = approved?.at ?? task.createdAt;
  let query = trx
    .selectFrom('hook_events')
    .select(['occurred_at', 'tool_name', 'verdict', 'rule_id', 'payload_json', 'cwd', 'repo_root'])
    .where('event_type', '=', 'PreToolUse')
    .where('occurred_at', '>=', since)
    .where('occurred_at', '<=', until)
    .orderBy('occurred_at');
  // Hard-rule blocks are decided before the repository is resolved, so they carry no repo_root;
  // they count when their working directory lies inside the repository.
  query = query.where((eb) =>
    eb.or([
      platform === 'win32' ? eb(sql`lower(repo_root)`, '=', task.repoRoot.toLowerCase()) : eb('repo_root', '=', task.repoRoot),
      eb.and([eb('repo_root', 'is', null), eb('verdict', '=', 'DENY')]),
    ]),
  );
  const events = (await query.execute()).filter((event) => event.repo_root !== null || (event.cwd !== null && relativeInside(event.cwd, task.repoRoot, platform) !== null));

  const key = (relative: string): string => (platform === 'win32' ? relative.toLowerCase() : relative);
  const deviations: ReportEvidence['deviations'] = [];
  let deviationCount = 0;
  let blockedCount = 0;
  const observed = new Map<string, string>();
  for (const event of events) {
    const input = ((JSON.parse(event.payload_json) as Record<string, unknown>)['input'] ?? {}) as Record<string, unknown>;
    const target = typeof input['path'] === 'string' ? input['path'] : typeof input['command'] === 'string' ? input['command'] : null;
    if (event.verdict === 'WARN') {
      deviationCount += 1;
      if (deviations.length < MAX_EVIDENCE_DEVIATIONS) deviations.push({ at: event.occurred_at, tool: event.tool_name, target, rule: event.rule_id });
    }
    if (event.verdict === 'DENY') blockedCount += 1;
    if (event.verdict !== 'DENY' && event.tool_name !== null && FILE_TOOLS.has(event.tool_name) && typeof input['path'] === 'string') {
      const relative = relativeInside(absolutePath(input['path'], event.cwd ?? task.repoRoot, platform), task.repoRoot, platform);
      if (relative !== null && relative !== '') observed.set(key(relative), relative);
    }
  }
  const sameRepo = (repository: string): boolean => repository.trim() === '' || comparablePath(repository, task.repoRoot, platform) === comparablePath(task.repoRoot, task.repoRoot, platform);
  const reported = new Set(document.changes.filter((change) => sameRepo(change.repository)).map((change) => key(change.path.trim().replaceAll('\\', '/').replace(/^\.\//, ''))));
  const observedEdits = [...observed.values()].sort();
  // Git also sees what shell commands and generators changed (ADR 0017).
  const changed = new Map(observed);
  for (const file of git?.changed ?? []) changed.set(key(file), file);
  return {
    since,
    deviations,
    deviationCount,
    blockedCount,
    observedEdits,
    unreportedEdits: [...changed.values()].filter((relative) => !reported.has(key(relative))).sort(),
    failedOrNotRunChecks: document.checks.filter((check) => check.result !== 'PASS').length,
    git,
  };
}

/** Files in the plan's scope edited with the file tools in the repository during (from, until]. */
async function editsInScopeBetween(trx: Transaction<JerrySchema>, task: Task, from: string, until: string): Promise<string[]> {
  const platform = process.platform;
  let query = trx
    .selectFrom('hook_events')
    .select(['tool_name', 'verdict', 'payload_json', 'cwd'])
    .where('event_type', '=', 'PreToolUse')
    .where('occurred_at', '>', from)
    .where('occurred_at', '<=', until)
    .where('tool_name', 'in', [...FILE_TOOLS]);
  query = platform === 'win32' ? query.where(sql`lower(repo_root)`, '=', task.repoRoot.toLowerCase()) : query.where('repo_root', '=', task.repoRoot);
  const edited = new Set<string>();
  for (const event of await query.execute()) {
    if (event.verdict === 'DENY') continue;
    const input = ((JSON.parse(event.payload_json) as Record<string, unknown>)['input'] ?? {}) as Record<string, unknown>;
    if (typeof input['path'] !== 'string') continue;
    const relative = relativeInside(absolutePath(input['path'], event.cwd ?? task.repoRoot, platform), task.repoRoot, platform);
    if (relative !== null && relative !== '' && matchesAnyGlob(relative, task.plan.scope, platform === 'win32')) edited.add(relative);
  }
  return [...edited].sort();
}

function checkpointFromRow(row: { task_id: string; session_id: string | null; summary: string; next_steps_json: string; created_at: string }): Checkpoint {
  return { taskId: row.task_id, sessionId: row.session_id, summary: row.summary, nextSteps: JSON.parse(row.next_steps_json) as string[], at: row.created_at };
}

/** The target state, or a 409 explaining why the workflow does not allow the step. */
function validTransition(taskId: string, from: WorkflowState | null, event: WorkflowEvent, actor: WorkflowActor, pausedFrom: WorkflowState | null = null): WorkflowState {
  const result = applyEvent(from, event, actor, pausedFrom);
  if (!result.ok) throw new StateError(409, `${taskId}: ${result.reason}`);
  return result.to;
}

async function recordTransition(
  trx: Transaction<JerrySchema>,
  transition: { taskId: string; from: WorkflowState | null; to: WorkflowState; event: WorkflowEvent; actor: WorkflowActor; reason: string; at: string },
): Promise<void> {
  await trx
    .insertInto('workflow_transitions')
    .values({ task_id: transition.taskId, from_state: transition.from, to_state: transition.to, event: transition.event, actor: transition.actor, reason: transition.reason, at: transition.at, created_at: transition.at })
    .execute();
}

async function audit(trx: Transaction<JerrySchema>, at: string, action: string, subject: string | null, details: Record<string, unknown>, actor = 'local-user'): Promise<void> {
  await trx.insertInto('audit_log').values({ at, actor, action, subject, details_json: JSON.stringify(details), created_at: at }).execute();
}

/** Plans can come from the user (CLI) or Claude (MCP); approvals always come from the user. */
function actorOf(submittedBy: 'user' | 'claude' | undefined): string {
  return submittedBy === 'claude' ? 'claude-code' : 'local-user';
}
