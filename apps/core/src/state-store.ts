import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  coreStateSchema,
  type ApprovalRecord,
  type ApprovalRequest,
  type CoreState,
  type SessionRegistration,
  type Task,
} from '@jerry/contracts';
import { writeFileAtomic } from '@jerry/platform';
import { computePlanHash, currentPlanDecision } from '@jerry/policy-engine';

const MAX_SESSIONS = 200;

export class StateError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'StateError';
  }
}

/**
 * M0 persistence: one JSON document written atomically after every mutation.
 * Replaced by SQLite + migrations in M1; the public methods are the seam.
 */
export class StateStore {
  private state: CoreState;

  constructor(private readonly filePath: string) {
    this.state = StateStore.load(filePath);
  }

  private static load(filePath: string): CoreState {
    if (!fs.existsSync(filePath)) {
      return { schemaVersion: 1, nextTaskNumber: 1, tasks: [], approvals: [], sessions: [], excludedRepos: [] };
    }
    const parsed = coreStateSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    if (!parsed.success) {
      throw new Error(`JERRY state file ${filePath} is invalid; refusing to start with unknown state: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  snapshot(): CoreState {
    return structuredClone(this.state);
  }

  createTask(input: { repoRoot: string; title: string; scope: string[] }, now: Date): Task {
    const taskId = `JRY-${String(this.state.nextTaskNumber).padStart(4, '0')}`;
    const version = 1;
    const task: Task = {
      taskId,
      title: input.title,
      repoRoot: input.repoRoot,
      createdAt: now.toISOString(),
      plan: {
        version,
        scope: input.scope,
        contentHash: computePlanHash({ taskId, title: input.title, repoRoot: input.repoRoot, version, scope: input.scope }),
        createdAt: now.toISOString(),
      },
    };
    this.mutate((state) => {
      state.nextTaskNumber += 1;
      state.tasks.push(task);
    });
    return task;
  }

  /** Creates the next plan version. Earlier approvals stay in history but no longer match. */
  revisePlan(taskId: string, scope: string[], now: Date): Task {
    const task = this.requireTask(taskId);
    const version = task.plan.version + 1;
    const revised: Task = {
      ...task,
      plan: {
        version,
        scope,
        contentHash: computePlanHash({ taskId, title: task.title, repoRoot: task.repoRoot, version, scope }),
        createdAt: now.toISOString(),
      },
    };
    this.mutate((state) => {
      state.tasks = state.tasks.map((existing) => (existing.taskId === taskId ? revised : existing));
    });
    return revised;
  }

  recordApproval(taskId: string, request: ApprovalRequest, now: Date): ApprovalRecord {
    const task = this.requireTask(taskId);
    if (request.version !== task.plan.version) {
      throw new StateError(409, `${taskId} plan is at version ${task.plan.version}; refusing a decision for version ${request.version}`);
    }
    const record: ApprovalRecord = {
      approvalId: `apr_${randomUUID()}`,
      taskId,
      stage: request.stage,
      version: task.plan.version,
      contentHash: task.plan.contentHash,
      decision: request.decision,
      approvedBy: 'local-user',
      approvedAt: now.toISOString(),
      comment: request.comment,
    };
    this.mutate((state) => {
      state.approvals.push(record);
    });
    return record;
  }

  registerSession(registration: SessionRegistration, now: Date): void {
    const timestamp = now.toISOString();
    this.mutate((state) => {
      const existing = state.sessions.find((session) => session.sessionId === registration.sessionId);
      if (existing === undefined) {
        state.sessions.push({ ...registration, firstSeenAt: timestamp, lastSeenAt: timestamp });
      } else {
        existing.cwd = registration.cwd;
        existing.source = registration.source;
        existing.lastSeenAt = timestamp;
      }
      state.sessions = state.sessions.slice(-MAX_SESSIONS);
    });
  }

  /** Excluding stops monitoring for the repository; hard rules keep applying there. */
  setExcluded(repoRoot: string, excluded: boolean, now: Date): void {
    this.mutate((state) => {
      const key = (root: string): string => (process.platform === 'win32' ? root.toLowerCase() : root);
      state.excludedRepos = state.excludedRepos.filter((exclusion) => key(exclusion.repoRoot) !== key(repoRoot));
      if (excluded) state.excludedRepos.push({ repoRoot, excludedAt: now.toISOString() });
    });
  }

  planDecision(taskId: string): ApprovalRecord | null {
    return currentPlanDecision(this.requireTask(taskId), this.state.approvals);
  }

  private requireTask(taskId: string): Task {
    const task = this.state.tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) throw new StateError(404, `Unknown task ${taskId}`);
    return task;
  }

  private mutate(change: (draft: CoreState) => void): void {
    const draft = structuredClone(this.state);
    change(draft);
    const validated = coreStateSchema.parse(draft);
    writeFileAtomic(this.filePath, `${JSON.stringify(validated, null, 2)}\n`);
    this.state = validated;
  }
}
