import fs from 'node:fs';
import path from 'node:path';
import type { CoreState } from '@jerry/contracts';
import { openJerryDatabase } from '@jerry/database';
import { computePlanHash } from '@jerry/policy-engine';
import { afterAll, describe, expect, it } from 'vitest';
import { StateStore } from '../../apps/core/src/state-store.js';
import { tempDir } from '../helpers/harness.js';
import { samplePlan } from '../helpers/plan-fixture.js';

const base = tempDir('state-store');
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;
function options(): { databaseFile: string; backupsDir: string; legacyStateFile: string } {
  counter += 1;
  const dir = path.join(base, `case-${counter}`);
  return { databaseFile: path.join(dir, 'database', 'jerry.sqlite'), backupsDir: path.join(dir, 'backups'), legacyStateFile: path.join(dir, 'state', 'core-state.json') };
}

const REPO = path.join(base, 'Repo');
const now = (minute: number): Date => new Date(Date.UTC(2026, 10, 6, 12, minute));

describe('StateStore on SQLite', () => {
  it('persists tasks, plan versions, approvals, sessions and exclusions across reopen', async () => {
    const where = options();
    const store = await StateStore.open(where);
    const task = await store.createTask({ repoRoot: REPO, title: 'Feature', scope: ['src/**'] }, now(0));
    expect(task.taskId).toBe('JRY-0001');
    await store.recordApproval(task.taskId, { stage: 'PLAN', version: 1, decision: 'APPROVED', comment: '' }, now(1));
    await store.revisePlan(task.taskId, ['src/**', 'test/**'], now(2));
    await store.registerSession({ sessionId: 's1', cwd: REPO, source: 'startup' }, now(3));
    await store.registerSession({ sessionId: 's1', cwd: REPO, source: 'resume' }, now(4));
    await store.setExcluded(REPO, true, now(5));
    await store.close();

    const reopened = await StateStore.open(where);
    const snapshot = reopened.snapshot();
    expect(snapshot.tasks).toMatchObject([{ taskId: 'JRY-0001', repoRoot: REPO, plan: { version: 2, scope: ['src/**', 'test/**'] } }]);
    expect(snapshot.approvals).toHaveLength(1);
    // The approval was for v1; the revised v2 is not approved.
    expect(reopened.planDecision('JRY-0001')).toBeNull();
    expect(snapshot.sessions).toMatchObject([{ sessionId: 's1', source: 'resume', firstSeenAt: now(3).toISOString(), lastSeenAt: now(4).toISOString() }]);
    expect(reopened.sessionCount).toBe(1);
    expect(snapshot.excludedRepos).toMatchObject([{ repoRoot: REPO }]);
    expect((await reopened.createTask({ repoRoot: REPO, title: 'Next', scope: ['**'] }, now(6))).taskId).toBe('JRY-0002');
    await reopened.close();
  });

  it('keeps every plan version and an audit trail of sensitive operations', async () => {
    const where = options();
    const store = await StateStore.open(where);
    const task = await store.createTask({ repoRoot: REPO, title: 'History', scope: ['a/**'] }, now(0));
    await store.revisePlan(task.taskId, ['b/**'], now(1));
    await store.recordApproval(task.taskId, { stage: 'PLAN', version: 2, decision: 'APPROVED', comment: 'ok' }, now(2));
    await store.close();

    const database = await openJerryDatabase({ file: where.databaseFile, backupsDir: where.backupsDir });
    const plans = await database.db.selectFrom('plans').select(['version', 'scope_json']).orderBy('version').execute();
    expect(plans).toEqual([
      { version: 1, scope_json: '["a/**"]' },
      { version: 2, scope_json: '["b/**"]' },
    ]);
    const actions = await database.db.selectFrom('audit_log').select('action').orderBy('id').execute();
    expect(actions.map((row) => row.action)).toEqual(['task.create', 'plan.revise', 'approval.approved']);
    await database.close();
  });

  it('stores the full plan document, and a revision with a new document voids the approval', async () => {
    const where = options();
    const store = await StateStore.open(where);
    const task = await store.createTask({ repoRoot: REPO, title: 'Greeting', scope: ['src/greeting/**'], document: samplePlan(REPO, ['src/greeting/**']), submittedBy: 'claude' }, now(0));
    expect(task.plan.document?.goal).toContain('greeting helper');
    await store.recordApproval(task.taskId, { stage: 'PLAN', version: 1, decision: 'APPROVED', comment: '' }, now(1));

    const changed = { ...samplePlan(REPO, ['src/greeting/**']), goal: 'Add a localised greeting helper.' };
    const revised = await store.revisePlan(task.taskId, changed.scope.include, now(2), changed, 'claude');
    expect(revised.plan.version).toBe(2);
    expect(revised.plan.contentHash).not.toBe(task.plan.contentHash);
    expect(store.planDecision(task.taskId)).toBeNull();
    await store.close();

    const reopened = await StateStore.open(where);
    expect(reopened.snapshot().tasks[0]?.plan.document?.goal).toBe('Add a localised greeting helper.');
    await reopened.close();

    const database = await openJerryDatabase({ file: where.databaseFile, backupsDir: where.backupsDir });
    const actors = await database.db.selectFrom('audit_log').select(['action', 'actor']).orderBy('id').execute();
    expect(actors).toEqual([
      { action: 'task.create', actor: 'claude-code' },
      { action: 'approval.approved', actor: 'local-user' },
      { action: 'plan.revise', actor: 'claude-code' },
    ]);
    await database.close();
  });

  it('rejects a decision for a stale plan version', async () => {
    const store = await StateStore.open(options());
    const task = await store.createTask({ repoRoot: REPO, title: 'Stale', scope: ['**'] }, now(0));
    await store.revisePlan(task.taskId, ['src/**'], now(1));
    await expect(store.recordApproval(task.taskId, { stage: 'PLAN', version: 1, decision: 'APPROVED', comment: '' }, now(2))).rejects.toMatchObject({ statusCode: 409 });
    await store.close();
  });

  it('imports the M0 JSON state once and keeps the file, renamed', async () => {
    const where = options();
    const scope = ['apps/**'];
    const contentHash = computePlanHash({ taskId: 'JRY-0001', title: 'M1 Core Foundation', repoRoot: REPO, version: 1, scope });
    const legacy: CoreState = {
      schemaVersion: 1,
      nextTaskNumber: 2,
      tasks: [{ taskId: 'JRY-0001', title: 'M1 Core Foundation', repoRoot: REPO, createdAt: now(0).toISOString(), plan: { version: 1, contentHash, scope, createdAt: now(0).toISOString() } }],
      approvals: [
        { approvalId: 'apr_1', taskId: 'JRY-0001', stage: 'PLAN', version: 1, contentHash, decision: 'APPROVED', approvedBy: 'local-user', approvedAt: now(1).toISOString(), comment: '' },
      ],
      sessions: [{ sessionId: 'old', cwd: REPO, source: null, firstSeenAt: now(2).toISOString(), lastSeenAt: now(3).toISOString() }],
      excludedRepos: [],
    };
    fs.mkdirSync(path.dirname(where.legacyStateFile), { recursive: true });
    fs.writeFileSync(where.legacyStateFile, JSON.stringify(legacy));

    const store = await StateStore.open(where);
    expect(store.snapshot()).toMatchObject({ nextTaskNumber: 2, tasks: [{ taskId: 'JRY-0001' }], approvals: [{ approvalId: 'apr_1' }], sessions: [{ sessionId: 'old' }] });
    expect(store.planDecision('JRY-0001')?.decision).toBe('APPROVED');
    expect(fs.existsSync(where.legacyStateFile)).toBe(false);
    expect(fs.readdirSync(path.dirname(where.legacyStateFile)).some((name) => name.startsWith('core-state.json.imported-'))).toBe(true);
    expect((await store.createTask({ repoRoot: REPO, title: 'After import', scope: ['**'] }, now(4))).taskId).toBe('JRY-0002');
    await store.close();
  });
});
