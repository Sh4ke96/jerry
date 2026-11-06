import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  coreStateSchema,
  storedEventSchema,
  type ApprovalRecord,
  type ApprovalRequest,
  type CoreState,
  type EventEnvelope,
  type SessionRegistration,
  type StoredEvent,
  type Task,
} from '@jerry/contracts';
import { backupDatabase, openJerryDatabase, type JerryDatabase, type JerrySchema } from '@jerry/database';
import { comparablePath, computePlanHash, currentPlanDecision } from '@jerry/policy-engine';
import { sql, type Kysely, type Transaction } from 'kysely';

/** Sessions kept in the in-memory snapshot; older ones stay in the database. */
const SNAPSHOT_SESSIONS = 200;
const NEXT_TASK_NUMBER = 'next_task_number';

/** Where a user decision came from; recorded in the audit log. */
export type Channel = 'cli' | 'dashboard';

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
}

/**
 * JERRY state in SQLite (ADR 0005). Gate checks read an in-memory snapshot, so they never wait for
 * the database; every mutation is one transaction followed by a snapshot reload. Core is the only
 * writer, so the snapshot cannot go stale.
 */
export class StateStore {
  private state: CoreState = emptyState();
  private sessionTotal = 0;

  private constructor(private readonly database: JerryDatabase) {}

  static async open(options: StateStoreOptions): Promise<StateStore> {
    const database = await openJerryDatabase({ file: options.databaseFile, backupsDir: options.backupsDir });
    const store = new StateStore(database);
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

  async createTask(input: { repoRoot: string; title: string; scope: string[] }, now: Date): Promise<Task> {
    const at = now.toISOString();
    const taskId = await this.database.db.transaction().execute(async (trx) => {
      const repoId = await upsertRepository(trx, input.repoRoot, at);
      const setting = await trx.selectFrom('settings').select('value_json').where('key', '=', NEXT_TASK_NUMBER).executeTakeFirst();
      const number = setting === undefined ? 1 : Number(JSON.parse(setting.value_json));
      const id = `JRY-${String(number).padStart(4, '0')}`;
      await trx.insertInto('tasks').values({ task_id: id, title: input.title, repo_id: repoId, current_plan_version: 1, created_at: at, updated_at: at }).execute();
      await insertPlan(trx, { taskId: id, title: input.title, repoRoot: input.repoRoot, version: 1, scope: input.scope, at });
      await trx
        .insertInto('settings')
        .values({ key: NEXT_TASK_NUMBER, value_json: JSON.stringify(number + 1), created_at: at, updated_at: at })
        .onConflict((conflict) => conflict.column('key').doUpdateSet({ value_json: JSON.stringify(number + 1), updated_at: at }))
        .execute();
      await audit(trx, at, 'task.create', id, { repoRoot: input.repoRoot, scope: input.scope });
      return id;
    });
    await this.reload();
    return this.requireTask(taskId);
  }

  /** Creates the next plan version. Earlier versions and their approvals stay in history but no longer match. */
  async revisePlan(taskId: string, scope: string[], now: Date): Promise<Task> {
    const task = this.requireTask(taskId);
    const at = now.toISOString();
    const version = task.plan.version + 1;
    await this.database.db.transaction().execute(async (trx) => {
      await insertPlan(trx, { taskId, title: task.title, repoRoot: task.repoRoot, version, scope, at });
      await trx.updateTable('tasks').set({ current_plan_version: version, updated_at: at }).where('task_id', '=', taskId).execute();
      await audit(trx, at, 'plan.revise', taskId, { version, scope });
    });
    await this.reload();
    return this.requireTask(taskId);
  }

  async recordApproval(taskId: string, request: ApprovalRequest, now: Date, channel: Channel = 'cli'): Promise<ApprovalRecord> {
    const task = this.requireTask(taskId);
    if (request.version !== task.plan.version) {
      throw new StateError(409, `${taskId} plan is at version ${task.plan.version}; refusing a decision for version ${request.version}`);
    }
    const at = now.toISOString();
    const record: ApprovalRecord = {
      approvalId: `apr_${randomUUID()}`,
      taskId,
      stage: request.stage,
      version: task.plan.version,
      contentHash: task.plan.contentHash,
      decision: request.decision,
      approvedBy: 'local-user',
      approvedAt: at,
      comment: request.comment,
    };
    await this.database.db.transaction().execute(async (trx) => {
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
    });
    await this.reload();
    return record;
  }

  async registerSession(registration: SessionRegistration, now: Date): Promise<void> {
    const at = now.toISOString();
    await this.database.db
      .insertInto('sessions')
      .values({ session_id: registration.sessionId, cwd: registration.cwd, source: registration.source, first_seen_at: at, last_seen_at: at, created_at: at, updated_at: at })
      .onConflict((conflict) => conflict.column('session_id').doUpdateSet({ cwd: registration.cwd, source: registration.source, last_seen_at: at, updated_at: at }))
      .execute();
    await this.reload();
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

  private async reload(): Promise<void> {
    const { db } = this.database;
    const tasks = await db
      .selectFrom('tasks')
      .innerJoin('repositories', 'repositories.repo_id', 'tasks.repo_id')
      .innerJoin('plans', (join) => join.onRef('plans.task_id', '=', 'tasks.task_id').onRef('plans.version', '=', 'tasks.current_plan_version'))
      .select(['tasks.task_id', 'tasks.title', 'tasks.created_at', 'repositories.root_path', 'plans.version', 'plans.content_hash', 'plans.scope_json', 'plans.created_at as plan_created_at'])
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
        plan: { version: row.version, contentHash: row.content_hash, scope: JSON.parse(row.scope_json), createdAt: row.plan_created_at },
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
  }

  /** One-time import of the M0 JSON state into an empty database; the JSON file is kept, renamed. */
  private async importLegacyState(legacyStateFile: string): Promise<void> {
    if (!fs.existsSync(legacyStateFile)) return;
    const { db } = this.database;
    const existing = await db.selectFrom('tasks').select('task_id').limit(1).executeTakeFirst();
    if (existing !== undefined) return;

    const parsed = coreStateSchema.safeParse(JSON.parse(fs.readFileSync(legacyStateFile, 'utf8')));
    if (!parsed.success) {
      throw new Error(`Legacy state file ${legacyStateFile} is invalid; refusing to start with unknown state: ${parsed.error.message}`);
    }
    const legacy = parsed.data;
    const at = new Date().toISOString();
    await db.transaction().execute(async (trx) => {
      for (const task of legacy.tasks) {
        const repoId = await upsertRepository(trx, task.repoRoot, task.createdAt);
        await trx.insertInto('tasks').values({ task_id: task.taskId, title: task.title, repo_id: repoId, current_plan_version: task.plan.version, created_at: task.createdAt, updated_at: at }).execute();
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

async function insertPlan(trx: Transaction<JerrySchema>, plan: { taskId: string; title: string; repoRoot: string; version: number; scope: string[]; at: string }): Promise<void> {
  await trx
    .insertInto('plans')
    .values({
      task_id: plan.taskId,
      version: plan.version,
      content_hash: computePlanHash({ taskId: plan.taskId, title: plan.title, repoRoot: plan.repoRoot, version: plan.version, scope: plan.scope }),
      scope_json: JSON.stringify(plan.scope),
      created_at: plan.at,
    })
    .execute();
}

async function audit(trx: Transaction<JerrySchema>, at: string, action: string, subject: string | null, details: Record<string, unknown>): Promise<void> {
  await trx.insertInto('audit_log').values({ at, actor: 'local-user', action, subject, details_json: JSON.stringify(details), created_at: at }).execute();
}
