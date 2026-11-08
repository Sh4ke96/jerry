import fs from 'node:fs';
import path from 'node:path';
import type { ReportDraft, Task } from '@jerry/contracts';
import type { StateStore } from './state-store.js';

/**
 * A draft of a task's implementation report from what JERRY recorded, so Claude writes only what
 * needs judgement (summary, descriptions it cannot take from the plan, risks, QA scenarios) instead of
 * the whole document: output tokens cost several times input tokens. Read-only; Claude still submits
 * the report, with checks it ran again, and JERRY still adds its own evidence on submission.
 */

const MAX_FILES = 200;

/** The plan's change that names this file, or the folder it lies in. */
function planChangeFor(document: Task['plan']['document'], file: string): { kind: string; description: string } | null {
  if (document === undefined) return null;
  const normalized = (value: string): string => value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const exact = document.changes.find((change) => normalized(change.target) === file);
  if (exact !== undefined) return exact;
  const folder = document.changes.filter((change) => file.startsWith(`${normalized(change.target)}/`)).sort((a, b) => b.target.length - a.target.length)[0];
  return folder ?? null;
}

export async function buildReportDraft(store: StateStore, task: Task): Promise<ReportDraft> {
  const document = task.plan.document;
  const changed = (await store.changesSincePlanApproval(task, { withinScope: false })).slice(0, MAX_FILES);
  const inScope = new Set(await store.changesSincePlanApproval(task));
  const changes = changed.map((file) => {
    const planned = planChangeFor(document, file);
    const exists = fs.existsSync(path.isAbsolute(file) ? file : path.join(task.repoRoot, file));
    const kind = !exists ? 'deleted' : planned?.kind === 'add' ? 'added' : 'modified';
    const source = `${planned === null ? 'git' : 'git + plan'}${inScope.has(file) ? '' : ' (outside the plan scope: explain it as a deviation)'}`;
    return { path: file, kind, description: planned?.description ?? '', source } as const;
  });

  // The latest recorded run of each test command, newest first.
  const runs = await store.testRunsOf(task.taskId, 50);
  const seen = new Set<string>();
  const checks = runs
    .filter((run) => {
      const key = run.command.trim().replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((run) => ({
      kind: 'test' as const,
      command: run.command,
      result: run.result === 'PASS' ? ('PASS' as const) : ('FAIL' as const),
      details: [run.summary, run.result === 'INTERRUPTED' ? 'interrupted' : null, run.exitCode === null || run.exitCode === 0 ? null : `exit ${run.exitCode}`, `recorded ${run.at}`].filter((part): part is string => part !== null && part !== '').join(' · '),
    }));

  const deviations = await store.kysely
    .selectFrom('hook_events')
    .select(['occurred_at', 'tool_name', 'rule_id', 'payload_json'])
    .where('task_id', '=', task.taskId)
    .where('verdict', '=', 'WARN')
    .orderBy('occurred_at', 'desc')
    .limit(20)
    .execute();

  const fill = [
    'summary: what was done, in a few sentences',
    ...(changes.some((change) => change.description === '') ? [`a description for each change without one (${changes.filter((change) => change.description === '').length})`] : []),
    'checks: run the project checks again (test, build, lint, typecheck) and replace or add their real results; a check you did not run is NOT_RUN with the reason',
    'planDeviations: explain each recorded deviation that belongs to this task, and any step done differently',
    'risks: open findings and risks',
    `qaScenarios in ${store.settings().qaLanguage === 'en' ? 'English' : 'Polish'} (qaLanguage ${store.settings().qaLanguage})`,
  ];

  return {
    taskId: task.taskId,
    planVersion: task.plan.version,
    draft: {
      summary: '',
      changes: changes.map(({ path: file, kind, description }) => ({ repository: '', path: file, kind, description })),
      checks,
      planDeviations: [],
      risks: [],
      commitSubjects: document?.commitSubjects ?? [],
      qaLanguage: store.settings().qaLanguage,
    },
    sources: {
      changes: changes.map(({ path: file, source }) => ({ path: file, source })),
      deviations: deviations.map((row) => {
        let reason = '';
        try {
          reason = String((JSON.parse(row.payload_json) as { reason?: unknown }).reason ?? '');
        } catch {
          reason = '';
        }
        return { at: row.occurred_at, tool: row.tool_name, rule: row.rule_id, reason: reason.slice(0, 300) };
      }),
      truncated: changed.length >= MAX_FILES,
    },
    fill,
  };
}
