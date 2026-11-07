import { JERRY_VERSION } from '@jerry/contracts';
import { Command, InvalidArgumentError } from 'commander';
import { getCoreStatus, startCore, stopCore } from './core-commands.js';
import { backupNow, restoreFromBackup, showBackups } from './db-commands.js';
import { doctor } from './doctor.js';
import { mark } from './emoji.js';
import { showEvents } from './events-command.js';
import { install, uninstall } from './install-commands.js';
import { evalStatus, labelRun, listCases, listRuns, runEvals, runPluginEval, setBaseline, showRun } from './eval-commands.js';
import { listFindings, setFindingStatus, showFinding } from './findings-commands.js';
import { excludeRepository, includeRepository, listRepositories } from './repo-commands.js';
import { addProject, listProjects, removeProject } from './project-commands.js';
import { forgetRepository, pruneData, showDataUsage } from './data-commands.js';
import { graphCommand, profileCommand, scanCommand } from './scan-command.js';
import { showStatus } from './status-command.js';
import { controlTask, createTask, decide, listTasks, revisePlan, showFinalReport, showPlanDiff, showReview, showTask, skipReview } from './task-commands.js';
import { openDashboard } from './ui-command.js';

/** Repeatable option without a default, so a required one is really required. */
const collect = (value: string, previous: string[] | undefined): string[] => [...(previous ?? []), value];

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError('must be a positive integer');
  return parsed;
}

function nonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError('must be a whole number, 0 or more');
  return parsed;
}

function stage(value: string): 'PLAN' | 'IMPLEMENTATION' | 'REVIEW_FIX' {
  const normalized = value.toLowerCase();
  if (normalized === 'plan') return 'PLAN';
  if (normalized === 'implementation') return 'IMPLEMENTATION';
  if (normalized === 'review-fix') return 'REVIEW_FIX';
  throw new InvalidArgumentError('must be "plan", "implementation" or "review-fix"');
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
    console.log(`${mark('jerry', `JERRY Core ${status.version}`)}: pid ${info.pid}, 127.0.0.1:${info.port}, started ${status.startedAt}, home ${status.jerryHome}, ${status.taskCount} task(s), ${status.sessionCount} session(s)`);
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

const plan = program.command('plan').description('Revise or compare plans');
plan
  .command('revise <taskId>')
  .description('Create the next plan version with a new scope (earlier approvals stop applying)')
  .requiredOption('--scope <glob>', 'repo-relative glob (repeatable)', collect)
  .action((taskId: string, options: { scope: string[] }) => revisePlan(taskId, options.scope));
plan
  .command('diff <taskId>')
  .description('Show what changed between two plan versions (default: the latest against the one before)')
  .option('--from <version>', 'older version')
  .option('--to <version>', 'newer version')
  .action((taskId: string, options: { from?: string; to?: string }) => showPlanDiff(taskId, options));

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
    .action((taskId: string, options: { stage: 'PLAN' | 'IMPLEMENTATION' | 'REVIEW_FIX'; version: number; comment: string }) =>
      decide({ taskId, stage: options.stage, version: options.version, decision: decision === 'approve' ? 'APPROVED' : 'REJECTED', comment: options.comment }),
    );
}

const project = program.command('project').description('Projects: the repositories JERRY monitors (elsewhere only hard rules apply)');
project
  .command('add [path]')
  .description('Monitor a Git repository (default: the one you are in; interactive: you type its path)')
  .action((target: string | undefined) => addProject(target));
project.command('remove <path>').description('Stop monitoring a project; its data stays (interactive: you type its path)').action((target: string) => removeProject(target));
project
  .command('list')
  .description('List projects with their open tasks and last activity')
  .option('--json', 'print the projects as JSON', false)
  .action((options: { json: boolean }) => listProjects(options));

const repo = program.command('repo').description('Repositories: scans, profiles, links (include/exclude/list are project add/remove/list)');
repo.command('include <path>').description('Same as "jerry project add <path>"').action((target: string) => includeRepository(target));
repo.command('exclude <path>').description('Same as "jerry project remove <path>"').action((target: string) => excludeRepository(target));
repo.command('list').description('Same as "jerry project list"').action(() => listRepositories());
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

program
  .command('report <taskId>')
  .description('Show the final report of a task (a draft until it is DONE)')
  .option('--json', 'print the report as JSON', false)
  .action((taskId: string, options: { json: boolean }) => showFinalReport(taskId, options));

const review = program.command('review').description('Independent code review of a task (three JERRY reviewers)');
review.command('show <taskId>').description('Show the review rounds, coverage, independence and open findings').action((taskId: string) => showReview(taskId));
review
  .command('skip <taskId>')
  .description('Waive the review (interactive; a reason is required); the final checks run')
  .option('--reason <text>', 'why')
  .action((taskId: string, options: { reason?: string }) => skipReview(taskId, options));

const findings = program.command('findings').description('Quality findings JERRY recorded while Claude worked');
findings
  .command('list', { isDefault: true })
  .description('List open findings (newest checks first)')
  .option('--task <taskId>', 'only this task')
  .option('--repo <path>', 'only this repository')
  .option('--all', 'include fixed and dismissed findings', false)
  .action((options: { task?: string; repo?: string; all: boolean }) => listFindings(options));
findings.command('show <findingId>').description('Show a finding with its evidence and history').action((findingId: string) => showFinding(findingId));
findings
  .command('set <findingId> <status>')
  .description('Decide on a finding: open, accepted, wont_fix or false_positive (interactive; a reason is required)')
  .option('--reason <text>', 'why')
  .action((findingId: string, status: string, options: { reason?: string }) => setFindingStatus(findingId, status, options));

const evals = program.command('eval').description('JERRY evals: golden cases with real Claude Code sessions, baselines and regressions');
evals
  .command('list')
  .description('List the golden cases')
  .option('--dir <path>', 'case directory (default: ./evals/cases, else the bundled cases)')
  .option('--suite <suite>', 'regression or capability')
  .action((options: { dir?: string; suite?: string }) => listCases(options));
evals
  .command('run')
  .description('Run cases (real Claude Code sessions in temp fixtures; costs tokens) and compare with the baseline')
  .option('--dir <path>', 'case directory')
  .option('--suite <suite>', 'regression or capability')
  .option('--case <id>', 'only this case (repeatable)', collect)
  .option('--repeats <n>', 'attempts per case', positiveInteger)
  .option('--parallel <n>', 'sessions at once (at most 3)', positiveInteger)
  .option('--model <model>', 'model for every case')
  .option('--label <text>', 'a note for this run')
  .option('--keep-failed', 'keep the fixtures of failed attempts', false)
  .action((options: { dir?: string; suite?: string; case?: string[]; repeats?: number; parallel?: number; model?: string; label?: string; keepFailed: boolean }) => runEvals(options));
evals.command('runs').description('List eval runs').action(() => listRuns());
evals.command('show <runId>').description('Show a run, compared with the baseline').action((runId: string) => showRun(runId));
evals.command('status').description('Baseline, what changed since it, calibration').action(() => evalStatus());
evals
  .command('baseline <runId>')
  .description('Make a run the baseline (interactive; a reason is required)')
  .option('--note <text>', 'why')
  .action((runId: string, options: { note?: string }) => setBaseline(runId, options));
evals.command('label <runId> <caseId> <attempt> <rubricId> <verdict>').description('Label a rubric result pass or fail (interactive), for calibration').action((runId: string, caseId: string, attempt: string, rubricId: string, verdict: string) => labelRun(runId, caseId, attempt, rubricId, verdict));
evals
  .command('plugin')
  .description('Run the Claude Code plugin evals of the JERRY plugin (isolated JERRY home, never published)')
  .option('--runs <n>', 'runs per case', positiveInteger)
  .option('--trust', 'pass --trust-plugin (the JERRY plugin is yours)', false)
  .action((options: { runs?: number; trust: boolean }) => runPluginEval(options));

const data = program.command('data').description('What JERRY stores, and deleting old data');
data
  .command('usage', { isDefault: true })
  .description('Show what JERRY stores: rows and size per kind of data, per repository, backups and logs')
  .option('--json', 'print the usage as JSON', false)
  .action((options: { json: boolean }) => showDataUsage(options));
data
  .command('prune')
  .description('Delete old data (interactive: a preview, then you type "delete"; a backup is taken first)')
  .option('--done-older-than <days>', 'finished and cancelled tasks last changed more than <days> ago, with everything tied to them', nonNegativeInteger)
  .option('--events-older-than <days>', 'events, sessions and subagent runs older than <days>', nonNegativeInteger)
  .option('--evals-older-than <days>', 'eval runs older than <days> (baseline runs stay)', nonNegativeInteger)
  .option('--backups-keep <n>', 'keep only the newest <n> backup files', nonNegativeInteger)
  .action((options: { doneOlderThan?: number; eventsOlderThan?: number; evalsOlderThan?: number; backupsKeep?: number }) =>
    pruneData({
      ...(options.doneOlderThan === undefined ? {} : { doneOlderThanDays: options.doneOlderThan }),
      ...(options.eventsOlderThan === undefined ? {} : { eventsOlderThanDays: options.eventsOlderThan }),
      ...(options.evalsOlderThan === undefined ? {} : { evalsOlderThanDays: options.evalsOlderThan }),
      ...(options.backupsKeep === undefined ? {} : { backupsKeep: options.backupsKeep }),
    }),
  );
data
  .command('forget <path>')
  .description('Delete everything JERRY stores about a repository (no open tasks; interactive: you type its path)')
  .action((target: string) => forgetRepository(target));

const db = program.command('db').description('JERRY database');
db.command('backup').description('Back up the database now (Core must be running)').action(() => backupNow());
db.command('backups').description('List database backups').action(() => showBackups());
db.command('restore <file>').description('Replace the database with a backup (Core stopped; interactive)').action((file: string) => restoreFromBackup(file));

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${mark('fail', 'jerry:')} ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
