import fs from 'node:fs';
import path from 'node:path';
import { projectAddResultSchema, projectRemoveResultSchema, projectSummarySchema } from '@jerry/contracts';
import { z } from 'zod';
import { flag, mark } from './emoji.js';
import { confirmDecision } from './settings-commands.js';
import { callCore, requireTerminal, samePath } from './terminal.js';

/**
 * `jerry project`: the repositories JERRY monitors. Outside them only the hard rules apply and
 * nothing is recorded. Adding and removing are the user's decisions: an interactive terminal and
 * the repository path typed as confirmation.
 */

/** Nearest ancestor (inclusive) with a ".git" entry: the Git working tree root. */
function gitRootOf(target: string): string | null {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolvedRoot(target: string | undefined): string {
  const start = path.resolve(target ?? process.cwd());
  if (!fs.existsSync(start)) throw new Error(`${start} does not exist`);
  const root = gitRootOf(fs.realpathSync.native(start));
  if (root === null) throw new Error(`${start} is not inside a Git repository; a JERRY project is a Git repository`);
  return root;
}

export async function addProject(target: string | undefined): Promise<void> {
  requireTerminal('Adding a project');
  const root = resolvedRoot(target);
  console.log(mark('repository', `JERRY will monitor ${root}:`));
  console.log('  plans, approvals, deviations, quality findings and reviews of the work there are recorded.');
  console.log('  Hard rules apply everywhere, added or not.');
  if (!(await confirmDecision({ question: `Add ${root} as a JERRY project?`, typedPrompt: `Type the repository path to add it (${root})`, matches: (typed) => samePath(typed, root) }))) return;
  const result = projectAddResultSchema.parse(await callCore('POST', '/api/v1/projects', { path: root }));
  console.log(result.added ? mark('pass', `Added ${result.project.repoRoot}. JERRY monitors it from the next tool call.`) : mark('info', `${result.project.repoRoot} is already a project.`));
}

export async function removeProject(target: string): Promise<void> {
  requireTerminal('Removing a project');
  const wanted = path.resolve(target);
  const projects = z.array(projectSummarySchema).parse(await callCore('GET', '/api/v1/projects'));
  const project = projects.find((candidate) => samePath(candidate.repoRoot, wanted)) ?? projects.find((candidate) => fs.existsSync(wanted) && samePath(candidate.repoRoot, gitRootOf(wanted) ?? wanted));
  if (project === undefined) throw new Error(`${wanted} is not a JERRY project (see "jerry project list")`);
  console.log(mark('repository', `JERRY will stop monitoring ${project.repoRoot}. Its data stays (see "jerry data forget").`));
  if (project.openTasks > 0) console.log(flag(`${project.openTasks} open task(s) stay open, but nothing checks edits against their plans until you add the project again.`));
  if (!(await confirmDecision({ question: `Remove ${project.repoRoot} from JERRY's projects?`, typedPrompt: `Type the repository path to remove it (${project.repoRoot})`, matches: (typed) => samePath(typed, project.repoRoot) }))) return;
  const result = projectRemoveResultSchema.parse(await callCore('POST', '/api/v1/projects/remove', { path: project.repoRoot }));
  console.log(mark('paused', `Removed ${result.repoRoot}; only hard rules apply there now.`));
  if (result.warning !== null) console.log(flag(result.warning));
}

export async function listProjects(options: { json: boolean } = { json: false }): Promise<void> {
  const projects = z.array(projectSummarySchema).parse(await callCore('GET', '/api/v1/projects'));
  if (options.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  if (projects.length === 0) {
    console.log(mark('info', 'No projects yet. JERRY monitors only the repositories you add: run "jerry project add" in one. Hard rules apply everywhere.'));
    return;
  }
  for (const project of projects) {
    const activity = project.lastActivityAt === null ? 'no activity yet' : `last activity ${project.lastActivityAt.slice(0, 16).replace('T', ' ')} UTC`;
    const line = `${project.repoRoot}  ${project.openTasks} open task(s) of ${project.tasks} · ${activity} · added ${project.addedAt.slice(0, 10)} (${project.addedBy})`;
    console.log(project.exists ? mark('repository', line) : flag(`${line} · the directory no longer exists`));
  }
}
