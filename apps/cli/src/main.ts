import { JERRY_VERSION } from '@jerry/contracts';
import { Command, InvalidArgumentError } from 'commander';
import { getCoreStatus, startCore, stopCore } from './core-commands.js';
import { backupNow, restoreFromBackup, showBackups } from './db-commands.js';
import { doctor } from './doctor.js';
import { showEvents } from './events-command.js';
import { install, uninstall } from './install-commands.js';
import { excludeRepository, includeRepository, listExcludedRepositories } from './repo-commands.js';
import { graphCommand, profileCommand, scanCommand } from './scan-command.js';
import { showStatus } from './status-command.js';
import { controlTask, createTask, decide, listTasks, revisePlan, showTask } from './task-commands.js';
import { openDashboard } from './ui-command.js';

/** Repeatable option without a default, so a required one is really required. */
const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('must be a positive integer');
  return parsed;
}

function stage(value: string): 'PLAN' | 'IMPLEMENTATION' {
  const normalized = value.toLowerCase();
  if (normalized === 'plan') return 'PLAN';
  if (normalized === 'implementation') return 'IMPLEMENTATION';
  throw new InvalidArgumentError('must be "plan" or "implementation"');
}

const program = new Command()
  .name('jerry')
  .description('JERRY: local guardian for Claude Code. Monitors sessions, keeps Git with you, shows everything in a dashboard.')
  .version(JERRY_VERSION, '-v, --version')
  // Program options only before the subcommand: "jerry approve … --version 2" is the plan version.
  .enablePositionalOptions()
  .showHelpAfterError('(run with --help for usage)');

program.command('status').description('Short summary: guard state, plans, today\'s deviations').action(() => showStatus());
program.command('doctor').description('Full diagnostics of the installation, hooks, Core, database and settings').action(() => doctor());
program.command('install').description('Install or update the JERRY plugin and Core runtime (Claude Code user scope)').action(() => install());
program
  .command('uninstall')
  .description('Remove the plugin, marketplace and Core runtime; keep data unless --purge-data')
  .option('--purge-data', 'also delete JERRY data (state, events, backups)', false)
  .action((options: { purgeData: boolean }) => uninstall({ purgeData: options.purgeData }));
program
  .command('ui')
  .description('Open the dashboard in the browser with a one-time login link')
  .option('--print-url', 'print the link instead of opening the browser', false)
  .action((options: { printUrl: boolean }) => openDashboard({ printOnly: options.printUrl }));

const core = program.command('core').description('Manage the local JERRY Core process');
core.command('start').description('Start Core (and allow automatic starts again)').action(() => startCore());
core.command('stop').description('Stop Core and pause automatic starts until "jerry core start"').action(() => stopCore());
core
  .command('status')
  .description('Show Core process details')
  .action(async () => {
    const { info, status } = await getCoreStatus();
    console.log(`JERRY Core ${status.version}: pid ${info.pid}, 127.0.0.1:${info.port}, started ${status.startedAt}, home ${status.jerryHome}, ${status.taskCount} task(s), ${status.sessionCount} session(s)`);
  });

const task = program.command('task').description('Tasks and their plans');
task
  .command('create')
  .description('Create a task with plan version 1')
  .requiredOption('--repo <path>', 'a path inside the Git repository')
  .requiredOption('--title <text>', 'what the task is about')
  .requiredOption('--scope <glob>', 'repo-relative glob the plan covers (repeatable)', collect)
  .action((options: { repo: string; title: string; scope: string[] }) => createTask(options));
task
  .command('list')
  .description('List open tasks and their workflow state')
  .option('--all', 'include finished and cancelled tasks', false)
  .action((options: { all: boolean }) => listTasks(options));
task.command('show <taskId>').description('Show a task: state, plan, decision and history').action((taskId: string) => showTask(taskId));
const controls = [
  ['pause', 'task.paused', 'Pause a task: its plan stops covering edits until you resume it (interactive)'],
  ['resume', 'task.resumed', 'Resume a paused task in the state it was paused in (interactive)'],
  ['cancel', 'task.cancelled', 'Cancel a task for good (interactive: you type the task ID)'],
] as const;
for (const [verb, event, description] of controls) {
  task
    .command(`${verb} <taskId>`)
    .description(description)
    .option('--reason <text>', 'note stored in the task history', '')
    .action((taskId: string, options: { reason: string }) => controlTask(taskId, event, options.reason));
}

program
  .command('plan')
  .description('Revise a plan')
  .command('revise <taskId>')
  .description('Create the next plan version with a new scope (earlier approvals stop applying)')
  .requiredOption('--scope <glob>', 'repo-relative glob (repeatable)', collect)
  .action((taskId: string, options: { scope: string[] }) => revisePlan(taskId, options.scope));

for (const decision of ['approve', 'reject'] as const) {
  program
    .command(`${decision} <taskId>`)
    .description(
      decision === 'approve'
        ? 'Approve a plan version, or accept an implementation report (interactive: you type the task ID)'
        : 'Reject a plan version, or request changes to an implementation report (interactive: you type the task ID)',
    )
    .requiredOption('--stage <stage>', 'what is decided: plan or implementation', stage)
    .requiredOption('--version <n>', 'the plan or report version you reviewed', positiveInteger)
    .option('--comment <text>', decision === 'approve' ? 'note stored with the decision' : 'what should change (stored with the decision and shown to Claude)', '')
    .action((taskId: string, options: { stage: 'PLAN' | 'IMPLEMENTATION'; version: number; comment: string }) =>
      decide({ taskId, stage: options.stage, version: options.version, decision: decision === 'approve' ? 'APPROVED' : 'REJECTED', comment: options.comment }),
    );
}

const repo = program.command('repo').description('Repositories JERRY monitors');
repo.command('exclude <path>').description('Stop monitoring a repository (interactive; hard rules still apply)').action((target: string) => excludeRepository(target));
repo.command('include <path>').description('Monitor an excluded repository again').action((target: string) => includeRepository(target));
repo.command('list').description('List excluded repositories').action(() => listExcludedRepositories());
repo
  .command('scan [path]')
  .description('Show what JERRY detects in a repository: languages, manifests, commands, CI, API schemas, migrations (read-only)')
  .option('--json', 'print the full scan as JSON', false)
  .action((target: string | undefined, options: { json: boolean }) => scanCommand(target ?? '.', options));
repo
  .command('profile [path]')
  .description("Show the project profile JERRY keeps (rescanned when its sources changed); commands as they run on this machine")
  .option('--refresh', 'rescan now', false)
  .option('--json', 'print the full profile as JSON', false)
  .action((target: string | undefined, options: { refresh: boolean; json: boolean }) => profileCommand(target ?? '.', options));
repo
  .command('graph')
  .description('Show links between the repositories JERRY knows: local path dependencies, shared packages, API contracts')
  .option('--json', 'print the graph as JSON', false)
  .action((options: { json: boolean }) => graphCommand(options));

program
  .command('events')
  .description('Show the latest recorded events, oldest first')
  .option('--session <id>', 'only this Claude Code session')
  .option('--verdict <verdict>', 'only PASS, WARN or DENY (comma-separated)')
  .option('--limit <n>', 'how many events', positiveInteger, 50)
  .action((options: { session?: string; verdict?: string; limit: number }) =>
    showEvents({ limit: options.limit, ...(options.session === undefined ? {} : { sessionId: options.session }), ...(options.verdict === undefined ? {} : { verdict: options.verdict }) }),
  );

const db = program.command('db').description('JERRY database');
db.command('backup').description('Back up the database now (Core must be running)').action(() => backupNow());
db.command('backups').description('List database backups').action(() => showBackups());
db.command('restore <file>').description('Replace the database with a backup (Core stopped; interactive)').action((file: string) => restoreFromBackup(file));

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`jerry: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
