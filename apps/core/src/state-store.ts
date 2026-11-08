import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  agentModelChoiceSchema,
  type AgentModelChoice,
  type ArtifactRequest,
  type AgentModelsUpdateRequest,
  MODEL_CHOICE_ROLES,
  SKILL_MODEL_ROLES,
  coreStateSchema,
  storedEventSchema,
  type ApprovalRecord,
  type ApprovalRequest,
  type CallOrigin,
  type Checkpoint,
  type CoreState,
  type CompletionCheck,
  type LaterWork,
  type AgentRun,
  type AnalysisReport,
  type AnalysisReportRecord,
  analysisReportRecordSchema,
  type Project,
  projectSchema,
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
  type Finding,
  type FindingCounts,
  type FindingEvent,
  type FindingStatus,
  findingSchema,
  findingSeveritySchema,
  findingStatusSchema,
  type Assignment,
  type ArtifactDecision,
  artifactDecisionSchema,
  type FindingSeverity,
  type FixPlan,
  MAX_REVIEW_ROUNDS,
  REVIEWER_ROLES,
  reviewerRoleSchema,
  taskRepositoryRoots,
  type ReviewerRole,
  type ReviewState,
  type ReviewSubmission,
  reviewRoundSchema,
  type Plan,
  type PlanDrift,
  type TestRun,
  testRunSchema,
  type PlanDocument,
  type PlanRepository,
  planSchema,
  type Task,
  type WorkflowActor,
  type WorkflowEvent,
  type WorkflowState,
  type WorkflowTransition,
  taskSchema,
  workflowStateSchema,
  workflowTransitionSchema,
  DEFAULT_QA_LANGUAGE,
  DEFAULT_REVIEW_MODE,
  DEFAULT_USAGE_SHOW_BAR,
  DEFAULT_DECISION_CONFIRMATION,
  decisionConfirmationSchema,
  qaLanguageSchema,
  type ReviewMode,
  reviewModeSchema,
  type Settings,
  type SettingsUpdateRequest,
} from '@jerry/contracts';
import { backupDatabase, openJerryDatabase, type JerryDatabase, type JerrySchema } from '@jerry/database';
import { absolutePath, comparablePath, computePlanHash, computeReportHash, currentPlanDecision, decisionFor, isComparableInside, matchesAnyGlob, relativeInside, reviewersFor, taskRepositories, type TaskRepository } from '@jerry/policy-engine';
import { writeFileAtomic } from '@jerry/platform';
import { applyEvent, effectiveReviewMode, evaluateCompletion, globsOverlap, isTerminal, planLayers, resolveReviewChoice, WORK_STATES, type TransitionContext } from '@jerry/workflow';
import { MAX_SUBAGENTS } from '@jerry/contracts/agents';
import type { ProfileFingerprints } from '@jerry/discovery';
import type { DetectedFinding } from '@jerry/quality';
import { fingerprintFiles, gitReader, type GitReader, type GitSnapshot } from './git-reader.js';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { z } from 'zod';

/** Sessions kept in the in-memory snapshot; older ones stay in the database. */
const SNAPSHOT_SESSIONS = 200;
/** A session's entrypoint is a short name (cli, claude-vscode, â€¦); anything longer is cut. */
const MAX_ENTRYPOINT_LENGTH = 100;
const NEXT_TASK_NUMBER = 'next_task_number';
const REVIEW_MODE_SETTING = 'review_mode';
const QA_LANGUAGE_SETTING = 'qa_language';
const USAGE_SHOW_BAR_SETTING = 'usage_show_bar';
const DECISION_CONFIRMATION_SETTING = 'decision_confirmation';
/** The user's model and effort per read-only subagent (role id -> choice); absent roles use the plugin's defaults. */
const AGENT_MODELS_SETTING = 'agent_models';

/** Where a user decision came from; recorded in the audit log. */
export type Channel = 'cli' | 'dashboard';

/** What a session last did for a task. */
export type SessionActivity = 'plan.submitted' | 'plan.revised' | 'edit' | 'checkpoint' | 'report' | 'analysis';

/** A subagent run without SubagentStop after this long is timed-out; also the window for counting active ones. */
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;

/** Findings category of each reviewer. */
const REVIEW_CATEGORY: Readonly<Record<ReviewerRole, string>> = {
  'jerry-correctness-reviewer': 'correctness',
  'jerry-security-reviewer': 'security',
  'jerry-design-reviewer': 'architecture',
};
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { P1: 0, P2: 1, P3: 2, P4: 3 };

/** Automatic fix rounds per finding before it is left to the user: two attempts, then a person decides. */
const MAX_AUTO_FIX_ROUNDS = 2;

/** Tools whose target path JERRY sees, so their edits count as observed. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Deviations listed in a report's evidence; the count covers all of them. */
const MAX_EVIDENCE_DEVIATIONS = 50;

/** User decisions about a whole task (approvals and plans have their own methods). */
export type TaskControlEvent = Extract<WorkflowEvent, 'task.paused' | 'task.resumed' | 'task.cancelled'>;

/** The old JSON state file predates workflow states; its tasks get theirs from their approvals on import. */
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
  /** The old JSON state file; imported once into an empty database, then renamed. */
  legacyStateFile: string;
  /** Read-only Git access; tests may replace it. */
  git?: GitReader;
  /** JERRY_HOME/run/projects.json, rewritten at start and after every project change. */
  projectsFile?: string;
}

/** When a Git baseline is taken. */
export type SnapshotKind = 'plan.approved' | 'report' | 'checkpoint' | 'review';

interface StoredSnapshot {
  head: string | null;
  fingerprints: Record<string, string>;
  createdAt: string;
}

/**
 * A task seen from one of its repositories: that repository's root and scope, the same task ID.
 * `primaryRoot` is the task's own repository; paths in another one are shown absolute.
 */
type RepoTask = Task & { primaryRoot: string };

function repoView(task: Task, repository: TaskRepository): RepoTask {
  return { ...task, repoRoot: repository.repoRoot, plan: { ...task.plan, scope: [...repository.scope] }, primaryRoot: task.repoRoot };
}

/** Every repository of a task as a view (the task's own first). */
function repoViews(task: Task): RepoTask[] {
  return taskRepositories(task).map((repository) => repoView(task, repository));
}

function isPrimary(view: Task | RepoTask): boolean {
  return !('primaryRoot' in view) || sameRoot(view.primaryRoot, view.repoRoot);
}

/** A repo-relative path as the task shows it: relative in its own repository, absolute in another. */
function shownPath(view: Task | RepoTask, relative: string): string {
  return isPrimary(view) ? relative : `${view.repoRoot.replaceAll('\\', '/').replace(/\/+$/, '')}/${relative}`;
}

/** A comparable key of a repository root. */
function rootKey(repoRoot: string): string {
  return comparablePath(repoRoot, repoRoot, process.platform);
}

/** One reading per repository of a task. */
type PreparedSnapshots = Array<{ view: RepoTask; prepared: PreparedSnapshot }>;

/** A Git reading taken before a transaction (Git runs as a process; transactions stay short). */
interface PreparedSnapshot {
  snapshot: GitSnapshot | null;
  error: string | null;
  fingerprints: Record<string, string>;
  /** Files changed since the plan baseline (report and checkpoint snapshots). */
  changed: string[];
}

/**
 * JERRY state in SQLite. Gate checks read an in-memory snapshot, so they never wait for
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
  /** Active implementer assignments per task, for the synchronous gate. */
  private assignments = new Map<string, Assignment[]>();
  /** The last subagent that edited a file of a task: (task|file) â†’ writer. */
  private readonly recentWriters = new Map<string, { agentId: string; at: number }>();
  /** The projects the user added: the only repositories JERRY monitors. */
  private projectList: Project[] = [];
  /** The user's global settings, read with every reload. */
  private settingValues: Settings = {
    reviewMode: DEFAULT_REVIEW_MODE,
    qaLanguage: DEFAULT_QA_LANGUAGE,
    usageShowBar: DEFAULT_USAGE_SHOW_BAR,
    decisionConfirmation: DEFAULT_DECISION_CONFIRMATION,
  };

  private constructor(
    private readonly database: JerryDatabase,
    private readonly git: GitReader,
    private readonly projectsFile: string | null,
  ) {}

  static async open(options: StateStoreOptions): Promise<StateStore> {
    const database = await openJerryDatabase({ file: options.databaseFile, backupsDir: options.backupsDir });
    const store = new StateStore(database, options.git ?? gitReader, options.projectsFile ?? null);
    try {
      await store.importLegacyState(options.legacyStateFile);
      await store.reload();
      store.writeProjectsFile();
    } catch (error) {
      await database.close();
      throw error;
    }
    return store;
  }

  /** The query builder, for stores that own their own tables (eval runs). */
  get kysely(): Kysely<JerrySchema> {
    return this.database.db;
  }

  /** The read-only Git reader; the quality scheduler shares it. */
  get gitReader(): GitReader {
    return this.git;
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

  /**
   * The user's latest decision on one stage and version of a task (null while there is none) and the
   * task's state. Read-only: Claude waits on it after a submission. Plan and report versions never
   * change; a fix plan resubmitted in the same review round does, so a fix plan decision must also
   * match that round's current fix plan hash.
   */
  async decisionOn(taskId: string, stage: ApprovalRecord['stage'], version: number): Promise<{ decision: ApprovalRecord | null; state: Task['state'] }> {
    const task = this.requireTask(taskId);
    const matching = this.state.approvals.filter((approval) => approval.taskId === taskId && approval.stage === stage && approval.version === version);
    if (stage !== 'REVIEW_FIX' || matching.length === 0) return { decision: matching.at(-1) ?? null, state: task.state };
    const round = await this.database.db.selectFrom('review_rounds').select('fix_plan_hash').where('task_id', '=', taskId).where('round', '=', version).executeTakeFirst();
    return { decision: matching.filter((approval) => approval.contentHash === round?.fix_plan_hash).at(-1) ?? null, state: task.state };
  }

  async createTask(input: { repoRoot: string; title: string; scope: string[]; document?: PlanDocument; repositories?: PlanRepository[]; submittedBy?: 'user' | 'claude'; sessionId?: string | null }, now: Date): Promise<Task> {
    return this.openTask({ ...input, goal: null }, 'plan.submitted', now);
  }

  /**
   * Task intake before a plan: the task starts in DISCOVERY with an intake plan v1 whose
   * scope is the area to analyse. Nothing is approved; edits stay deviations until a real plan is.
   */
  async startTask(input: { repoRoot: string; title: string; goal: string; focus: string[]; analysts?: NonNullable<Task['analysts']> | undefined; submittedBy?: 'user' | 'claude'; sessionId?: string | null }, now: Date): Promise<Task> {
    return this.openTask({ repoRoot: input.repoRoot, title: input.title, scope: input.focus, goal: input.goal, analysts: input.analysts, submittedBy: input.submittedBy, sessionId: input.sessionId }, 'task.started', now);
  }

  private async openTask(
    input: { repoRoot: string; title: string; scope: string[]; goal: string | null; analysts?: NonNullable<Task['analysts']> | undefined; document?: PlanDocument | undefined; repositories?: PlanRepository[] | undefined; submittedBy?: 'user' | 'claude' | undefined; sessionId?: string | null | undefined },
    event: 'plan.submitted' | 'task.started',
    now: Date,
  ): Promise<Task> {
    const at = now.toISOString();
    const taskId = await this.database.db.transaction().execute(async (trx) => {
      const repoId = await upsertRepository(trx, input.repoRoot, at);
      const setting = await trx.selectFrom('settings').select('value_json').where('key', '=', NEXT_TASK_NUMBER).executeTakeFirst();
      const number = setting === undefined ? 1 : Number(JSON.parse(setting.value_json));
      const id = `JRY-${String(number).padStart(4, '0')}`;
      const actor = input.submittedBy ?? 'user';
      const state = validTransition(id, null, event, actor);
      await trx
        .insertInto('tasks')
        .values({ task_id: id, title: input.title, repo_id: repoId, current_plan_version: 1, state, goal: input.goal, analysts_json: input.analysts === undefined ? null : JSON.stringify(input.analysts), created_at: at, updated_at: at })
        .execute();
      await insertPlan(trx, { taskId: id, title: input.title, repoRoot: input.repoRoot, version: 1, scope: input.scope, document: input.document, repositories: input.repositories, at });
      await recordTransition(trx, { taskId: id, from: null, to: state, event, actor, reason: event === 'task.started' ? 'task intake: analysis first' : 'plan version 1', at });
      if (input.sessionId != null) await linkSession(trx, input.sessionId, id, event === 'task.started' ? 'analysis' : 'plan.submitted', at);
      await trx
        .insertInto('settings')
        .values({ key: NEXT_TASK_NUMBER, value_json: JSON.stringify(number + 1), created_at: at, updated_at: at })
        .onConflict((conflict) => conflict.column('key').doUpdateSet({ value_json: JSON.stringify(number + 1), updated_at: at }))
        .execute();
      const details = event === 'task.started' ? { repoRoot: input.repoRoot, focus: input.scope, goal: input.goal, ...(input.analysts === undefined ? {} : { analysts: input.analysts }) } : { repoRoot: input.repoRoot, scope: input.scope, withDocument: input.document !== undefined, ...(input.repositories === undefined || input.repositories.length === 0 ? {} : { repositories: input.repositories.map((repository) => repository.repoRoot) }) };
      await audit(trx, at, event === 'task.started' ? 'task.intake' : 'task.create', id, details, actorOf(input.submittedBy));
      return id;
    });
    await this.reload();
    return this.requireTask(taskId);
  }

  /** Creates the next plan version. Earlier versions and their approvals stay in history but no longer match. */
  async revisePlan(taskId: string, scope: string[], now: Date, document?: PlanDocument, submittedBy: 'user' | 'claude' = 'user', sessionId: string | null = null, repositories?: PlanRepository[]): Promise<Task> {
    const task = this.requireTask(taskId);
    const at = now.toISOString();
    const version = task.plan.version + 1;
    await this.database.db.transaction().execute(async (trx) => {
      // The plan built on the analysts' reports closes the analysis.
      if (task.state === 'PARALLEL_ANALYSIS') await this.transition(trx, taskId, 'analysis.completed', 'core', `plan version ${version} submitted`, at);
      await this.transition(trx, taskId, 'plan.revised', submittedBy, `plan version ${version}`, at);
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'plan.revised', at);
      await insertPlan(trx, { taskId, title: task.title, repoRoot: task.repoRoot, version, scope, document, repositories, at });
      await trx.updateTable('tasks').set({ current_plan_version: version, updated_at: at }).where('task_id', '=', taskId).execute();
      await audit(trx, at, 'plan.revise', taskId, { version, scope, withDocument: document !== undefined, ...(repositories === undefined || repositories.length === 0 ? {} : { repositories: repositories.map((repository) => repository.repoRoot) }) }, actorOf(submittedBy));
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
    if (request.review !== undefined && !accepting) throw new StateError(400, 'review applies only to accepting an implementation (stage IMPLEMENTATION, decision APPROVED)');
    if (request.artifact !== undefined && !approvingPlan) throw new StateError(400, 'artifact applies only to approving a plan (stage PLAN, decision APPROVED)');
    // Review is the user's choice at acceptance, within the review mode of the task's project.
    let review: boolean | null = null;
    if (accepting) {
      const choice = resolveReviewChoice(this.effectiveReviewModeOf(task), request.review);
      if (!choice.ok) throw new StateError(400, choice.reason);
      review = choice.review;
    }
    // Without review the final checks run at once and compare the repository with the report's snapshot.
    const gitNow = approvingPlan ? await this.prepareSnapshots(task, 'plan.approved') : review === false ? await this.prepareSnapshots(task, 'report') : null;
    // The first review round covers every file changed since the plan was approved.
    const toReview = review === true ? await this.changesSincePlanApproval(task) : [];
    const record = await this.database.db.transaction().execute(async (trx) => {
      const label = request.stage === 'PLAN' ? 'plan' : request.stage === 'IMPLEMENTATION' ? 'implementation report' : 'review fix plan';
      const subject =
        request.stage === 'PLAN'
          ? { version: task.plan.version, contentHash: task.plan.contentHash }
          : request.stage === 'IMPLEMENTATION'
            ? await latestReportSubject(trx, taskId)
            : await latestFixPlanSubject(trx, taskId);
      if (subject === null) throw new StateError(409, request.stage === 'REVIEW_FIX' ? `${taskId} has no fix plan to decide on` : `${taskId} has no implementation report to decide on`);
      if (request.version !== subject.version) {
        throw new StateError(409, `${taskId} ${label} is at version ${subject.version}; refusing a decision for version ${request.version}`);
      }
      // The plan is read again inside the transaction: a revision submitted meanwhile is not what the
      // user saw, so the decision must not bind to it.
      if (request.stage === 'PLAN') {
        const stored = await trx
          .selectFrom('tasks')
          .innerJoin('plans', (join) => join.onRef('plans.task_id', '=', 'tasks.task_id').onRef('plans.version', '=', 'tasks.current_plan_version'))
          .select(['plans.version', 'plans.content_hash'])
          .where('tasks.task_id', '=', taskId)
          .executeTakeFirst();
        if (stored === undefined || stored.version !== subject.version || stored.content_hash !== subject.contentHash) {
          throw new StateError(409, `${taskId} plan changed while the decision was being recorded (now version ${stored?.version ?? '?'}); decide on the current version`);
        }
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
        ...(review === null ? {} : { review }),
      };
      const approved = record.decision === 'APPROVED';
      const event: WorkflowEvent =
        request.stage === 'PLAN' ? (approved ? 'plan.approved' : 'plan.rejected') : request.stage === 'IMPLEMENTATION' ? (approved ? 'implementation.accepted' : 'changes.requested') : approved ? 'fixes.approved' : 'fixes.rejected';
      const reason = record.comment === '' ? `${label} version ${record.version}${review === null ? '' : review ? ', with independent review' : ', without review'}` : record.comment;
      await this.transition(trx, taskId, event, 'user', reason, at, review === null ? {} : { review });
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
          review: review === null ? null : review ? 1 : 0,
        })
        .execute();
      await audit(trx, at, `approval.${record.decision.toLowerCase()}`, taskId, { stage: record.stage, version: record.version, contentHash: record.contentHash, channel, ...(review === null ? {} : { review }) });
      if (event === 'plan.approved' && gitNow !== null) await insertSnapshots(trx, gitNow, 'plan.approved', at);
      // The user's Artifact switch, chosen with the approval.
      if (event === 'plan.approved' && request.artifact !== undefined) await writeArtifactRequest(trx, taskId, request.artifact, at, channel);
      // Accepting the implementation with review starts the independent review, whose end runs the
      // final checks; without review the final checks run now.
      if (event === 'implementation.accepted' && review === true) {
        const previous = await trx.selectFrom('review_rounds').select((eb) => eb.fn.max('round').as('round')).where('task_id', '=', taskId).executeTakeFirst();
        // The reviewers this change needs, from the plan's classification and the files to review.
        const reviewers = reviewersFor({ classification: task.plan.document?.classification, changedFiles: toReview.length, repositories: taskRepositoryRoots(task).length });
        await trx.insertInto('review_rounds').values({ task_id: taskId, round: Number(previous?.round ?? 0) + 1, started_at: at, changed_files_json: JSON.stringify(toReview), reviewers_json: JSON.stringify(reviewers) }).execute();
      }
      if (event === 'implementation.accepted' && review === false) await this.runFinalChecks(trx, task, at, gitNow);
      if (event === 'fixes.approved') await trx.updateTable('review_rounds').set({ fixes_approved_at: at }).where('task_id', '=', taskId).where('round', '=', record.version).execute();
      return record;
    });
    await this.reload();
    return record;
  }

  /**
   * Reads Git for a task's repository. Never throws: when Git cannot be read the reason
   * is kept, and checks that depend on Git say so instead of guessing.
   */
  private async prepareSnapshot(task: Task, kind: SnapshotKind): Promise<PreparedSnapshot> {
    try {
      const snapshot = await this.git.snapshot(task.repoRoot);
      if (kind === 'plan.approved') {
        const dirty = [...new Set([...snapshot.staged, ...snapshot.unstaged, ...snapshot.untracked])];
        return { snapshot, error: null, fingerprints: fingerprintFiles(task.repoRoot, dirty), changed: dirty };
      }
      const baseline = await latestSnapshot(this.database.db, task.taskId, 'plan.approved', task.repoRoot);
      const changed = await this.git.changedSince(task.repoRoot, baseline?.head ?? snapshot.head);
      return { snapshot, error: null, fingerprints: fingerprintFiles(task.repoRoot, changed), changed };
    } catch (error) {
      return { snapshot: null, error: error instanceof Error ? error.message : String(error), fingerprints: {}, changed: [] };
    }
  }

  /** One Git reading per repository of the task (its own first), in parallel. */
  private async prepareSnapshots(task: Task, kind: SnapshotKind): Promise<PreparedSnapshots> {
    return Promise.all(repoViews(task).map(async (view) => ({ view, prepared: await this.prepareSnapshot(view, kind) })));
  }

  /**
   * True when a file had the user's uncommitted changes when the task's plan was approved and
   * Claude has not been warned about it yet. Pure lookup: previews do not use it up. The file is
   * relative to `repoRoot` (the task's own repository when absent): the same path in two
   * repositories is two files.
   */
  isUserChangedFile(taskId: string, relativePath: string, repoRoot?: string): boolean {
    const repo = this.dirtyKey(taskId, repoRoot);
    if (repo === null) return false;
    const key = fileKey(relativePath);
    return this.userDirty.get(repo)?.has(key) === true && !this.userFileWarnings.has(`${repo}|${key}`);
  }

  /** Called once the warning was recorded for a real edit. */
  markUserFileWarned(taskId: string, relativePath: string, repoRoot?: string): void {
    const repo = this.dirtyKey(taskId, repoRoot);
    if (repo !== null) this.userFileWarnings.add(`${repo}|${fileKey(relativePath)}`);
  }

  private dirtyKey(taskId: string, repoRoot: string | undefined): string | null {
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) return null;
    return `${taskId}|${rootKey(repoRoot ?? task.repoRoot)}`;
  }

  /** The review mode of a task: the strictest of its repositories' (a multi-repository task is reviewed if any requires it). */
  effectiveReviewModeOf(task: Task): ReviewMode {
    const modes = taskRepositories(task).map((repository) => this.effectiveReviewModeAt(repository.repoRoot));
    return modes.includes('required') ? 'required' : (modes[0] ?? DEFAULT_REVIEW_MODE);
  }

  /** The Git baseline of the task's latest plan approval, as task details show it. */
  async taskBaseline(taskId: string): Promise<TaskDetail['baseline']> {
    const task = this.requireTask(taskId);
    const row = await this.baselineRow(taskId, task.repoRoot);
    if (row === undefined) return null;
    return { at: row.created_at, head: row.head, branch: row.branch, upstream: row.upstream, remoteUrl: row.remote_url, userFiles: userFilesOf(row), truncated: row.truncated === 1, error: row.error };
  }

  /** The baselines of the other repositories of a multi-repository task; undefined for one repository. */
  async taskBaselines(taskId: string): Promise<TaskDetail['baselines']> {
    const task = this.requireTask(taskId);
    const others = taskRepositories(task).filter((repository) => !repository.primary);
    if (others.length === 0) return undefined;
    const result: NonNullable<TaskDetail['baselines']> = [];
    for (const repository of others) {
      const row = await this.baselineRow(taskId, repository.repoRoot);
      if (row !== undefined) result.push({ repoRoot: repository.repoRoot, at: row.created_at, head: row.head, branch: row.branch, userFiles: userFilesOf(row), truncated: row.truncated === 1, error: row.error });
    }
    return result;
  }

  private async baselineRow(taskId: string, repoRoot: string): Promise<Selectable<JerrySchema['git_snapshots']> | undefined> {
    const rows = await this.database.db.selectFrom('git_snapshots').selectAll().where('task_id', '=', taskId).where('kind', '=', 'plan.approved').orderBy('id', 'desc').execute();
    return rows.find((row) => sameRoot(row.repo_root, repoRoot));
  }

  /** What changed in the repository since the task's last checkpoint, if one was taken. */
  /**
   * In-scope files changed since the plan was approved, from read-only Git; the user's
   * files that were already changed then and have not changed since are left out.
   */
  async changesSincePlanApproval(task: Task, options: { withinScope?: boolean } = {}): Promise<string[]> {
    const changed: string[] = [];
    // Every repository of the task, each against its own scope; another repository's files are shown absolute.
    for (const { view, prepared: now } of await this.prepareSnapshots(task, 'report')) {
      const baseline = await latestSnapshot(this.database.db, task.taskId, 'plan.approved', view.repoRoot);
      const userAtBaseline = baseline?.fingerprints ?? {};
      changed.push(
        ...now.changed
          .filter((file) => !(file in userAtBaseline) || userAtBaseline[file] !== now.fingerprints[file])
          // The report draft wants every change, out-of-scope ones too: the report has to name them.
          .filter((file) => options.withinScope === false || matchesAnyGlob(file, view.plan.scope, process.platform === 'win32'))
          .sort()
          .map((file) => shownPath(view, file)),
      );
    }
    return changed;
  }

  async changesSinceCheckpoint(task: Task, budgetMs = 700): Promise<{ headBefore: string | null; headNow: string | null; changedFiles: number } | null> {
    const checkpoint = await latestSnapshot(this.database.db, task.taskId, 'checkpoint', task.repoRoot);
    if (checkpoint === null) return null;
    const now = await Promise.race([this.prepareSnapshot(task, 'checkpoint'), new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs))]);
    if (now === null || now.snapshot === null) return null;
    const files = new Set([...Object.keys(checkpoint.fingerprints), ...Object.keys(now.fingerprints)]);
    const changedFiles = [...files].filter((file) => checkpoint.fingerprints[file] !== now.fingerprints[file]).length;
    return { headBefore: checkpoint.head, headNow: now.snapshot.head, changedFiles };
  }

  /**
   * The DONE validator: Core gathers the facts, records the result, and sets DONE only
   * when every blocking condition passed. No model and no API call can set DONE otherwise.
   */
  private async runFinalChecks(trx: Transaction<JerrySchema>, task: Task, at: string, gitNow: PreparedSnapshots | null): Promise<CompletionCheck> {
    const reportRow = await trx.selectFrom('implementation_reports').selectAll().where('task_id', '=', task.taskId).orderBy('version', 'desc').limit(1).executeTakeFirst();
    const report = reportRow === undefined ? null : reportFromRow(reportRow);
    // The review: approved fixes after the report are legitimate, so edits count
    // from the end of the last review round (or the user's waiver) when that is later.
    const rounds = await trx.selectFrom('review_rounds').selectAll().where('task_id', '=', task.taskId).orderBy('round').execute();
    const lastRound = rounds.at(-1);
    // Edits after the report: seen by the hooks (file tools), and by Git (also shell commands). Edits
    // made between the user's approval of a fix plan and the fixes report are the approved fixes;
    // the re-review covered them. Everything else after the report still counts.
    const fixWindows = rounds.filter((round) => round.fixes_approved_at !== null).map((round) => ({ from: round.fixes_approved_at!, until: round.fixes_reported_at ?? at }));
    const lastFixes = rounds.map((round) => round.fixes_reported_at).filter((value): value is string => value !== null).sort().at(-1) ?? null;
    // Every repository of the task, each with its own scope and snapshots; another repository's files
    // are shown absolute.
    const remaining: string[] = [];
    const laterByTask = new Map<string, string[]>();
    const unreadable: string[] = [];
    for (const view of repoViews(task)) {
      const now = gitNow?.find((entry) => sameRoot(entry.view.repoRoot, view.repoRoot))?.prepared ?? null;
      if (!isPrimary(view) && now !== null && now.snapshot === null) unreadable.push(`${view.repoRoot}: ${now.error ?? 'Git could not be read'}`);
      const hookEdits = report === null ? [] : await fileEditsInScopeBetween(trx, view, report.createdAt, at, fixWindows);
      const reviewSnapshot = lastFixes === null ? null : await latestSnapshot(trx, task.taskId, 'review', view.repoRoot);
      const baselineSnapshot = reviewSnapshot !== null && reviewSnapshot.createdAt >= lastFixes! ? reviewSnapshot : await latestSnapshot(trx, task.taskId, 'report', view.repoRoot);
      const gitEdits = report === null || baselineSnapshot === null || now === null || now.snapshot === null ? [] : changedInScope(view, baselineSnapshot.fingerprints, now.fingerprints);
      // Later approved work of other tasks on the same files does not hold this task back.
      const attributed = await attributeEditsSinceReport(trx, view, hookEdits, gitEdits);
      remaining.push(...attributed.remaining.map((file) => shownPath(view, file)));
      for (const work of attributed.laterWork) laterByTask.set(work.taskId, [...(laterByTask.get(work.taskId) ?? []), ...work.files.map((file) => shownPath(view, file))]);
    }
    const laterWork: LaterWork[] = [...laterByTask].sort(([a], [b]) => a.localeCompare(b)).map(([taskId, files]) => ({ taskId, files }));
    const decisions = await trx.selectFrom('approvals').selectAll().where('task_id', '=', task.taskId).orderBy('approved_at').orderBy(sql`rowid`).execute();
    const approvals = decisions.map(approvalFromRow);
    const acceptance = report === null ? null : decisionFor(approvals, { taskId: task.taskId, stage: 'IMPLEMENTATION', version: report.version, contentHash: report.contentHash });
    let review: Parameters<typeof evaluateCompletion>[0]['review'];
    // Accepted without review: earlier rounds (of reports sent back since) do not apply.
    if (acceptance?.decision === 'APPROVED' && acceptance.review === false) {
      review = { requested: false };
    } else if (lastRound !== undefined) {
      const submissions = await trx.selectFrom('review_submissions').selectAll().where('task_id', '=', task.taskId).execute();
      const own = submissions.filter((submission) => submission.round === lastRound.round);
      const reviewed = new Set(own.flatMap((submission) => (JSON.parse(submission.files_reviewed_json) as string[]).map(fileKey)));
      const openReview = await trx.selectFrom('findings').selectAll().where('task_id', '=', task.taskId).where('source', '=', 'review').where('status', 'in', ['OPEN', 'ACCEPTED']).execute();
      review = {
        outcome: lastRound.passed_at !== null ? 'passed' : lastRound.skipped_at !== null ? 'skipped' : null,
        rounds: rounds.length,
        reason: lastRound.skip_reason ?? '',
        uncovered: lastRound.skipped_at !== null && own.length === 0 ? [] : (JSON.parse(lastRound.changed_files_json) as string[]).filter((file) => !reviewed.has(fileKey(file))),
        notIndependent: [...new Set(submissions.filter((submission) => submission.independent === 0).map((submission) => submission.role))],
        openFindings: openReview.map((finding) => `FND-${finding.id} ${finding.severity} ${finding.file}:${finding.line_start} ${finding.title}`),
      };
    }
    const result = evaluateCompletion({
      currentPlanVersion: task.plan.version,
      planApproved: currentPlanDecision(task, approvals)?.decision === 'APPROVED',
      report,
      reportAccepted: acceptance?.decision === 'APPROVED',
      editsSinceReport: remaining,
      laterWork,
      definitionOfDone: task.plan.document?.definitionOfDone ?? [],
      ...(review === undefined ? {} : { review }),
    });
    // A multi-repository task: each of its repositories must still be readable, or JERRY cannot tell
    // what changed there.
    const conditions = [...result.conditions];
    if (taskRepositories(task).length > 1 && gitNow !== null) {
      conditions.push({
        id: 'repositories.readable',
        blocking: true,
        passed: unreadable.length === 0,
        detail: unreadable.length === 0 ? 'every repository of the task could be read' : `repositories JERRY could not read: ${unreadable.join('; ')}`,
      });
    }
    const passed = result.passed && unreadable.length === 0;
    const check: CompletionCheck = { taskId: task.taskId, reportVersion: report?.version ?? null, at, passed, conditions, definitionOfDone: task.plan.document?.definitionOfDone ?? [], laterWork };
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
    return new Map(rows.map((row) => [row.task_id, completionCheckFromRow(row)]));
  }

  /**
   * The user re-runs the final checks of a task Core held in FINAL_REPORT, for example after the
   * later task that changed its files reported. DONE follows through the same path when they pass.
   */
  async rerunFinalChecks(taskId: string, now: Date, channel: Channel): Promise<{ check: CompletionCheck; state: WorkflowState }> {
    const task = this.requireTask(taskId);
    if (task.state !== 'FINAL_REPORT') throw new StateError(409, `${taskId} is ${task.state}; final checks can be re-run only while the task is waiting in FINAL_REPORT`);
    const gitNow = await this.prepareSnapshots(task, 'report');
    const at = now.toISOString();
    const check = await this.database.db.transaction().execute(async (trx) => {
      // The state is read again inside the transaction: a concurrent request may have moved the task on.
      const row = await trx.selectFrom('tasks').select('state').where('task_id', '=', taskId).executeTakeFirst();
      if (row?.state !== 'FINAL_REPORT') throw new StateError(409, `${taskId} is ${row?.state ?? 'unknown'}; final checks can be re-run only while the task is waiting in FINAL_REPORT`);
      await audit(trx, at, 'task.final-checks-rerun', taskId, { channel });
      return this.runFinalChecks(trx, task, at, gitNow);
    });
    await this.reload();
    return { check, state: this.requireTask(taskId).state };
  }

  /**
   * Claude's implementation report: the next report version, with what JERRY recorded
   * itself since the plan was approved. Only a task in implementation can report.
   */
  async submitReport(taskId: string, document: ImplementationReport, submittedBy: 'user' | 'claude', sessionId: string | null, now: Date): Promise<ImplementationReportRecord> {
    const task = this.requireTask(taskId);
    const at = now.toISOString();
    // A change names its repository only when it is another one of the task's.
    const roots = taskRepositories(task).map((repository) => repository.repoRoot);
    const unknown = [...new Set(document.changes.map((change) => change.repository.trim()).filter((repository) => repository !== '' && !roots.some((root) => sameRoot(root, repository))))];
    if (unknown.length > 0) {
      throw new StateError(400, `The report names repositories that are not part of ${taskId}'s plan: ${unknown.join(', ')}. Use one of ${roots.join(', ')}, or leave repository empty for ${task.repoRoot}.`);
    }
    const gitNow = await this.prepareSnapshots(task, 'report');
    const quality = await this.qualityEvidence(task, document);
    const record = await this.database.db.transaction().execute(async (trx) => {
      const previous = await latestReportSubject(trx, taskId);
      const version = (previous?.version ?? 0) + 1;
      await this.transition(trx, taskId, 'report.submitted', submittedBy, `implementation report version ${version}`, at);
      const evidence = { ...(await evidenceOfRepositories(trx, gitNow, document, at)), quality };
      await insertSnapshots(trx, gitNow, 'report', at);
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
    const entrypoint = registration.entrypoint?.trim().slice(0, MAX_ENTRYPOINT_LENGTH) || null;
    await this.database.db
      .insertInto('sessions')
      .values({ session_id: registration.sessionId, cwd: registration.cwd, source: registration.source, entrypoint, first_seen_at: at, last_seen_at: at, created_at: at, updated_at: at })
      // A session that starts again (resume, compaction) is running again. A registration without
      // an entrypoint (an older bridge) keeps the one already known.
      .onConflict((conflict) =>
        conflict.column('session_id').doUpdateSet({ cwd: registration.cwd, source: registration.source, entrypoint: sql`COALESCE(excluded.entrypoint, entrypoint)`, last_seen_at: at, ended_at: null, end_reason: null, updated_at: at }),
      )
      .execute();
    await this.reload();
  }

  /**
   * Records that a session worked on a task. Unknown tasks are ignored: the link is
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

  /** An analyst's report with Core's citation check; open tasks only. */
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
      // The first analyst's report moves a task in discovery into analysis.
      if (task.state === 'DISCOVERY') await this.transition(trx, taskId, 'analysis.started', 'core', `first analysis report (${report.role})`, at);
      return inserted.id;
    });
    if (task.state === 'DISCOVERY') await this.reload();
    return { id, taskId, report, citations, sessionId, agentId, createdAt: at };
  }

  /**
   * Applies one quality check of some files. For each checked file: findings seen again are
   * refreshed (and reopened if they had been FIXED), new ones are OPEN, and OPEN or ACCEPTED findings
   * the check no longer reports are FIXED with the reason. The user's dismissals stay as they are.
   */
  async applyQualityBatch(batch: {
    taskId: string | null;
    repoRoot: string;
    sessionId: string | null;
    agentId: string | null;
    files: ReadonlyArray<{ file: string; findings: readonly DetectedFinding[]; planRelated: boolean }>;
    startedAt: Date;
    durationMs: number;
    error?: string | null;
  }): Promise<{ created: number; fixed: number; reopened: number }> {
    const at = new Date(batch.startedAt.getTime() + batch.durationMs).toISOString();
    const result = { created: 0, fixed: 0, reopened: 0 };
    await this.database.db.transaction().execute(async (trx) => {
      for (const checked of batch.files) {
        let query = trx.selectFrom('findings').selectAll().where('repo_root', '=', batch.repoRoot).where('file', '=', checked.file);
        query = batch.taskId === null ? query.where('task_id', 'is', null) : query.where('task_id', '=', batch.taskId);
        const existing = await query.execute();
        const byKey = new Map(existing.map((row) => [`${row.rule_id}\n${row.fingerprint}`, row]));
        const seen = new Set<string>();
        for (const finding of checked.findings) {
          const key = `${finding.ruleId}\n${finding.fingerprint}`;
          seen.add(key);
          const row = byKey.get(key);
          const fields = {
            rule_version: finding.ruleVersion,
            line_start: finding.lineStart,
            line_end: finding.lineEnd,
            title: finding.title,
            evidence: finding.evidence,
            severity: finding.severity,
            confidence: finding.confidence,
            plan_related: checked.planRelated ? 1 : 0,
            last_seen_at: at,
            updated_at: at,
          };
          if (row === undefined) {
            const inserted = await trx
              .insertInto('findings')
              .values({
                ...fields,
                task_id: batch.taskId,
                repo_root: batch.repoRoot,
                file: checked.file,
                rule_id: finding.ruleId,
                fingerprint: finding.fingerprint,
                source: finding.source,
                category: finding.category,
                why: finding.whyItMatters,
                fix: finding.suggestedFix,
                status: 'OPEN',
                status_reason: '',
                session_id: batch.sessionId,
                agent_id: batch.agentId,
                fed_back_at: null,
                first_seen_at: at,
                created_at: at,
              })
              .returning('id')
              .executeTakeFirstOrThrow();
            await insertFindingEvent(trx, inserted.id, null, 'OPEN', 'core', `found by ${finding.ruleId} ${finding.ruleVersion}`, at);
            result.created += 1;
          } else if (row.status === 'FIXED') {
            await trx.updateTable('findings').set({ ...fields, status: 'OPEN', status_reason: '', fed_back_at: null, session_id: batch.sessionId, agent_id: batch.agentId }).where('id', '=', row.id).execute();
            await insertFindingEvent(trx, row.id, 'FIXED', 'OPEN', 'core', `found again in ${checked.file}:${finding.lineStart}`, at);
            result.reopened += 1;
          } else {
            await trx.updateTable('findings').set(fields).where('id', '=', row.id).execute();
          }
        }
        for (const row of existing) {
          if (seen.has(`${row.rule_id}\n${row.fingerprint}`) || (row.status !== 'OPEN' && row.status !== 'ACCEPTED')) continue;
          const reason = `no longer found in ${checked.file} after the change at ${at}`;
          await trx.updateTable('findings').set({ status: 'FIXED', status_reason: reason, updated_at: at }).where('id', '=', row.id).execute();
          await insertFindingEvent(trx, row.id, findingStatusSchema.parse(row.status), 'FIXED', 'core', reason, at);
          result.fixed += 1;
        }
      }
      await trx
        .insertInto('quality_batches')
        .values({
          task_id: batch.taskId,
          repo_root: batch.repoRoot,
          session_id: batch.sessionId,
          files_json: JSON.stringify(batch.files.map((checked) => checked.file)),
          started_at: batch.startedAt.toISOString(),
          duration_ms: Math.round(batch.durationMs),
          new_count: result.created + result.reopened,
          fixed_count: result.fixed,
          error: batch.error ?? null,
        })
        .execute();
    });
    return result;
  }

  /** The user's decision on a finding, always with a reason. FIXED is Core's alone. */
  async setFindingStatus(findingId: string, status: Exclude<FindingStatus, 'FIXED'>, reason: string, now: Date, channel: Channel): Promise<Finding> {
    const id = findingNumber(findingId);
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('findings').select(['status']).where('id', '=', id).executeTakeFirst();
      if (row === undefined) throw new StateError(404, `Unknown finding ${findingId}`);
      if (row.status === status) throw new StateError(409, `${findingId} is already ${status}`);
      if (status === 'OPEN' && row.status === 'OPEN') throw new StateError(409, `${findingId} is already open`);
      await trx.updateTable('findings').set({ status, status_reason: reason, updated_at: at }).where('id', '=', id).execute();
      await insertFindingEvent(trx, id, findingStatusSchema.parse(row.status), status, 'user', reason, at);
      await audit(trx, at, 'finding.status', findingId, { from: row.status, to: status, reason, channel });
    });
    return (await this.findings({ findingId }))[0]!;
  }

  /** Findings, newest first; filters combine. */
  async findings(filter: { findingId?: string; taskId?: string; repoRoot?: string; statuses?: readonly FindingStatus[]; file?: string; limit?: number } = {}): Promise<Finding[]> {
    let query = this.database.db.selectFrom('findings').selectAll();
    if (filter.findingId !== undefined) query = query.where('id', '=', findingNumber(filter.findingId));
    if (filter.taskId !== undefined) query = query.where('task_id', '=', filter.taskId);
    if (filter.repoRoot !== undefined) query = process.platform === 'win32' ? query.where(sql`lower(repo_root)`, '=', filter.repoRoot.toLowerCase()) : query.where('repo_root', '=', filter.repoRoot);
    if (filter.statuses !== undefined && filter.statuses.length > 0) query = query.where('status', 'in', [...filter.statuses]);
    if (filter.file !== undefined) query = query.where('file', '=', filter.file);
    const rows = await query.orderBy('id', 'desc').limit(filter.limit ?? 500).execute();
    return rows.map(findingFromRow);
  }

  async findingHistory(findingId: string): Promise<FindingEvent[]> {
    const rows = await this.database.db.selectFrom('finding_events').selectAll().where('finding_id', '=', findingNumber(findingId)).orderBy('id').execute();
    return rows.map((row) => ({ findingId: `FND-${row.finding_id}`, from: row.from_status === null ? null : findingStatusSchema.parse(row.from_status), to: findingStatusSchema.parse(row.to_status), actor: row.actor === 'user' ? 'user' : 'core', reason: row.reason, at: row.at }));
  }

  /** Open findings by severity, plus fixed and dismissed totals, per task. */
  async findingCounts(): Promise<Map<string, FindingCounts>> {
    const rows = await this.database.db
      .selectFrom('findings')
      .select(['task_id', 'status', 'severity', (eb) => eb.fn.countAll<number>().as('count')])
      .where('task_id', 'is not', null)
      .groupBy(['task_id', 'status', 'severity'])
      .execute();
    const counts = new Map<string, FindingCounts>();
    for (const row of rows) {
      const entry = counts.get(row.task_id!) ?? { open: 0, bySeverity: { P1: 0, P2: 0, P3: 0, P4: 0 }, fixed: 0, dismissed: 0 };
      const count = Number(row.count);
      if (row.status === 'OPEN' || row.status === 'ACCEPTED') {
        entry.open += count;
        const severity = findingSeveritySchema.safeParse(row.severity);
        if (severity.success) entry.bySeverity[severity.data] += count;
      } else if (row.status === 'FIXED') entry.fixed += count;
      else entry.dismissed += count;
      counts.set(row.task_id!, entry);
    }
    return counts;
  }

  /** How often the user marked each rule's findings as false positives: the calibration signal. */
  async falsePositivesByRule(): Promise<Map<string, number>> {
    const rows = await this.database.db.selectFrom('findings').select(['rule_id', (eb) => eb.fn.countAll<number>().as('count')]).where('status', '=', 'FALSE_POSITIVE').groupBy('rule_id').execute();
    return new Map(rows.map((row) => [row.rule_id, Number(row.count)]));
  }

  /**
   * Open findings Claude has not been told about yet, for a session's task; marks them
   * as told, so each goes out once. P4 findings are left to the dashboard.
   */
  async takeFeedback(taskId: string, now: Date, limit = 5): Promise<Finding[]> {
    const { db } = this.database;
    const rows = await db
      .selectFrom('findings')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('status', '=', 'OPEN')
      .where('fed_back_at', 'is', null)
      .where('severity', 'in', ['P1', 'P2', 'P3'])
      // After MAX_AUTO_FIX_ROUNDS fixes that came back, the finding waits for the user.
      .where(
        'id',
        'not in',
        db
          .selectFrom('finding_events')
          .select('finding_id')
          .where('from_status', '=', 'FIXED')
          .where('to_status', '=', 'OPEN')
          .groupBy('finding_id')
          .having((eb) => eb.fn.countAll(), '>=', MAX_AUTO_FIX_ROUNDS),
      )
      .orderBy('severity')
      .orderBy('id')
      .limit(limit)
      .execute();
    if (rows.length > 0) {
      await this.database.db
        .updateTable('findings')
        .set({ fed_back_at: now.toISOString() })
        .where(
          'id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
    }
    return rows.map(findingFromRow);
  }

  /**
   * Records who works on what: up to three implementers, each with plan steps and the
   * files only it edits. A new set replaces the previous one. Overlapping files are refused.
   */
  async assignWork(taskId: string, requested: ReadonlyArray<{ label: string; steps: number[]; files: string[] }>, sessionId: string | null, now: Date): Promise<Assignment[]> {
    const task = this.requireTask(taskId);
    if (!WORK_STATES.has(task.state) || this.planDecision(taskId)?.decision !== 'APPROVED') throw new StateError(409, `${taskId} is not being implemented under an approved plan; assign work after the user approves it`);
    if (requested.length > MAX_SUBAGENTS) throw new StateError(400, `At most ${MAX_SUBAGENTS} implementers work at a time; got ${requested.length}`);
    const labels = requested.map((assignment) => assignment.label.toLowerCase());
    if (new Set(labels).size !== labels.length) throw new StateError(400, 'Each implementer needs its own label');
    const steps = task.plan.document?.steps ?? [];
    const insensitive = process.platform === 'win32';
    const resolved = requested.map((assignment) => {
      const unknown = assignment.steps.filter((number) => number < 1 || number > steps.length);
      if (unknown.length > 0) throw new StateError(400, `${assignment.label}: the plan has no step ${unknown.join(', ')} (it has ${steps.length})`);
      const files = [...new Set(assignment.files.length > 0 ? assignment.files : assignment.steps.flatMap((number) => steps[number - 1]!.files))].map((file) => file.trim().replaceAll('\\', '/').replace(/^\.\//, ''));
      if (files.length === 0) throw new StateError(400, `${assignment.label}: no files; name them, or assign steps that list files`);
      const outside = files.filter((file) => !matchesAnyGlob(file.replace(/\*\*?.*$/, 'x'), task.plan.scope, insensitive));
      if (outside.length > 0) throw new StateError(400, `${assignment.label}: outside the approved scope: ${outside.join(', ')}`);
      return { label: assignment.label, steps: [...new Set(assignment.steps)].sort((a, b) => a - b), files };
    });
    for (let left = 0; left < resolved.length; left += 1) {
      for (let right = left + 1; right < resolved.length; right += 1) {
        const a = resolved[left]!;
        const b = resolved[right]!;
        const shared = a.files.flatMap((file) => b.files.filter((other) => globsOverlap(file, other, insensitive)).map((other) => `${file} / ${other}`));
        if (shared.length > 0) throw new StateError(400, `${a.label} and ${b.label} would share files (${shared.slice(0, 5).join('; ')}); give each implementer disjoint files, or serialize those steps`);
      }
    }
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      await trx.updateTable('implementer_assignments').set({ released_at: at }).where('task_id', '=', taskId).where('released_at', 'is', null).execute();
      for (const assignment of resolved) {
        await trx
          .insertInto('implementer_assignments')
          .values({ task_id: taskId, label: assignment.label, steps_json: JSON.stringify(assignment.steps), files_json: JSON.stringify(assignment.files), agent_id: null, session_id: sessionId, created_at: at, released_at: null })
          .execute();
      }
      await audit(trx, at, 'work.assign', taskId, { assignments: resolved }, 'claude-code');
    });
    await this.loadAssignments();
    return this.assignmentsOf(taskId);
  }

  assignmentsOf(taskId: string): Assignment[] {
    return structuredClone(this.assignments.get(taskId) ?? []);
  }

  /**
   * The implementer checks of an edit, synchronous for the gate:
   *   - another active subagent edited this file recently: the writes must be serialized;
   *   - an implementer edits outside its assignment, or a file assigned to another implementer.
   * Warnings only. `agentId` is null for the main session.
   */
  implementerCheck(taskId: string, agentId: string | null, relative: string, repoRoot?: string): { ruleId: string; reason: string } | null {
    // In another repository of the task the file is named absolute, as plans and assignments name it there.
    const file = this.taskFile(taskId, relative, repoRoot);
    const key = `${taskId}|${fileKey(file)}`;
    const writer = this.recentWriters.get(key);
    if (writer !== undefined && writer.agentId !== agentId && this.isAgentActive(writer.agentId)) {
      return { ruleId: 'monitor.concurrent-write', reason: `${file} is being edited by another running subagent (${writer.agentId}); writes to one file must be serialized. Wait for it to finish, or hand the file over explicitly.` };
    }
    if (agentId === null || !(this.agentTypeOf(agentId) ?? '').includes('jerry-implementer')) return null;
    const assignments = this.assignments.get(taskId) ?? [];
    if (assignments.length === 0) return null;
    const insensitive = process.platform === 'win32';
    const inFiles = (assignment: Assignment): boolean => matchesAnyGlob(file, assignment.files, insensitive) || assignment.files.some((entry) => fileKey(entry) === fileKey(file));
    const own = assignments.find((assignment) => assignment.agentId === agentId);
    if (own !== undefined) {
      return inFiles(own) ? null : { ruleId: 'monitor.implementer-scope', reason: `${file} is outside ${own.label}'s assignment (${own.files.join(', ')}). The edit proceeds and is recorded; stay within your files or ask the orchestrator to reassign.` };
    }
    const matching = assignments.filter(inFiles);
    if (matching.some((assignment) => assignment.agentId === null)) return null;
    if (matching.length > 0) return { ruleId: 'monitor.implementer-scope', reason: `${file} belongs to ${matching.map((assignment) => assignment.label).join(', ')}, assigned to another implementer.` };
    return { ruleId: 'monitor.implementer-scope', reason: `${file} is in no implementer's assignment (${assignments.map((assignment) => assignment.label).join(', ')}).` };
  }

  /** After a real edit: remember the writer, and bind an implementer to its assignment by its first edit. */
  async noteWrite(taskId: string, relative: string, agentId: string | null, now: Date, repoRoot?: string): Promise<void> {
    if (agentId === null) return;
    const file = this.taskFile(taskId, relative, repoRoot);
    this.recentWriters.set(`${taskId}|${fileKey(file)}`, { agentId, at: now.getTime() });
    if (!(this.agentTypeOf(agentId) ?? '').includes('jerry-implementer')) return;
    const assignments = this.assignments.get(taskId) ?? [];
    if (assignments.some((assignment) => assignment.agentId === agentId)) return;
    const insensitive = process.platform === 'win32';
    const candidates = assignments.filter((assignment) => assignment.agentId === null && (matchesAnyGlob(file, assignment.files, insensitive) || assignment.files.some((entry) => fileKey(entry) === fileKey(file))));
    if (candidates.length !== 1) return;
    const chosen = candidates[0]!;
    chosen.agentId = agentId;
    await this.database.db.updateTable('implementer_assignments').set({ agent_id: agentId }).where('task_id', '=', taskId).where('label', '=', chosen.label).where('released_at', 'is', null).execute();
  }

  /** A file of a task as the task names it: relative in its own repository, absolute in another one. */
  private taskFile(taskId: string, relative: string, repoRoot: string | undefined): string {
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined || repoRoot === undefined || sameRoot(repoRoot, task.repoRoot)) return relative;
    return shownPath({ ...task, repoRoot, primaryRoot: task.repoRoot }, relative);
  }

  /** Where the work strays from the plan: files no step names, steps not started. */
  async planDrift(task: Task): Promise<PlanDrift> {
    const document = task.plan.document;
    const changed = await this.changesSincePlanApproval(task);
    const key = (value: string): string => fileKey(value.trim().replace(/^\.\//, ''));
    const named = (file: string, entries: readonly string[]): boolean =>
      entries.some((entry) => key(entry) === key(file) || (entry.endsWith('/') && key(file).startsWith(key(entry))) || matchesAnyGlob(file, [entry], process.platform === 'win32'));
    const steps = document?.steps ?? [];
    const allNamed = [...steps.flatMap((step) => step.files), ...(document?.changes.map((change) => change.target) ?? [])];
    const { layers, blocked } = planLayers(steps);
    return {
      taskId: task.taskId,
      unplannedFiles: document === undefined ? [] : changed.filter((file) => !named(file, allNamed)),
      untouchedSteps: steps.map((step, index) => ({ number: index + 1, step: step.step, files: step.files })).filter((step) => step.files.length > 0 && !changed.some((file) => named(file, step.files))).map(({ number, step }) => ({ number, step })),
      layers,
      blockedSteps: blocked,
      assignments: this.assignmentsOf(task.taskId),
    };
  }

  /** The plugin agent type of a subagent run, from SubagentStart. */
  agentTypeOf(agentId: string): string | null {
    const row = this.database.raw.prepare('SELECT agent_type FROM agent_runs WHERE agent_id = ?').get(agentId) as { agent_type: string | null } | undefined;
    return row?.agent_type ?? null;
  }

  private isAgentActive(agentId: string, now: Date = new Date()): boolean {
    const row = this.database.raw.prepare('SELECT started_at, stopped_at FROM agent_runs WHERE agent_id = ?').get(agentId) as { started_at: string; stopped_at: string | null } | undefined;
    return row !== undefined && row.stopped_at === null && now.getTime() - Date.parse(row.started_at) <= SUBAGENT_TIMEOUT_MS;
  }

  private async loadAssignments(): Promise<void> {
    const rows = await this.database.db.selectFrom('implementer_assignments').selectAll().where('released_at', 'is', null).orderBy('id').execute();
    const assignments = new Map<string, Assignment[]>();
    for (const row of rows) {
      const list = assignments.get(row.task_id) ?? [];
      list.push({ taskId: row.task_id, label: row.label, steps: JSON.parse(row.steps_json) as number[], files: JSON.parse(row.files_json) as string[], agentId: row.agent_id, createdAt: row.created_at });
      assignments.set(row.task_id, list);
    }
    this.assignments = assignments;
  }

  // --- The optional Artifact ----------------------------------------------------------------------

  /** The user's choice about an Artifact, recorded by the skill through MCP; the latest counts. */
  async recordArtifactDecision(taskId: string, decision: { decision: 'created'; kind: string; title: string; url: string } | { decision: 'declined'; reason: string }, sessionId: string | null, now: Date): Promise<ArtifactDecision> {
    this.requireTask(taskId);
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('artifact_decisions')
        .values({
          task_id: taskId,
          decision: decision.decision,
          kind: decision.decision === 'created' ? decision.kind : null,
          title: decision.decision === 'created' ? decision.title : null,
          url: decision.decision === 'created' ? decision.url : null,
          reason: decision.decision === 'declined' ? decision.reason : '',
          session_id: sessionId,
          created_at: at,
        })
        .execute();
      await audit(trx, at, `artifact.${decision.decision}`, taskId, decision.decision === 'created' ? { kind: decision.kind, url: decision.url } : { reason: decision.reason }, 'claude-code');
    });
    return (await this.artifactDecision(taskId))!;
  }

  async artifactDecision(taskId: string): Promise<ArtifactDecision | null> {
    const row = await this.database.db.selectFrom('artifact_decisions').selectAll().where('task_id', '=', taskId).orderBy('id', 'desc').limit(1).executeTakeFirst();
    return row === undefined ? null : artifactDecisionFromRow(row);
  }

  /** The latest decision of every task that has one, newest first (the dashboard's Artifacts list). */
  async artifactDecisions(): Promise<ArtifactDecision[]> {
    const { db } = this.database;
    const rows = await db
      .selectFrom('artifact_decisions')
      .selectAll()
      .where('id', 'in', db.selectFrom('artifact_decisions').select((eb) => eb.fn.max('id').as('id')).groupBy('task_id'))
      .orderBy('id', 'desc')
      .execute();
    return rows.map(artifactDecisionFromRow);
  }

  // --- Independent review -----------------------------------------------------------------------

  /** The reviewers a round expects: sized at its start, all three for rounds started before sizing. */
  private async roundReviewers(taskId: string, round: number): Promise<ReviewerRole[]> {
    const row = await this.database.db.selectFrom('review_rounds').select('reviewers_json').where('task_id', '=', taskId).where('round', '=', round).executeTakeFirst();
    return reviewersOf(row?.reviewers_json ?? null);
  }

  /** A reviewer's submission for the current round; the round completes when the reviewers it expects reported. */
  async submitReview(taskId: string, review: ReviewSubmission, sessionId: string | null, agentId: string | null, now: Date): Promise<ReviewState> {
    const task = this.requireTask(taskId);
    if (task.state !== 'CODE_REVIEW' && task.state !== 'REVERIFICATION') throw new StateError(409, `${taskId} is ${task.state}; reviews are submitted while it is in code review or re-verification`);
    const round = await this.currentRound(taskId);
    if (round === null) throw new StateError(409, `${taskId} has no open review round`);
    const at = now.toISOString();
    const submitted = new Set((await this.database.db.selectFrom('review_submissions').select('role').where('task_id', '=', taskId).where('round', '=', round.round).execute()).map((row) => row.role));
    submitted.add(review.role);
    // Another reviewer the user asked for is welcome; the round needs the ones it expects.
    const expected = await this.roundReviewers(taskId, round.round);
    const completes = expected.every((role) => submitted.has(role));
    const gitNow = completes ? await this.prepareSnapshots(task, 'report') : null;
    const independence = this.independenceOf(task, agentId);
    await this.database.db.transaction().execute(async (trx) => {
      // A resubmission of a role in the same round replaces the earlier one.
      await trx.deleteFrom('review_finding_sources').where('task_id', '=', taskId).where('round', '=', round.round).where('role', '=', review.role).execute();
      await trx.deleteFrom('review_submissions').where('task_id', '=', taskId).where('round', '=', round.round).where('role', '=', review.role).execute();
      for (const finding of review.findings) {
        // A file in another repository of the task is stored relative to that repository.
        const located = locateFile(task, finding.file);
        const file = located.relative;
        const fingerprint = createHash('sha256').update(`${fileKey(located.shown)}\n${finding.title.trim().toLowerCase().replace(/\s+/g, ' ')}`, 'utf8').digest('hex').slice(0, 16);
        const existing = await trx.selectFrom('findings').selectAll().where('task_id', '=', taskId).where('rule_id', '=', 'review').where('file', '=', file).where('fingerprint', '=', fingerprint).executeTakeFirst();
        let findingId: number;
        if (existing === undefined) {
          const inserted = await trx
            .insertInto('findings')
            .values({
              task_id: taskId,
              repo_root: located.repoRoot,
              file,
              rule_id: 'review',
              rule_version: '1',
              fingerprint,
              source: 'review',
              category: REVIEW_CATEGORY[review.role],
              severity: finding.severity,
              confidence: finding.confidence,
              line_start: finding.line,
              line_end: finding.lineEnd ?? finding.line,
              title: finding.title,
              evidence: finding.evidence,
              why: finding.whyItMatters,
              fix: finding.suggestedFix,
              plan_related: 0,
              status: 'OPEN',
              status_reason: '',
              session_id: sessionId,
              agent_id: agentId,
              fed_back_at: null,
              first_seen_at: at,
              last_seen_at: at,
              created_at: at,
              updated_at: at,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          findingId = inserted.id;
          await insertFindingEvent(trx, findingId, null, 'OPEN', 'core', `reported by ${review.role} in review round ${round.round}`, at);
        } else {
          findingId = existing.id;
          // The more severe report wins when two reviewers report the same problem.
          const severity = SEVERITY_RANK[finding.severity] < SEVERITY_RANK[existing.severity as FindingSeverity] ? finding.severity : existing.severity;
          await trx.updateTable('findings').set({ severity, last_seen_at: at, updated_at: at, line_start: finding.line, line_end: finding.lineEnd ?? finding.line }).where('id', '=', findingId).execute();
          if (existing.status === 'FIXED') {
            await trx.updateTable('findings').set({ status: 'OPEN', status_reason: '' }).where('id', '=', findingId).execute();
            await insertFindingEvent(trx, findingId, 'FIXED', 'OPEN', 'core', `reported again by ${review.role} in review round ${round.round}`, at);
          }
        }
        await trx.insertInto('review_finding_sources').values({ finding_id: findingId, task_id: taskId, round: round.round, role: review.role }).onConflict((conflict) => conflict.doNothing()).execute();
      }
      await trx
        .insertInto('review_submissions')
        .values({
          task_id: taskId,
          round: round.round,
          role: review.role,
          agent_id: agentId,
          session_id: sessionId,
          files_reviewed_json: JSON.stringify(review.filesReviewed.map((file) => repoRelative(task, file))),
          summary: review.summary,
          gaps_json: JSON.stringify(review.gaps),
          finding_count: review.findings.length,
          independent: independence.independent ? 1 : 0,
          independence_note: independence.note,
          created_at: at,
        })
        .execute();
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'analysis', at);
      if (completes) await this.completeRound(trx, task, round.round, 'core', expected.length === REVIEWER_ROLES.length ? 'all three reviewers reported' : `the reviewers this change needs reported (${expected.join(', ')})`, at, gitNow);
    });
    await this.reload();
    return this.reviewState(taskId);
  }

  /** Claude closes a round although a reviewer did not report; the missing roles stay visible as gaps. */
  async finishReview(taskId: string, now: Date): Promise<ReviewState> {
    const task = this.requireTask(taskId);
    const round = await this.currentRound(taskId);
    if (round === null || (task.state !== 'CODE_REVIEW' && task.state !== 'REVERIFICATION')) throw new StateError(409, `${taskId} has no open review round`);
    const roles = (await this.database.db.selectFrom('review_submissions').select('role').where('task_id', '=', taskId).where('round', '=', round.round).execute()).map((row) => row.role);
    if (roles.length === 0) throw new StateError(409, `No reviewer reported in round ${round.round} yet; start the reviewers first`);
    const missing = (await this.roundReviewers(taskId, round.round)).filter((role) => !roles.includes(role));
    const gitNow = await this.prepareSnapshots(task, 'report');
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      await this.completeRound(trx, task, round.round, 'claude', `closed by Claude without ${missing.join(', ') || 'no one'}`, at, gitNow);
    });
    await this.reload();
    return this.reviewState(taskId);
  }

  /**
   * Ends a round: earlier review findings no reviewer reported again (in files this round covered)
   * are FIXED; with no open P1â€“P3 review finding left the review passes and the final checks run.
   */
  private async completeRound(trx: Transaction<JerrySchema>, task: Task, round: number, actor: 'core' | 'claude', reason: string, at: string, gitNow: PreparedSnapshots | null): Promise<void> {
    const covered = new Set<string>();
    const roundRow = await trx.selectFrom('review_rounds').selectAll().where('task_id', '=', task.taskId).where('round', '=', round).executeTakeFirstOrThrow();
    for (const file of JSON.parse(roundRow.changed_files_json) as string[]) covered.add(fileKey(file));
    for (const row of await trx.selectFrom('review_submissions').select('files_reviewed_json').where('task_id', '=', task.taskId).where('round', '=', round).execute()) {
      for (const file of JSON.parse(row.files_reviewed_json) as string[]) covered.add(fileKey(file));
    }
    if (round > 1) {
      const reported = new Set((await trx.selectFrom('review_finding_sources').select('finding_id').where('task_id', '=', task.taskId).where('round', '=', round).execute()).map((row) => row.finding_id));
      const open = await trx.selectFrom('findings').selectAll().where('task_id', '=', task.taskId).where('source', '=', 'review').where('status', 'in', ['OPEN', 'ACCEPTED']).execute();
      for (const finding of open) {
        const shown = sameRoot(finding.repo_root, task.repoRoot) ? finding.file : shownPath({ ...task, repoRoot: finding.repo_root, primaryRoot: task.repoRoot }, finding.file);
        if (reported.has(finding.id) || !covered.has(fileKey(shown))) continue;
        const why = `not reported again in review round ${round}`;
        await trx.updateTable('findings').set({ status: 'FIXED', status_reason: why, updated_at: at }).where('id', '=', finding.id).execute();
        await insertFindingEvent(trx, finding.id, findingStatusSchema.parse(finding.status), 'FIXED', 'core', why, at);
      }
    }
    await trx.updateTable('review_rounds').set({ completed_at: at, completed_by: actor }).where('id', '=', roundRow.id).execute();
    await this.transition(trx, task.taskId, 'review.reported', actor, `review round ${round}: ${reason}`, at);
    if (gitNow !== null) await insertSnapshots(trx, gitNow, 'review', at);
    const blocking = await trx.selectFrom('findings').select('id').where('task_id', '=', task.taskId).where('source', '=', 'review').where('status', 'in', ['OPEN', 'ACCEPTED']).where('severity', 'in', ['P1', 'P2', 'P3']).execute();
    if (blocking.length === 0) {
      await trx.updateTable('review_rounds').set({ passed_at: at }).where('id', '=', roundRow.id).execute();
      await this.transition(trx, task.taskId, 'review.passed', 'core', `review round ${round} left no open P1â€“P3 finding`, at);
      await this.runFinalChecks(trx, task, at, gitNow);
    }
  }

  /** Claude's remediation plan for the open review findings; only the user approves it. */
  async proposeFixes(taskId: string, plan: FixPlan, sessionId: string | null, now: Date): Promise<ReviewState> {
    const task = this.requireTask(taskId);
    if (task.state !== 'REVIEW_REPORT' && task.state !== 'WAIT_REVIEW_FIX_APPROVAL') throw new StateError(409, `${taskId} is ${task.state}; a fix plan follows a review report`);
    const round = await this.latestRound(taskId);
    if (round === null) throw new StateError(409, `${taskId} has no review round`);
    if (round.round >= MAX_REVIEW_ROUNDS) throw new StateError(409, `${taskId} had ${round.round} review rounds, the most JERRY runs automatically; the user decides now (waive the review, dismiss findings, or send the work back)`);
    const reviewFindings = new Set((await this.findings({ taskId, statuses: ['OPEN', 'ACCEPTED'] })).filter((finding) => finding.source === 'review').map((finding) => finding.findingId));
    const cited = [...plan.items.flatMap((item) => item.findings), ...plan.notFixed.map((entry) => entry.finding)];
    const unknown = cited.filter((id) => !reviewFindings.has(id));
    if (unknown.length > 0) throw new StateError(400, `The fix plan cites findings that are not open review findings of ${taskId}: ${unknown.join(', ')}`);
    const outside = plan.items.flatMap((item) => item.files).filter((file) => !inTaskScope(task, file));
    if (outside.length > 0) throw new StateError(400, `The fix plan touches files outside the approved scope: ${outside.join(', ')}; revise the plan with the user first`);
    const at = now.toISOString();
    const hash = `sha256:${createHash('sha256').update(JSON.stringify({ taskId, round: round.round, plan }), 'utf8').digest('hex')}`;
    await this.database.db.transaction().execute(async (trx) => {
      await trx.updateTable('review_rounds').set({ fix_plan_json: JSON.stringify(plan), fix_plan_hash: hash }).where('task_id', '=', taskId).where('round', '=', round.round).execute();
      await this.transition(trx, taskId, 'fixes.proposed', 'claude', `fix plan for review round ${round.round}`, at);
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'plan.revised', at);
      await audit(trx, at, 'review.fix-plan', taskId, { round: round.round, hash, items: plan.items.length }, 'claude-code');
    });
    await this.reload();
    return this.reviewState(taskId);
  }

  /** The approved fixes are done: a new round starts for the same reviewers. */
  async reportFixes(taskId: string, summary: string, sessionId: string | null, now: Date): Promise<ReviewState> {
    const task = this.requireTask(taskId);
    if (task.state !== 'FIX_IMPLEMENTATION') throw new StateError(409, `${taskId} is ${task.state}; fixes are reported after the user approved the fix plan`);
    const round = await this.latestRound(taskId);
    if (round === null) throw new StateError(409, `${taskId} has no review round`);
    const at = now.toISOString();
    const roundRow = await this.database.db.selectFrom('review_rounds').select(['fixes_approved_at']).where('task_id', '=', taskId).where('round', '=', round.round).executeTakeFirstOrThrow();
    // Read before the transaction: the database has one connection.
    const reviewers = await this.roundReviewers(taskId, round.round);
    await this.database.db.transaction().execute(async (trx) => {
      const edited = await editsInScopeBetween(trx, task, roundRow.fixes_approved_at ?? round.startedAt, at);
      const findingFiles = (await trx.selectFrom('findings').select('file').where('task_id', '=', taskId).where('source', '=', 'review').where('status', 'in', ['OPEN', 'ACCEPTED']).execute()).map((row) => row.file);
      await trx.updateTable('review_rounds').set({ fixes_reported_at: at, fixes_summary: summary }).where('task_id', '=', taskId).where('round', '=', round.round).execute();
      await this.transition(trx, taskId, 'fixes.reported', 'claude', `fixes for review round ${round.round}`, at);
      // Re-verification by the same reviewers as the round before.
      await trx.insertInto('review_rounds').values({ task_id: taskId, round: round.round + 1, started_at: at, changed_files_json: JSON.stringify([...new Set([...edited, ...findingFiles])].sort()), reviewers_json: JSON.stringify(reviewers) }).execute();
      if (sessionId !== null) await linkSession(trx, sessionId, taskId, 'report', at);
    });
    await this.reload();
    return this.reviewState(taskId);
  }

  /** The user waives the (rest of the) review with a reason; the final checks run. */
  async skipReview(taskId: string, reason: string, now: Date, channel: Channel): Promise<ReviewState> {
    const task = this.requireTask(taskId);
    const gitNow = await this.prepareSnapshots(task, 'report');
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      await this.transition(trx, taskId, 'review.skipped', 'user', reason, at);
      const round = await trx.selectFrom('review_rounds').select('id').where('task_id', '=', taskId).orderBy('round', 'desc').limit(1).executeTakeFirst();
      if (round !== undefined) await trx.updateTable('review_rounds').set({ skipped_at: at, skip_reason: reason }).where('id', '=', round.id).execute();
      else await trx.insertInto('review_rounds').values({ task_id: taskId, round: 1, started_at: at, changed_files_json: '[]', skipped_at: at, skip_reason: reason }).execute();
      await insertSnapshots(trx, gitNow, 'review', at);
      await audit(trx, at, 'review.skip', taskId, { reason, channel });
      await this.runFinalChecks(trx, task, at, gitNow);
    });
    await this.reload();
    return this.reviewState(taskId);
  }

  async reviewState(taskId: string): Promise<ReviewState> {
    const task = this.requireTask(taskId);
    const { db } = this.database;
    const rounds = await db.selectFrom('review_rounds').selectAll().where('task_id', '=', taskId).orderBy('round').execute();
    const submissions = await db.selectFrom('review_submissions').selectAll().where('task_id', '=', taskId).orderBy('id').execute();
    const open = (await this.findings({ taskId, statuses: ['OPEN', 'ACCEPTED'] })).filter((finding) => finding.source === 'review').sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const last = rounds.at(-1);
    return {
      taskId,
      state: task.state,
      outcome: last?.passed_at != null ? 'passed' : last?.skipped_at != null ? 'skipped' : null,
      maxRounds: MAX_REVIEW_ROUNDS,
      openFindings: open,
      rounds: rounds.map((row) => {
        const own = submissions.filter((submission) => submission.round === row.round);
        const changed = JSON.parse(row.changed_files_json) as string[];
        const reviewed = new Set(own.flatMap((submission) => (JSON.parse(submission.files_reviewed_json) as string[]).map(fileKey)));
        return reviewRoundSchema.parse({
          round: row.round,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          changedFiles: changed,
          reviewers: reviewersOf(row.reviewers_json),
          submissions: own.map((submission) => ({
            role: submission.role,
            agentId: submission.agent_id,
            filesReviewed: JSON.parse(submission.files_reviewed_json),
            summary: submission.summary,
            findings: submission.finding_count,
            gaps: JSON.parse(submission.gaps_json),
            independent: submission.independent === 1,
            independenceNote: submission.independence_note,
            at: submission.created_at,
          })),
          uncovered: changed.filter((file) => !reviewed.has(fileKey(file))),
          fixPlan: row.fix_plan_json === null ? null : JSON.parse(row.fix_plan_json),
          fixPlanHash: row.fix_plan_hash,
          fixesSummary: row.fixes_summary,
          passedAt: row.passed_at,
          skippedAt: row.skipped_at,
          skipReason: row.skip_reason,
        });
      }),
    };
  }

  private async currentRound(taskId: string): Promise<{ round: number; startedAt: string } | null> {
    const row = await this.database.db.selectFrom('review_rounds').select(['round', 'started_at']).where('task_id', '=', taskId).where('completed_at', 'is', null).orderBy('round', 'desc').limit(1).executeTakeFirst();
    return row === undefined ? null : { round: row.round, startedAt: row.started_at };
  }

  private async latestRound(taskId: string): Promise<{ round: number; startedAt: string } | null> {
    const row = await this.database.db.selectFrom('review_rounds').select(['round', 'started_at']).where('task_id', '=', taskId).orderBy('round', 'desc').limit(1).executeTakeFirst();
    return row === undefined ? null : { round: row.round, startedAt: row.started_at };
  }

  /**
   * Whether a reviewer is independent of the implementation: a separate subagent that
   * edited nothing of the task. A review from the main session (which implemented) is not.
   */
  private independenceOf(task: Task, agentId: string | null): { independent: boolean; note: string } {
    if (agentId === null) return { independent: false, note: 'submitted from the main session, which implemented the task; not a separate reviewer subagent' };
    const row = this.database.raw
      .prepare("SELECT COUNT(*) AS edits FROM hook_events WHERE agent_id = ? AND event_type = 'PreToolUse' AND tool_name IN ('Write', 'Edit', 'MultiEdit', 'NotebookEdit') AND (verdict IS NULL OR verdict != 'DENY') AND occurred_at >= ?")
      .get(agentId, task.createdAt) as { edits: number } | undefined;
    const edits = Number(row?.edits ?? 0);
    return edits === 0 ? { independent: true, note: `subagent ${agentId} edited nothing of the task` } : { independent: false, note: `subagent ${agentId} also made ${edits} edit(s) during the task` };
  }

  /**
   * What JERRY saw of the quality of the work, for the report: open findings, the
   * test runs against the checks the report claims passed, and plan drift.
   */
  private async qualityEvidence(task: Task, document: ImplementationReport): Promise<NonNullable<ReportEvidence['quality']>> {
    const open = await this.findings({ taskId: task.taskId, statuses: ['OPEN', 'ACCEPTED'] });
    const runs = await this.testRunsOf(task.taskId, 100);
    const normalize = (command: string): string => command.trim().replace(/^corepack\s+/, '').replace(/\s+/g, ' ').toLowerCase();
    const claimedVsObserved: string[] = [];
    for (const check of document.checks.filter((candidate) => candidate.result === 'PASS')) {
      const claimed = normalize(check.command);
      const latest = runs.find((run) => {
        const observed = normalize(run.command);
        return observed === claimed || observed.startsWith(claimed) || claimed.startsWith(observed);
      });
      if (latest !== undefined && latest.result !== 'PASS') claimedVsObserved.push(`${check.command}: the report says PASS, JERRY saw ${latest.result} at ${latest.at}`);
    }
    let drift: PlanDrift | null = null;
    try {
      drift = await this.planDrift(task);
    } catch {
      // Without Git there is no drift to show; the rest of the evidence stands.
    }
    const last = runs[0];
    return {
      openFindings: open.length,
      serious: open.filter((finding) => finding.severity === 'P1' || finding.severity === 'P2').map((finding) => `${finding.findingId} ${finding.severity} ${finding.file}:${finding.lineStart} ${finding.title}`),
      lastTestRun: last === undefined ? null : { command: last.command, result: last.result, summary: last.summary, at: last.at },
      claimedVsObserved,
      unplannedFiles: drift?.unplannedFiles ?? [],
      untouchedSteps: drift?.untouchedSteps.map((step) => `${step.number}. ${step.step}`) ?? [],
    };
  }

  /** A test command Claude ran; the same hook event twice is one run. */
  async recordTestRun(run: TestRun & { repoRoot: string; eventId: string }): Promise<void> {
    await this.database.db
      .insertInto('test_runs')
      .values({ task_id: run.taskId, repo_root: run.repoRoot, session_id: run.sessionId, agent_id: run.agentId, event_id: run.eventId, command: run.command, result: run.result, exit_code: run.exitCode, summary: run.summary, at: run.at })
      .onConflict((conflict) => conflict.column('event_id').doNothing())
      .execute();
  }

  async testRunsOf(taskId: string, limit = 20): Promise<TestRun[]> {
    const rows = await this.database.db.selectFrom('test_runs').selectAll().where('task_id', '=', taskId).orderBy('at', 'desc').orderBy('id', 'desc').limit(limit).execute();
    return rows.map(testRunFromRow);
  }

  /** The latest test run of every task. */
  async latestTestRuns(): Promise<Map<string, TestRun>> {
    const { db } = this.database;
    const rows = await db
      .selectFrom('test_runs')
      .selectAll()
      .where('id', 'in', db.selectFrom('test_runs').select((eb) => eb.fn.max('id').as('id')).where('task_id', 'is not', null).groupBy('task_id'))
      .execute();
    return new Map(rows.map((row) => [row.task_id!, testRunFromRow(row)]));
  }

  /** Every version of a task's plan, oldest first: the user compares revisions. */
  async planVersions(taskId: string): Promise<Plan[]> {
    this.requireTask(taskId);
    const rows = await this.database.db.selectFrom('plans').selectAll().where('task_id', '=', taskId).orderBy('version').execute();
    const repositories = await planRepositoriesOf(this.database.db, [taskId]);
    return rows.map((row) =>
      planSchema.parse({
        version: row.version,
        contentHash: row.content_hash,
        scope: JSON.parse(row.scope_json),
        createdAt: row.created_at,
        ...(row.document_json === null ? {} : { document: JSON.parse(row.document_json) }),
        ...(repositories.has(`${taskId}|${row.version}`) ? { repositories: repositories.get(`${taskId}|${row.version}`) } : {}),
      }),
    );
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
    const task = this.requireTask(taskId);
    const rows = await db
      .selectFrom('agent_runs')
      .selectAll()
      .where('session_id', 'in', db.selectFrom('session_tasks').select('session_id').where('task_id', '=', taskId))
      // A session can work on several tasks: runs from before this task existed belong to others.
      .where('started_at', '>=', task.createdAt)
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

  /**
   * Whether this session (and this subagent, or the main session) was already given this warning in
   * this repository by a live gate check, since it last worked under an approved plan there: losing
   * the plan is news again. Spooled events do not count: Claude never saw them.
   */
  warnedBefore(input: { sessionId: string; agentId: string | null; repoRoot: string | null; ruleId: string }): boolean {
    const row = this.database.raw
      .prepare(
        `SELECT 1 AS found FROM hook_events
         WHERE session_id = ? AND agent_id IS ? AND repo_root IS ? AND event_type = 'PreToolUse' AND verdict = 'WARN' AND rule_id = ? AND spooled = 0
           AND occurred_at > COALESCE((SELECT MAX(occurred_at) FROM hook_events WHERE session_id = ? AND agent_id IS ? AND repo_root IS ? AND event_type = 'PreToolUse'
             AND rule_id IN ('monitor.in-approved-scope', 'monitor.command-with-approved-plan', 'monitor.user-uncommitted-file')), '')
         LIMIT 1`,
      )
      .get(input.sessionId, input.agentId, input.repoRoot, input.ruleId, input.sessionId, input.agentId, input.repoRoot) as { found: number } | undefined;
    return row !== undefined;
  }

  /**
   * The user's switch for an Artifact when the task is done (task page). Refused for a cancelled task
   * and once an Artifact decision is recorded: then the choice is made.
   */
  async setArtifactRequest(taskId: string, request: ArtifactRequest, now: Date, channel: Channel): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.state === 'CANCELLED') throw new StateError(409, `${taskId} is cancelled`);
    const decided = await this.database.db.selectFrom('artifact_decisions').select('id').where('task_id', '=', taskId).limit(1).executeTakeFirst();
    if (decided !== undefined) throw new StateError(409, `An Artifact decision is already recorded for ${taskId}`);
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => writeArtifactRequest(trx, taskId, request, at, channel));
    await this.reload();
    return this.requireTask(taskId);
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

  /** The projects the user added, in the order of their roots. */
  projects(): Project[] {
    return this.projectList.map((project) => ({ ...project }));
  }

  /** The project containing a repository root or any other absolute path, if any (path-boundary aware). */
  projectOf(target: string): Project | null {
    const key = comparablePath(target, target, process.platform);
    return this.projectList.find((project) => isComparableInside(key, comparablePath(project.repoRoot, project.repoRoot, process.platform))) ?? null;
  }

  /** True when JERRY monitors the path: it lies in a project the user added. */
  isMonitored(target: string): boolean {
    return this.projectOf(target) !== null;
  }

  /** Adds a project; adding one that exists changes nothing. `repoRoot` must already be a checked Git root. */
  async addProject(repoRoot: string, now: Date, channel: Channel, note: string | null = null): Promise<{ project: Project; added: boolean }> {
    const existing = this.projectList.find((project) => sameRoot(project.repoRoot, repoRoot));
    if (existing !== undefined) return { project: { ...existing }, added: false };
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      await trx.insertInto('projects').values({ repo_root: repoRoot, added_at: at, added_by: channel, note }).execute();
      // An exclusion recorded before projects existed no longer describes it.
      await trx.updateTable('repositories').set({ excluded_at: null, updated_at: at }).where('repo_id', '=', repositoryId(repoRoot)).where('excluded_at', 'is not', null).execute();
      await audit(trx, at, 'project.add', repoRoot, { channel });
    });
    await this.reload();
    this.writeProjectsFile();
    return { project: { ...this.projectList.find((project) => sameRoot(project.repoRoot, repoRoot))! }, added: true };
  }

  /** Removes a project; its tasks stay in the database but nothing monitors them anymore. */
  async removeProject(repoRoot: string, now: Date, channel: Channel): Promise<{ repoRoot: string; removed: boolean }> {
    const existing = this.projectList.find((project) => sameRoot(project.repoRoot, repoRoot));
    if (existing === undefined) return { repoRoot, removed: false };
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('projects').where('repo_root', '=', existing.repoRoot).execute();
      await audit(trx, at, 'project.remove', existing.repoRoot, { channel });
    });
    await this.reload();
    this.writeProjectsFile();
    return { repoRoot: existing.repoRoot, removed: true };
  }

  /** The user's global settings. */
  settings(): Settings {
    return { ...this.settingValues };
  }

  /** The review mode that applies at a path: its project's own, else the global one. */
  effectiveReviewModeAt(target: string): ReviewMode {
    return effectiveReviewMode(this.settingValues.reviewMode, this.projectOf(target)?.reviewMode);
  }

  /** Changes global settings; only the user does this (CLI in a terminal, or the dashboard). */
  async updateSettings(update: SettingsUpdateRequest, now: Date, channel: Channel): Promise<Settings> {
    const at = now.toISOString();
    const before = this.settings();
    const changes: Array<[string, string | boolean]> = [];
    if (update.reviewMode !== undefined) changes.push([REVIEW_MODE_SETTING, update.reviewMode]);
    if (update.qaLanguage !== undefined) changes.push([QA_LANGUAGE_SETTING, update.qaLanguage]);
    if (update.usageShowBar !== undefined) changes.push([USAGE_SHOW_BAR_SETTING, update.usageShowBar]);
    if (update.decisionConfirmation !== undefined) changes.push([DECISION_CONFIRMATION_SETTING, update.decisionConfirmation]);
    await this.database.db.transaction().execute(async (trx) => {
      for (const [key, value] of changes) {
        await trx
          .insertInto('settings')
          .values({ key, value_json: JSON.stringify(value), created_at: at, updated_at: at })
          .onConflict((conflict) => conflict.column('key').doUpdateSet({ value_json: JSON.stringify(value), updated_at: at }))
          .execute();
      }
      await audit(trx, at, 'settings.update', null, { before, update, channel });
    });
    await this.reload();
    return this.settings();
  }

  /** The model and effort of each read-only subagent: the user's choice, else the plugin's default. */
  async agentModels(): Promise<Map<string, AgentModelChoice>> {
    const row = await this.database.db.selectFrom('settings').select('value_json').where('key', '=', AGENT_MODELS_SETTING).executeTakeFirst();
    let stored: Record<string, AgentModelChoice> = {};
    if (row !== undefined) {
      try {
        const parsed = z.record(z.string(), agentModelChoiceSchema).safeParse(JSON.parse(row.value_json));
        if (parsed.success) stored = parsed.data;
      } catch {
        // An unreadable row falls back to the defaults.
      }
    }
    return new Map([...MODEL_CHOICE_ROLES, ...SKILL_MODEL_ROLES].map((role) => [role.id, stored[role.id] ?? role.defaults]));
  }

  /** Changes the model and effort of read-only subagents; only the user does this (dashboard or CLI with the Core token). */
  async setAgentModels(update: AgentModelsUpdateRequest, now: Date, channel: Channel): Promise<Map<string, AgentModelChoice>> {
    const at = now.toISOString();
    const before = await this.agentModels();
    const after = new Map(before);
    for (const agent of update.agents) after.set(agent.role, { model: agent.model, effort: agent.effort });
    const value = JSON.stringify(Object.fromEntries(after));
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('settings')
        .values({ key: AGENT_MODELS_SETTING, value_json: value, created_at: at, updated_at: at })
        .onConflict((conflict) => conflict.column('key').doUpdateSet({ value_json: value, updated_at: at }))
        .execute();
      await audit(trx, at, 'agents.models', null, { before: Object.fromEntries(before), update: update.agents, channel });
    });
    return after;
  }

  /** An audit row for a user decision made outside the database (e.g. Claude usage collection in Claude Code's settings). */
  async recordAudit(action: string, details: Record<string, unknown>, now: Date): Promise<void> {
    const at = now.toISOString();
    await this.database.db.insertInto('audit_log').values({ at, actor: 'local-user', action, subject: null, details_json: JSON.stringify(details), created_at: at }).execute();
  }

  /** A project's own review mode; null follows the global setting. Only the user does this. */
  async setProjectReviewMode(repoRoot: string, reviewMode: ReviewMode | null, now: Date, channel: Channel): Promise<Project> {
    const existing = this.projectList.find((project) => sameRoot(project.repoRoot, repoRoot));
    if (existing === undefined) throw new StateError(404, `${repoRoot} is not a JERRY project (see "jerry project list")`);
    const at = now.toISOString();
    await this.database.db.transaction().execute(async (trx) => {
      await trx.updateTable('projects').set({ review_mode: reviewMode }).where('repo_root', '=', existing.repoRoot).execute();
      await audit(trx, at, 'project.settings', existing.repoRoot, { before: existing.reviewMode, reviewMode, channel });
    });
    await this.reload();
    return { ...this.projectList.find((project) => sameRoot(project.repoRoot, existing.repoRoot))! };
  }

  /**
   * Writes JERRY_HOME/run/projects.json for the hook bridge (atomically). Called at start and after
   * every change; without a configured file (tests of the store alone) it does nothing.
   */
  writeProjectsFile(): void {
    if (this.projectsFile === null) return;
    // The workspaces' common parent folders too: the bridge then asks Core about a session started
    // there (Core still monitors only the projects; the folder itself is no project).
    const roots = [...this.projectList.map((project) => project.repoRoot), ...this.workspaceFolders];
    writeFileAtomic(this.projectsFile, `${JSON.stringify({ version: 1, roots }, null, 2)}\n`);
  }

  private workspaceFolders: string[] = [];

  /** The common parent folders of the workspaces (WorkspaceService keeps them current). */
  setWorkspaceFolders(folders: readonly string[]): void {
    const next = [...new Set(folders)].sort();
    if (next.join('\n') === this.workspaceFolders.join('\n')) return;
    this.workspaceFolders = next;
    this.writeProjectsFile();
  }

  /** Latest activity per repository root (comparable key): sessions seen there and task activity. */
  async lastActivityByRepository(): Promise<Map<string, string>> {
    const latest = new Map<string, string>();
    const note = (root: string, at: string | null | undefined): void => {
      if (at == null) return;
      const key = comparablePath(root, root, process.platform);
      if ((latest.get(key) ?? '') < at) latest.set(key, at);
    };
    const tasks = await this.database.db
      .selectFrom('tasks')
      .innerJoin('repositories', 'repositories.repo_id', 'tasks.repo_id')
      .select((eb) => ['repositories.root_path', eb.fn.max('tasks.updated_at').as('at')])
      .groupBy('repositories.root_path')
      .execute();
    for (const row of tasks) note(row.root_path, row.at);
    const links = await this.database.db
      .selectFrom('session_tasks')
      .innerJoin('tasks', 'tasks.task_id', 'session_tasks.task_id')
      .innerJoin('repositories', 'repositories.repo_id', 'tasks.repo_id')
      .select((eb) => ['repositories.root_path', eb.fn.max('session_tasks.last_at').as('at')])
      .groupBy('repositories.root_path')
      .execute();
    for (const row of links) note(row.root_path, row.at);
    const sessions = await this.database.db.selectFrom('sessions').select(['cwd', 'last_seen_at']).orderBy('last_seen_at', 'desc').limit(SNAPSHOT_SESSIONS).execute();
    for (const project of this.projectList) {
      const key = comparablePath(project.repoRoot, project.repoRoot, process.platform);
      const seen = sessions.find((session) => isComparableInside(comparablePath(session.cwd, session.cwd, process.platform), key));
      note(project.repoRoot, seen?.last_seen_at);
    }
    return latest;
  }

  /**
   * Runs `work` with the database connection held exclusively: no other query of Core runs in
   * between, so `work` may open and close its own transaction on the raw connection.
   */
  async exclusive<T>(work: (raw: JerryDatabase['raw']) => T): Promise<T> {
    return this.database.db.connection().execute(async () => work(this.database.raw));
  }

  /** Reloads the in-memory snapshot after `exclusive` changed the database. */
  async refresh(): Promise<void> {
    await this.reload();
    this.writeProjectsFile();
  }

  get backupsDir(): string {
    return this.database.backupsDir;
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
      // Subagent runs: started and stopped as the hooks saw them.
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
   * Retention: events and sessions older than `days` are deleted. Governance records
   * (tasks, plans, approvals, audit log) are kept. The database file shrinks after large deletions.
   */
  async applyRetention(now: Date, days: number): Promise<{ events: number; sessions: number; usage: number }> {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const { db } = this.database;
    const events = await db.deleteFrom('hook_events').where('occurred_at', '<', cutoff).executeTakeFirst();
    const sessions = await db.deleteFrom('sessions').where('last_seen_at', '<', cutoff).executeTakeFirst();
    // Claude usage is kept as long as events.
    const usage = [
      await db.deleteFrom('usage_tokens').where('bucket_minute', '<', cutoff).executeTakeFirst(),
      await db.deleteFrom('usage_snapshots').where('at', '<', cutoff).executeTakeFirst(),
      await db.deleteFrom('usage_limits').where('at', '<', cutoff).executeTakeFirst(),
      await db.deleteFrom('usage_jerry_share').where('bucket_minute', '<', cutoff).executeTakeFirst(),
    ].reduce((sum, result) => sum + Number(result.numDeletedRows), 0);
    const removed = { events: Number(events.numDeletedRows), sessions: Number(sessions.numDeletedRows), usage };
    if (removed.events + removed.sessions + removed.usage > 0) {
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
  private async transition(trx: Transaction<JerrySchema>, taskId: string, event: WorkflowEvent, actor: WorkflowActor, reason: string, at: string, context: Pick<TransitionContext, 'review'> = {}): Promise<WorkflowState> {
    const row = await trx.selectFrom('tasks').select('state').where('task_id', '=', taskId).executeTakeFirst();
    if (row === undefined) throw new StateError(404, `Unknown task ${taskId}`);
    const from = workflowStateSchema.parse(row.state);
    let pausedFrom: WorkflowState | null = null;
    if (event === 'task.resumed') {
      const paused = await trx.selectFrom('workflow_transitions').select('from_state').where('task_id', '=', taskId).where('to_state', '=', 'PAUSED').orderBy('id', 'desc').limit(1).executeTakeFirst();
      pausedFrom = paused === undefined || paused.from_state === null ? null : workflowStateSchema.parse(paused.from_state);
    }
    const to = validTransition(taskId, from, event, actor, { ...context, pausedFrom });
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
      .select(['tasks.task_id', 'tasks.title', 'tasks.state', 'tasks.goal', 'tasks.analysts_json', 'tasks.artifact_request_json', 'tasks.created_at', 'repositories.root_path', 'plans.version', 'plans.content_hash', 'plans.scope_json', 'plans.document_json', 'plans.created_at as plan_created_at'])
      .orderBy('tasks.task_id')
      .execute();
    const approvals = await db.selectFrom('approvals').selectAll().orderBy('approved_at').orderBy(sql`rowid`).execute();
    const planRepositories = await planRepositoriesOf(db);
    const sessions = await db.selectFrom('sessions').selectAll().orderBy('last_seen_at', 'desc').limit(SNAPSHOT_SESSIONS).execute();
    const excluded = await db.selectFrom('repositories').select(['root_path', 'excluded_at']).where('excluded_at', 'is not', null).execute();
    const sessionTotal = await db.selectFrom('sessions').select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
    const nextTaskNumber = await db.selectFrom('settings').select('value_json').where('key', '=', NEXT_TASK_NUMBER).executeTakeFirst();
    const projects = await db.selectFrom('projects').selectAll().orderBy('repo_root').execute();
    this.projectList = projects.map((row) => {
      const reviewMode = reviewModeSchema.safeParse(row.review_mode);
      return projectSchema.parse({ repoRoot: row.repo_root, addedAt: row.added_at, addedBy: row.added_by, note: row.note, reviewMode: reviewMode.success ? reviewMode.data : null });
    });
    const settings = await db
      .selectFrom('settings')
      .select(['key', 'value_json'])
      .where('key', 'in', [REVIEW_MODE_SETTING, QA_LANGUAGE_SETTING, USAGE_SHOW_BAR_SETTING, DECISION_CONFIRMATION_SETTING])
      .execute();
    this.settingValues = {
      reviewMode: storedSetting(settings, REVIEW_MODE_SETTING, reviewModeSchema, DEFAULT_REVIEW_MODE),
      qaLanguage: storedSetting(settings, QA_LANGUAGE_SETTING, qaLanguageSchema, DEFAULT_QA_LANGUAGE),
      usageShowBar: storedSetting(settings, USAGE_SHOW_BAR_SETTING, z.boolean(), DEFAULT_USAGE_SHOW_BAR),
      decisionConfirmation: storedSetting(settings, DECISION_CONFIRMATION_SETTING, decisionConfirmationSchema, DEFAULT_DECISION_CONFIRMATION),
    };

    this.state = coreStateSchema.parse({
      schemaVersion: 1,
      nextTaskNumber: nextTaskNumber === undefined ? 1 : Number(JSON.parse(nextTaskNumber.value_json)),
      tasks: tasks.map((row) => ({
        taskId: row.task_id,
        title: row.title,
        repoRoot: row.root_path,
        createdAt: row.created_at,
        state: row.state,
        ...(row.goal === null ? {} : { goal: row.goal }),
        ...(row.analysts_json === null ? {} : { analysts: JSON.parse(row.analysts_json) }),
        ...(row.artifact_request_json === null ? {} : { artifactRequest: JSON.parse(row.artifact_request_json) }),
        plan: {
          version: row.version,
          contentHash: row.content_hash,
          scope: JSON.parse(row.scope_json),
          createdAt: row.plan_created_at,
          ...(row.document_json === null ? {} : { document: JSON.parse(row.document_json) }),
          ...(planRepositories.has(`${row.task_id}|${row.version}`) ? { repositories: planRepositories.get(`${row.task_id}|${row.version}`) } : {}),
        },
      })),
      approvals: approvals.map(approvalFromRow),
      sessions: sessions.reverse().map((row) => ({ sessionId: row.session_id, cwd: row.cwd, source: row.source, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at })),
      excludedRepos: excluded.map((row) => ({ repoRoot: row.root_path, excludedAt: row.excluded_at! })),
    });
    this.sessionTotal = Number(sessionTotal.count);

    // The user's uncommitted files at each open task's latest plan approval, per repository.
    const userDirty = new Map<string, Set<string>>();
    for (const task of this.state.tasks.filter((candidate) => !isTerminal(candidate.state))) {
      for (const view of repoViews(task)) {
        const baseline = await latestSnapshot(db, task.taskId, 'plan.approved', view.repoRoot);
        if (baseline !== null) userDirty.set(`${task.taskId}|${rootKey(view.repoRoot)}`, new Set(Object.keys(baseline.fingerprints).map(fileKey)));
      }
    }
    this.userDirty = userDirty;
    await this.loadAssignments();
  }

  /** The stored profile of a repository with its freshness fingerprints. */
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

  /** One-time import of the old JSON state file into an empty database; the JSON file is kept, renamed. */
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
        await trx.insertInto('tasks').values({ task_id: task.taskId, title: task.title, repo_id: repoId, current_plan_version: task.plan.version, state, goal: null, created_at: task.createdAt, updated_at: at }).execute();
        await trx.insertInto('plans').values({ task_id: task.taskId, version: task.plan.version, content_hash: task.plan.contentHash, scope_json: JSON.stringify(task.plan.scope), created_at: task.plan.createdAt }).execute();
      }
      for (const approval of legacy.approvals) {
        // The old JSON state kept only the current plan version; approvals of older versions have no plan row to reference.
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

function sameRoot(a: string, b: string): boolean {
  return comparablePath(a, a, process.platform) === comparablePath(b, b, process.platform);
}

/** Stable ID per working tree root, independent of path spelling (case, separators on Windows). */
export function repositoryId(repoRoot: string): string {
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

async function insertPlan(
  trx: Transaction<JerrySchema>,
  plan: { taskId: string; title: string; repoRoot: string; version: number; scope: string[]; document?: PlanDocument | undefined; repositories?: PlanRepository[] | undefined; at: string },
): Promise<void> {
  const repositories = plan.repositories ?? [];
  await trx
    .insertInto('plans')
    .values({
      task_id: plan.taskId,
      version: plan.version,
      content_hash: computePlanHash({
        taskId: plan.taskId,
        title: plan.title,
        repoRoot: plan.repoRoot,
        version: plan.version,
        scope: plan.scope,
        ...(plan.document === undefined ? {} : { document: plan.document }),
        ...(repositories.length === 0 ? {} : { repositories }),
      }),
      scope_json: JSON.stringify(plan.scope),
      document_json: plan.document === undefined ? null : JSON.stringify(plan.document),
      created_at: plan.at,
    })
    .execute();
  // A multi-repository plan: each other repository with its scope, frozen with this version.
  for (const repository of repositories) {
    const repoId = await upsertRepository(trx, repository.repoRoot, plan.at);
    await trx
      .insertInto('plan_repositories')
      .values({ task_id: plan.taskId, version: plan.version, repo_id: repoId, root_path: repository.repoRoot, scope_json: JSON.stringify(repository.scope), exclude_json: JSON.stringify(repository.exclude), created_at: plan.at })
      .execute();
  }
}

/** The other repositories of each (task, version), in the order the plan named them. */
async function planRepositoriesOf(db: Kysely<JerrySchema> | Transaction<JerrySchema>, taskIds?: readonly string[]): Promise<Map<string, PlanRepository[]>> {
  let query = db.selectFrom('plan_repositories').selectAll().orderBy(sql`rowid`);
  if (taskIds !== undefined) {
    if (taskIds.length === 0) return new Map();
    query = query.where('task_id', 'in', [...taskIds]);
  }
  const result = new Map<string, PlanRepository[]>();
  for (const row of await query.execute()) {
    const key = `${row.task_id}|${row.version}`;
    result.set(key, [...(result.get(key) ?? []), { repoRoot: row.root_path, scope: JSON.parse(row.scope_json) as string[], exclude: JSON.parse(row.exclude_json) as string[] }]);
  }
  return result;
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

/** The current fix plan: its review round is the version the user decides on. */
async function latestFixPlanSubject(trx: Transaction<JerrySchema>, taskId: string): Promise<{ version: number; contentHash: string } | null> {
  const row = await trx.selectFrom('review_rounds').select(['round', 'fix_plan_hash']).where('task_id', '=', taskId).where('fix_plan_hash', 'is not', null).orderBy('round', 'desc').limit(1).executeTakeFirst();
  return row === undefined ? null : { version: row.round, contentHash: row.fix_plan_hash! };
}

async function latestReportSubject(trx: Transaction<JerrySchema>, taskId: string): Promise<{ version: number; contentHash: string } | null> {
  const row = await trx.selectFrom('implementation_reports').select(['version', 'content_hash']).where('task_id', '=', taskId).orderBy('version', 'desc').limit(1).executeTakeFirst();
  return row === undefined ? null : { version: row.version, contentHash: row.content_hash };
}

function approvalFromRow(row: Selectable<JerrySchema['approvals']>): ApprovalRecord {
  return approvalRecordSchema.parse({
    approvalId: row.approval_id,
    taskId: row.task_id,
    stage: row.stage,
    version: row.version,
    contentHash: row.content_hash,
    decision: row.decision,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    comment: row.comment,
    ...(row.review === null ? {} : { review: row.review === 1 }),
  });
}

/** A stored setting, or the default when it is missing or not a valid value. */
/** Stores the user's Artifact switch for a task, with an audit row. */
async function writeArtifactRequest(trx: Transaction<JerrySchema>, taskId: string, request: ArtifactRequest, at: string, channel: Channel): Promise<void> {
  const value = { wanted: request.wanted, kind: request.kind, at };
  await trx.updateTable('tasks').set({ artifact_request_json: JSON.stringify(value), updated_at: at }).where('task_id', '=', taskId).execute();
  await audit(trx, at, 'artifact.request', taskId, { ...request, channel });
}

/** A round's expected reviewers; null or unreadable (rounds before sizing): all three. */
function reviewersOf(json: string | null): ReviewerRole[] {
  if (json === null) return [...REVIEWER_ROLES];
  try {
    const parsed = z.array(reviewerRoleSchema).min(1).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [...REVIEWER_ROLES];
  } catch {
    return [...REVIEWER_ROLES];
  }
}

function storedSetting<T>(rows: readonly { key: string; value_json: string }[], key: string, schema: z.ZodType<T>, fallback: T): T {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** Stored final checks; the later-work list lives on its condition, so older rows read without one. */
function completionCheckFromRow(row: Selectable<JerrySchema['task_completion_checks']>): CompletionCheck {
  const conditions = JSON.parse(row.conditions_json) as Array<{ id: string; laterWork?: unknown }>;
  const laterWork = conditions.find((condition) => condition.id === 'code.later-work')?.laterWork ?? [];
  return completionCheckSchema.parse({ taskId: row.task_id, reportVersion: row.report_version, at: row.created_at, passed: row.passed === 1, conditions, definitionOfDone: JSON.parse(row.definition_of_done_json), laterWork });
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

async function latestSnapshot(trx: Transaction<JerrySchema> | Kysely<JerrySchema>, taskId: string, kind: SnapshotKind, repoRoot: string): Promise<StoredSnapshot | null> {
  const row = await trx
    .selectFrom('git_snapshots')
    .select(['head', 'fingerprints_json', 'created_at', 'error'])
    .where('task_id', '=', taskId)
    .where('kind', '=', kind)
    .where(process.platform === 'win32' ? sql`lower(replace(repo_root, '\\', '/'))` : sql`repo_root`, '=', process.platform === 'win32' ? repoRoot.replaceAll('\\', '/').toLowerCase() : repoRoot)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row === undefined || row.error !== null) return null;
  return { head: row.head, fingerprints: JSON.parse(row.fingerprints_json) as Record<string, string>, createdAt: row.created_at };
}

async function insertSnapshots(trx: Transaction<JerrySchema>, list: PreparedSnapshots, kind: SnapshotKind, at: string): Promise<void> {
  for (const { view, prepared } of list) await insertSnapshot(trx, view, kind, prepared, at);
}

function userFilesOf(row: Selectable<JerrySchema['git_snapshots']>): string[] {
  return [...new Set([...(JSON.parse(row.staged_json) as string[]), ...(JSON.parse(row.unstaged_json) as string[]), ...(JSON.parse(row.untracked_json) as string[])])].sort();
}

/**
 * Where a file a reviewer or a fix plan names lies: in another repository of the task when its
 * absolute path is inside one, else in the task's own (relative to it).
 */
function locateFile(task: Task, file: string): { repoRoot: string; relative: string; shown: string } {
  const platform = process.platform;
  const trimmed = file.trim();
  for (const view of repoViews(task).filter((candidate) => !isPrimary(candidate))) {
    const relative = relativeInside(absolutePath(trimmed, task.repoRoot, platform), view.repoRoot, platform);
    if (relative !== null && relative !== '') {
      const normalized = relative.replaceAll('\\', '/');
      return { repoRoot: view.repoRoot, relative: normalized, shown: shownPath(view, normalized) };
    }
  }
  const relative = repoRelative(task, trimmed);
  return { repoRoot: task.repoRoot, relative, shown: relative };
}

/** True when a file (relative to the task's own repository, or absolute in another) lies in the task's scope there. */
function inTaskScope(task: Task, file: string): boolean {
  const located = locateFile(task, file);
  const repository = taskRepositories(task).find((candidate) => sameRoot(candidate.repoRoot, located.repoRoot));
  return repository !== undefined && matchesAnyGlob(located.relative, repository.scope, process.platform === 'win32');
}

/**
 * A report's evidence across the task's repositories: the task's own as before, and for a
 * multi-repository task the same facts per repository, merged into the flat lists with the other
 * repositories' paths absolute.
 */
async function evidenceOfRepositories(trx: Transaction<JerrySchema>, gitNow: PreparedSnapshots, document: ImplementationReport, until: string): Promise<ReportEvidence> {
  const perRepository: Array<{ view: RepoTask; evidence: ReportEvidence }> = [];
  for (const { view, prepared } of gitNow) {
    const baseline = await latestSnapshot(trx, view.taskId, 'plan.approved', view.repoRoot);
    perRepository.push({ view, evidence: await collectEvidence(trx, view, document, until, gitEvidence(baseline, prepared)) });
  }
  const [own, ...others] = perRepository;
  if (own === undefined) throw new Error('a task has at least one repository');
  if (others.length === 0) return own.evidence;
  const shown = (entry: { view: RepoTask }, files: readonly string[]): string[] => files.map((file) => shownPath(entry.view, file));
  const all = [own, ...others];
  return {
    ...own.evidence,
    deviations: all
      .flatMap((entry) => entry.evidence.deviations)
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(0, MAX_EVIDENCE_DEVIATIONS),
    deviationCount: all.reduce((sum, entry) => sum + entry.evidence.deviationCount, 0),
    blockedCount: all.reduce((sum, entry) => sum + entry.evidence.blockedCount, 0),
    observedEdits: all.flatMap((entry) => shown(entry, entry.evidence.observedEdits)),
    unreportedEdits: all.flatMap((entry) => shown(entry, entry.evidence.unreportedEdits)),
    repositories: all.map((entry) => ({ repoRoot: entry.view.repoRoot, observedEdits: entry.evidence.observedEdits, unreportedEdits: entry.evidence.unreportedEdits, git: entry.evidence.git })),
  };
}

/** True when a report's change belongs to this repository of the task (an empty repository means the task's own). */
function reportsRepository(view: Task | RepoTask, repository: string): boolean {
  return repository.trim() === '' ? isPrimary(view) : sameRoot(repository, view.repoRoot);
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
  const reported = new Set(document.changes.filter((change) => reportsRepository(task, change.repository)).map((change) => key(change.path.trim().replaceAll('\\', '/').replace(/^\.\//, ''))));
  const observedEdits = [...observed.values()].sort();
  // Git also sees what shell commands and generators changed.
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

/** Files in the plan's scope edited with the file tools in the task's repositories during (from, until]; another repository's shown absolute. */
async function editsInScopeBetween(trx: Transaction<JerrySchema>, task: Task, from: string, until: string, excluded: ReadonlyArray<{ from: string; until: string }> = []): Promise<string[]> {
  const files: string[] = [];
  for (const view of repoViews(task)) files.push(...(await fileEditsInScopeBetween(trx, view, from, until, excluded)).map((edit) => shownPath(view, edit.file)));
  return [...new Set(files)].sort();
}

/** One file-tool edit in a task's scope, with the gate decision recorded on its event. */
interface ScopedEdit {
  file: string;
  at: string;
  /** The task the gate decision named; null when no plan was involved, and on events from before decisions carried it. */
  taskId: string | null;
  ruleId: string | null;
}

/** Each file-tool edit in the plan's scope in the repository during (from, until], oldest first. */
async function fileEditsInScopeBetween(trx: Transaction<JerrySchema>, task: Task, from: string, until: string, excluded: ReadonlyArray<{ from: string; until: string }> = []): Promise<ScopedEdit[]> {
  const platform = process.platform;
  let query = trx
    .selectFrom('hook_events')
    .select(['tool_name', 'verdict', 'payload_json', 'cwd', 'occurred_at', 'task_id', 'rule_id'])
    .where('event_type', '=', 'PreToolUse')
    .where('occurred_at', '>', from)
    .where('occurred_at', '<=', until)
    .where('tool_name', 'in', [...FILE_TOOLS])
    .orderBy('occurred_at');
  query = platform === 'win32' ? query.where(sql`lower(repo_root)`, '=', task.repoRoot.toLowerCase()) : query.where('repo_root', '=', task.repoRoot);
  const edits: ScopedEdit[] = [];
  for (const event of await query.execute()) {
    if (event.verdict === 'DENY' || excluded.some((window) => event.occurred_at > window.from && event.occurred_at <= window.until)) continue;
    const input = ((JSON.parse(event.payload_json) as Record<string, unknown>)['input'] ?? {}) as Record<string, unknown>;
    if (typeof input['path'] !== 'string') continue;
    const relative = relativeInside(absolutePath(input['path'], event.cwd ?? task.repoRoot, platform), task.repoRoot, platform);
    if (relative !== null && relative !== '' && matchesAnyGlob(relative, task.plan.scope, platform === 'win32')) edits.push({ file: relative, at: event.occurred_at, taskId: event.task_id, ruleId: event.rule_id });
  }
  return edits;
}

/**
 * Gate decisions that name the approved plan covering the edited file; the event's task is that plan's
 * task. Out-of-scope warnings also carry a task, but no plan covered the file, so they are not here.
 */
const COVERING_RULES: ReadonlySet<string> = new Set(['monitor.in-approved-scope', 'monitor.user-uncommitted-file', 'monitor.implementer-scope', 'monitor.concurrent-write']);

/**
 * Splits what changed after a task's report into later approved work of other tasks and the rest.
 *
 * A file-tool edit is later work of task B when its gate decision named B's approved plan and B was in
 * implementation (IMPLEMENTATION or FIX_IMPLEMENTATION) when it was made. A change only Git saw is
 * excused only when every file-tool edit of that file after the report is such later work and each of
 * those tasks' latest reports lists the file. Everything else stays: edits with no plan, under this
 * task itself, under another task outside its implementation, events without a task, and changes no
 * hook saw (shell commands, generators).
 */
async function attributeEditsSinceReport(trx: Transaction<JerrySchema>, task: Task, hookEdits: readonly ScopedEdit[], gitEdits: readonly string[]): Promise<{ remaining: string[]; laterWork: LaterWork[] }> {
  const candidate = (edit: ScopedEdit): edit is ScopedEdit & { taskId: string } => edit.taskId !== null && edit.taskId !== task.taskId && edit.ruleId !== null && COVERING_RULES.has(edit.ruleId);
  const others = [...new Set(hookEdits.filter(candidate).map((edit) => edit.taskId))];
  const windows = new Map<string, Array<{ from: string; until: string | null }>>();
  const reported = new Map<string, (key: string) => boolean>();
  for (const other of others) {
    windows.set(other, await workWindows(trx, other));
    reported.set(other, await reportedFiles(trx, task, other));
  }
  const laterTaskOf = (edit: ScopedEdit): string | null =>
    candidate(edit) && (windows.get(edit.taskId) ?? []).some((window) => edit.at >= window.from && (window.until === null || edit.at <= window.until)) ? edit.taskId : null;

  const remaining = new Map<string, string>();
  const later = new Map<string, Map<string, string>>();
  const ownersByFile = new Map<string, Array<string | null>>();
  for (const edit of hookEdits) {
    const key = fileKey(edit.file);
    const owner = laterTaskOf(edit);
    ownersByFile.set(key, [...(ownersByFile.get(key) ?? []), owner]);
    if (owner === null) remaining.set(key, edit.file);
    else later.set(owner, (later.get(owner) ?? new Map<string, string>()).set(key, edit.file));
  }
  for (const file of gitEdits) {
    const key = fileKey(file);
    const owners = ownersByFile.get(key) ?? [];
    const excused = owners.length > 0 && owners.every((owner) => owner !== null && reported.get(owner)?.(key) === true);
    if (!excused && !remaining.has(key)) remaining.set(key, file);
  }
  return {
    remaining: [...remaining.values()].sort(),
    laterWork: [...later]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([taskId, files]) => ({ taskId, files: [...files.values()].sort() })),
  };
}

/** When a task was in implementation: from entering a work state until its next transition (open while it still is). */
async function workWindows(trx: Transaction<JerrySchema>, taskId: string): Promise<Array<{ from: string; until: string | null }>> {
  const transitions = await trx.selectFrom('workflow_transitions').select(['to_state', 'at']).where('task_id', '=', taskId).orderBy('id').execute();
  return transitions.flatMap((transition, index) => (WORK_STATES.has(transition.to_state as WorkflowState) ? [{ from: transition.at, until: transitions[index + 1]?.at ?? null }] : []));
}

/** Files the latest report of another task lists in the given task's repository, as comparable keys. */
/**
 * Whether the latest report of another task lists a file. Reports name files exactly, or summarise
 * several in one entry: globs ('apps/cli/src/*.ts', 'packages/x/**'), braces
 * ('src/{a,b}.ts'), comma-separated paths, or a path followed by a note in parentheses. All of
 * these count, so a task that reported its files in a summarised form still excuses them.
 */
async function reportedFiles(trx: Transaction<JerrySchema>, task: Task, otherTaskId: string): Promise<(key: string) => boolean> {
  const row = await trx.selectFrom('implementation_reports').selectAll().where('task_id', '=', otherTaskId).orderBy('version', 'desc').limit(1).executeTakeFirst();
  if (row === undefined) return () => false;
  const platform = process.platform;
  // The other task's report names this repository its own way: empty for the other task's own repository.
  const otherTask = await trx.selectFrom('tasks').innerJoin('repositories', 'repositories.repo_id', 'tasks.repo_id').select('repositories.root_path').where('tasks.task_id', '=', otherTaskId).executeTakeFirst();
  const sameRepo = (repository: string): boolean => sameRoot(repository.trim() === '' ? (otherTask?.root_path ?? '') : repository, task.repoRoot);
  const exact = new Set<string>();
  const globs: string[] = [];
  for (const change of reportFromRow(row).document.changes.filter((entry) => sameRepo(entry.repository))) {
    for (const entry of reportedPathPatterns(change.path)) {
      const key = fileKey(repoRelative(task, entry));
      if (/[*?]/.test(key)) globs.push(key);
      else exact.add(key);
    }
  }
  return (key) => exact.has(key) || (globs.length > 0 && matchesAnyGlob(key, globs, platform === 'win32'));
}

/** 'src/{a,b}.ts, README.md (note)' -> ['src/a.ts', 'src/b.ts', 'README.md']. */
export function reportedPathPatterns(raw: string): string[] {
  const withoutNote = raw.replace(/\s+\([^)]*\)\s*$/, '');
  const parts: string[] = [];
  // Split on commas outside braces.
  let depth = 0;
  let current = '';
  for (const char of withoutNote) {
    if (char === '{') depth += 1;
    if (char === '}') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  const expand = (pattern: string): string[] => {
    const match = /\{([^{}]*)\}/.exec(pattern);
    if (match === null) return [pattern];
    return match[1]!.split(',').flatMap((option) => expand(`${pattern.slice(0, match.index)}${option.trim()}${pattern.slice(match.index + match[0].length)}`));
  };
  return parts.map((part) => part.trim()).filter((part) => part !== '').flatMap(expand);
}

function artifactDecisionFromRow(row: Selectable<JerrySchema['artifact_decisions']>): ArtifactDecision {
  return artifactDecisionSchema.parse({ taskId: row.task_id, decision: row.decision, kind: row.kind, title: row.title, url: row.url, reason: row.reason, at: row.created_at });
}

function testRunFromRow(row: Selectable<JerrySchema['test_runs']>): TestRun {
  return testRunSchema.parse({ taskId: row.task_id, sessionId: row.session_id, agentId: row.agent_id, command: row.command, result: row.result, exitCode: row.exit_code, summary: row.summary, at: row.at });
}

/** A path a reviewer gave, repo-relative with forward slashes (reviewers sometimes give absolute paths). */
function repoRelative(task: Task, file: string): string {
  const relative = relativeInside(absolutePath(file.trim(), task.repoRoot, process.platform), task.repoRoot, process.platform);
  return (relative ?? file.trim()).replaceAll('\\', '/').replace(/^\.\//, '');
}

/** `FND-12` â†’ 12; anything else is an unknown finding. */
function findingNumber(findingId: string): number {
  const match = /^FND-(\d+)$/i.exec(findingId.trim());
  if (match === null) throw new StateError(400, `${findingId} is not a finding ID (FND-â€¦)`);
  return Number(match[1]);
}

async function insertFindingEvent(trx: Transaction<JerrySchema>, findingId: number, from: FindingStatus | null, to: FindingStatus, actor: 'user' | 'core', reason: string, at: string): Promise<void> {
  await trx.insertInto('finding_events').values({ finding_id: findingId, from_status: from, to_status: to, actor, reason, at }).execute();
}

function findingFromRow(row: Selectable<JerrySchema['findings']>): Finding {
  return findingSchema.parse({
    findingId: `FND-${row.id}`,
    taskId: row.task_id,
    repoRoot: row.repo_root,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    source: row.source,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    file: row.file,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    title: row.title,
    evidence: row.evidence,
    whyItMatters: row.why,
    suggestedFix: row.fix,
    planRelated: row.plan_related === 1,
    status: row.status,
    statusReason: row.status_reason,
    sessionId: row.session_id,
    agentId: row.agent_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
  });
}

function checkpointFromRow(row: { task_id: string; session_id: string | null; summary: string; next_steps_json: string; created_at: string }): Checkpoint {
  return { taskId: row.task_id, sessionId: row.session_id, summary: row.summary, nextSteps: JSON.parse(row.next_steps_json) as string[], at: row.created_at };
}

/** The target state, or a 409 explaining why the workflow does not allow the step. */
function validTransition(taskId: string, from: WorkflowState | null, event: WorkflowEvent, actor: WorkflowActor, context: TransitionContext = {}): WorkflowState {
  const result = applyEvent(from, event, actor, context);
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
