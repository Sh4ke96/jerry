import path from 'node:path';
import { workspaceChangeResultSchema, workspaceScanSchema, workspaceSchema, type Workspace, type WorkspaceChangeResult } from '@jerry/contracts';
import { z } from 'zod';
import { flag, mark } from './emoji.js';
import { confirmDecision } from './settings-commands.js';
import { callCore, requireTerminal } from './terminal.js';

/**
 * `jerry workspace`: several repositories under one name. Listing and showing are read-only.
 * Creating, adding, removing, renaming and deleting are the user's decisions: an interactive terminal
 * and the confirmation the Settings option asks for (the workspace's name typed, or y/N). Agents are
 * blocked from these commands by JERRY's hard rules. A workspace is a grouping: each repository
 * stays its own project; deleting a workspace or removing a repository from it keeps the projects.
 */

async function workspaces(): Promise<Workspace[]> {
  return z.array(workspaceSchema).parse(await callCore('GET', '/api/v1/workspaces'));
}

async function byName(name: string): Promise<Workspace> {
  const found = (await workspaces()).find((workspace) => workspace.name.toLowerCase() === name.trim().toLowerCase());
  if (found === undefined) throw new Error(`There is no workspace named ${name} (see "jerry workspace list").`);
  return found;
}

function printWorkspace(workspace: Workspace): void {
  const waiting = workspace.repos.reduce((sum, repo) => sum + repo.waiting, 0);
  console.log(mark('repository', `${workspace.name}: ${workspace.repos.length} repositor${workspace.repos.length === 1 ? 'y' : 'ies'}${waiting > 0 ? `, ${waiting} decision(s) waiting for you` : ''}`));
  for (const repo of workspace.repos) {
    const notes = [repo.project ? null : 'not monitored', repo.present ? null : 'folder missing'].filter((note) => note !== null);
    console.log(`  ${repo.repoRoot.padEnd(48)} ${String(repo.openTasks).padStart(2)} open task(s)${repo.waiting > 0 ? `, ${repo.waiting} waiting` : ''}${notes.length === 0 ? '' : `  (${notes.join(', ')})`}`);
  }
}

function printChange(result: WorkspaceChangeResult, done: string): void {
  console.log(mark('pass', done));
  if (result.addedProjects.length > 0) console.log(mark('info', `Now JERRY projects: ${result.addedProjects.join(', ')}`));
  if (result.workspace !== null) printWorkspace(result.workspace);
}

export async function listWorkspaces(options: { json: boolean }): Promise<void> {
  const list = await workspaces();
  if (options.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log(mark('info', 'No workspaces yet. Create one with "jerry workspace create <name> <folder>..." or --scan <parent folder>.'));
    return;
  }
  for (const workspace of list) printWorkspace(workspace);
}

export async function showWorkspace(name: string, options: { json: boolean }): Promise<void> {
  const workspace = await byName(name);
  if (options.json) console.log(JSON.stringify(workspace, null, 2));
  else printWorkspace(workspace);
}

export async function createWorkspace(name: string, folders: readonly string[], options: { scan?: string }): Promise<void> {
  requireTerminal('Creating a workspace');
  const paths = folders.map((folder) => path.resolve(folder));
  if (options.scan !== undefined) {
    const scan = workspaceScanSchema.parse(await callCore('POST', '/api/v1/workspaces/scan', { folder: path.resolve(options.scan) }));
    for (const repo of scan.repos) {
      if (repo.workspace !== null) console.log(flag(`${repo.repoRoot} is already in the workspace ${repo.workspace}; left out.`));
      else paths.push(repo.repoRoot);
    }
    if (scan.truncated) console.log(flag('The folder is large; the scan stopped early, so some repositories may be missing. Add them with "jerry workspace add".'));
  }
  if (paths.length === 0) throw new Error('Give the repository folders, or --scan <folder> to find them.');
  console.log(mark('repository', `Workspace ${name} with ${paths.length} repositor${paths.length === 1 ? 'y' : 'ies'}:`));
  for (const repo of paths) console.log(`  ${repo}`);
  console.log('  Each becomes a JERRY project (if it is not one yet): JERRY monitors it from the next tool call.');
  if (!(await confirmDecision({ question: `Create the workspace ${name}?`, typedPrompt: `Type the workspace name to create it (${name})`, matches: (typed) => typed.trim().toLowerCase() === name.trim().toLowerCase() }))) return;
  printChange(workspaceChangeResultSchema.parse(await callCore('POST', '/api/v1/workspaces', { name, paths })), `Created ${name}.`);
}

/** Add, remove, rename or delete: each confirmed with the workspace's name. */
async function change(name: string, what: string, request: (workspace: Workspace) => [string, unknown]): Promise<void> {
  requireTerminal(what);
  const workspace = await byName(name);
  if (!(await confirmDecision({ question: `${what} (workspace ${workspace.name})?`, typedPrompt: `Type the workspace name to confirm (${workspace.name})`, matches: (typed) => typed.trim().toLowerCase() === workspace.name.toLowerCase() }))) return;
  const [apiPath, body] = request(workspace);
  printChange(workspaceChangeResultSchema.parse(await callCore('POST', apiPath, body)), `${what}: done.`);
}

export async function addToWorkspace(name: string, folder: string): Promise<void> {
  const repo = path.resolve(folder);
  await change(name, `Add ${repo}`, (workspace) => [`/api/v1/workspaces/${workspace.id}/repos`, { path: repo }]);
}

export async function removeFromWorkspace(name: string, folder: string): Promise<void> {
  const repo = path.resolve(folder);
  await change(name, `Remove ${repo} from the workspace (it stays a project)`, (workspace) => [`/api/v1/workspaces/${workspace.id}/repos/remove`, { path: repo }]);
}

export async function renameWorkspace(name: string, next: string): Promise<void> {
  await change(name, `Rename to ${next}`, (workspace) => [`/api/v1/workspaces/${workspace.id}/rename`, { name: next }]);
}

export async function deleteWorkspace(name: string): Promise<void> {
  await change(name, 'Delete the workspace (its repositories stay projects)', (workspace) => [`/api/v1/workspaces/${workspace.id}/delete`, {}]);
}
