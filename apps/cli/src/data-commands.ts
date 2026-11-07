import path from 'node:path';
import { dataUsageSchema, forgetPreviewSchema, forgetResultSchema, prunePreviewSchema, pruneResultSchema, type DataCategory, type PruneOptions } from '@jerry/contracts';
import { flag, mark, type EmojiName } from './emoji.js';
import { ask, callCore, formatBytes, requireTerminal, samePath } from './terminal.js';

/**
 * `jerry data`: what JERRY stores and deleting old data. Showing is read-only. Deleting is the
 * user's decision: an interactive terminal, a preview of exactly what goes, and a typed
 * confirmation. Core backs the database up first and deletes in one transaction.
 */

/** Deleting and compacting a large database takes a while. */
const DELETE_TIMEOUT_MS = 10 * 60 * 1000;

const CATEGORY_EMOJI: Readonly<Record<DataCategory, EmojiName>> = {
  tasks: 'task',
  analysis: 'analysis',
  review: 'review',
  quality: 'finding',
  events: 'report',
  sessions: 'session',
  git: 'checkpoint',
  projects: 'repository',
  evals: 'evals',
  system: 'security',
};

const number = (value: number): string => value.toLocaleString('en-US');

export async function showDataUsage(options: { json: boolean }): Promise<void> {
  const usage = dataUsageSchema.parse(await callCore('GET', '/api/v1/data/usage', undefined, 60_000));
  if (options.json) {
    console.log(JSON.stringify(usage, null, 2));
    return;
  }
  console.log(mark('jerry', `JERRY stores ${formatBytes(usage.totalBytes)} on this computer`));
  console.log(`  Database   ${formatBytes(usage.database.bytes).padStart(9)}  ${usage.database.file}`);
  console.log(`  Backups    ${formatBytes(usage.backups.bytes).padStart(9)}  ${usage.backups.count} file(s) in ${usage.backups.dir}`);
  console.log(`  Logs       ${formatBytes(usage.logs.bytes).padStart(9)}  ${usage.logs.dir}`);
  console.log(`  Events and sessions older than ${usage.retentionDays} days are removed automatically.`);
  console.log('');
  console.log(`  ${'What'.padEnd(13)} ${'Rows'.padStart(10)} ${'Size'.padStart(10)}`);
  for (const category of usage.categories) {
    console.log(`  ${mark(CATEGORY_EMOJI[category.category], category.category.padEnd(10))} ${number(category.rows).padStart(10)} ${formatBytes(category.bytes).padStart(10)}`);
  }
  if (usage.projects.length > 0) {
    console.log('');
    for (const project of usage.projects) {
      const kind = project.project ? 'project' : 'not a project';
      console.log(mark('repository', `${project.repoRoot}  (${kind})  ${project.tasks} task(s), ${project.openTasks} open, ${number(project.events)} event(s)`));
    }
  }
  console.log('');
  console.log(mark('next', 'Delete old data with "jerry data prune", everything about one repository with "jerry data forget <path>".'));
}

function rowLines(rows: Record<string, number>): string[] {
  return Object.entries(rows)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, count]) => `    ${table.padEnd(26)} ${number(count).padStart(10)}`);
}

export async function pruneData(options: PruneOptions): Promise<void> {
  requireTerminal('Deleting JERRY data');
  if (options.doneOlderThanDays === undefined && options.eventsOlderThanDays === undefined && options.evalsOlderThanDays === undefined && options.backupsKeep === undefined) {
    throw new Error('Say what to delete: --done-older-than <days>, --events-older-than <days>, --evals-older-than <days> or --backups-keep <n>');
  }
  const preview = prunePreviewSchema.parse(await callCore('POST', '/api/v1/data/prune/preview', options, 60_000));
  if (preview.cutoffs.done !== null) console.log(mark('task', `${preview.tasks.length} finished or cancelled task(s) last changed before ${preview.cutoffs.done}, with everything tied to them${preview.tasks.length > 0 ? `: ${preview.tasks.slice(0, 10).join(', ')}${preview.tasks.length > 10 ? ` (+${preview.tasks.length - 10} more)` : ''}` : ''}`));
  if (preview.cutoffs.events !== null) console.log(mark('report', `Events, sessions and subagent runs from before ${preview.cutoffs.events}`));
  if (preview.cutoffs.evals !== null) console.log(mark('evals', `Eval runs from before ${preview.cutoffs.evals} (baseline runs stay)`));
  if (preview.options.backupsKeep !== undefined) console.log(mark('checkpoint', `${preview.backups.count} backup file(s), ${formatBytes(preview.backups.bytes)} (the newest ${preview.options.backupsKeep} stay)`));
  if (preview.totalRows === 0 && preview.backups.count === 0) {
    console.log(mark('pass', 'Nothing to delete.'));
    return;
  }
  console.log(`\n  Rows to delete: ${number(preview.totalRows)}`);
  for (const line of rowLines(preview.rows)) console.log(line);
  console.log('\n  Open tasks and the eval baselines are never deleted. A backup of the database is taken first.');
  const typed = await ask('Type "delete" to delete this permanently: ');
  if (typed !== 'delete') {
    console.log(mark('fail', 'Confirmation did not match. Nothing was deleted.'));
    process.exitCode = 1;
    return;
  }
  const result = pruneResultSchema.parse(await callCore('POST', '/api/v1/data/prune', options, DELETE_TIMEOUT_MS));
  console.log(mark('pass', `Deleted ${number(result.totalRows)} row(s) and ${result.backups.count} backup file(s). Database ${formatBytes(result.databaseBytesBefore)} -> ${formatBytes(result.databaseBytesAfter)}.`));
  console.log(mark('checkpoint', `The database before the deletion: ${result.backupFile}`));
}

export async function forgetRepository(target: string): Promise<void> {
  requireTerminal('Forgetting a repository');
  const wanted = path.resolve(target);
  const preview = forgetPreviewSchema.parse(await callCore('POST', '/api/v1/data/forget/preview', { path: wanted }, 60_000));
  if (preview.openTasks.length > 0) {
    throw new Error(`${preview.repoRoot} has open tasks (${preview.openTasks.join(', ')}). Finish or cancel them first ("jerry task cancel <taskId>").`);
  }
  if (preview.totalRows === 0) {
    console.log(mark('pass', `JERRY stores nothing about ${preview.repoRoot}.`));
    return;
  }
  console.log(mark('repository', `JERRY will forget everything it stores about ${preview.repoRoot}${preview.project ? ' and remove the project' : ''}:`));
  console.log(`  ${preview.tasks.length} task(s) and ${number(preview.totalRows)} row(s) in all:`);
  for (const line of rowLines(preview.rows)) console.log(line);
  console.log(flag('This cannot be undone from JERRY (a backup of the database is taken first).'));
  const typed = await ask(`Type the repository path to confirm (${preview.repoRoot}): `);
  if (!samePath(typed, preview.repoRoot)) {
    console.log(mark('fail', 'Confirmation did not match. Nothing was deleted.'));
    process.exitCode = 1;
    return;
  }
  const result = forgetResultSchema.parse(await callCore('POST', '/api/v1/data/forget', { path: preview.repoRoot }, DELETE_TIMEOUT_MS));
  console.log(mark('pass', `JERRY forgot ${result.repoRoot}: ${number(result.totalRows)} row(s) deleted. Database ${formatBytes(result.databaseBytesBefore)} -> ${formatBytes(result.databaseBytesAfter)}.`));
  console.log(mark('checkpoint', `The database before the deletion: ${result.backupFile}`));
}
