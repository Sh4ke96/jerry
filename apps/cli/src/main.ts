import { parseArgs } from 'node:util';
import { JERRY_VERSION } from '@jerry/contracts';
import { getCoreStatus, startCore, stopCore } from './core-commands.js';
import { doctor } from './doctor.js';
import { install, uninstall } from './install-commands.js';
import { excludeRepository, includeRepository, listExcludedRepositories } from './repo-commands.js';
import { createTask, decidePlan, listTasks, revisePlan } from './task-commands.js';

const USAGE = `jerry ${JERRY_VERSION} — M0 feasibility spike

Usage:
  jerry install                       Install the JERRY plugin in Claude Code (user scope)
  jerry uninstall [--purge-data]      Remove the plugin and marketplace; keep data unless --purge-data
  jerry doctor                        Check plugin, hooks, Core and project footprint
  jerry core start|stop|status        Manage the local JERRY Core process
  jerry task create --repo <path> --title <text> --scope <glob> [--scope <glob>...]
  jerry task list
  jerry plan revise <taskId> --scope <glob> [--scope <glob>...]
  jerry approve <taskId> --stage plan --version <n> [--comment <text>]
  jerry reject  <taskId> --stage plan --version <n> [--comment <text>]
  jerry repo exclude <path>           Stop monitoring a repository (hard rules still apply)
  jerry repo include <path>           Monitor an excluded repository again
  jerry repo list                     List excluded repositories
`;

async function run(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'install':
      install();
      return;
    case 'uninstall': {
      const { values } = parseArgs({ args: rest, options: { 'purge-data': { type: 'boolean', default: false } } });
      uninstall({ purgeData: values['purge-data'] });
      return;
    }
    case 'doctor':
      await doctor();
      return;
    case 'core':
      return runCore(rest[0]);
    case 'status':
      return runCore('status');
    case 'task':
      return runTask(rest);
    case 'plan': {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { scope: { type: 'string', multiple: true } } });
      if (positionals[0] !== 'revise' || positionals[1] === undefined || values.scope === undefined) throw new UsageError();
      await revisePlan(positionals[1], values.scope);
      return;
    }
    case 'repo': {
      const [subcommand, target] = rest;
      if (subcommand === 'list') return listExcludedRepositories();
      if (subcommand === 'exclude' && target !== undefined) return excludeRepository(target);
      if (subcommand === 'include' && target !== undefined) return includeRepository(target);
      throw new UsageError();
    }
    case 'approve':
    case 'reject': {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { stage: { type: 'string' }, version: { type: 'string' }, comment: { type: 'string', default: '' } },
      });
      const version = Number(values.version);
      if (positionals[0] === undefined || values.stage === undefined || !Number.isInteger(version) || version < 1) throw new UsageError();
      await decidePlan({
        taskId: positionals[0],
        stage: values.stage,
        version,
        decision: command === 'approve' ? 'APPROVED' : 'REJECTED',
        comment: values.comment,
      });
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

async function runCore(subcommand: string | undefined): Promise<void> {
  switch (subcommand) {
    case 'start':
      return startCore();
    case 'stop':
      return stopCore();
    case 'status': {
      const { info, status } = await getCoreStatus();
      console.log(`JERRY Core ${status.version}: pid ${info.pid}, 127.0.0.1:${info.port}, started ${status.startedAt}, home ${status.jerryHome}, ${status.taskCount} task(s), ${status.sessionCount} session(s)`);
      return;
    }
    default:
      throw new UsageError();
  }
}

async function runTask(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { repo: { type: 'string' }, title: { type: 'string' }, scope: { type: 'string', multiple: true } },
  });
  if (positionals[0] === 'list') return listTasks();
  if (positionals[0] === 'create' && values.repo !== undefined && values.title !== undefined && values.scope !== undefined) {
    return createTask({ repo: values.repo, title: values.title, scope: values.scope });
  }
  throw new UsageError();
}

class UsageError extends Error {
  constructor(message = 'Invalid arguments') {
    super(message);
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 64;
    return;
  }
  process.stderr.write(`jerry: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
