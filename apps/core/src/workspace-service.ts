import fs from 'node:fs';
import path from 'node:path';
import type { RepositoryWorkspace, Workspace, WorkspaceChangeResult, WorkspaceRepo, WorkspaceScan } from '@jerry/contracts';
import type { JerrySchema } from '@jerry/database';
import { comparablePath, isComparableInside, taskTouchesRepo } from '@jerry/policy-engine';
import { isTerminal } from '@jerry/workflow';
import type { Kysely } from 'kysely';
import type { StateStore } from './state-store.js';

/**
 * Workspaces: several repositories under one name the user chose. A grouping only: every
 * repository stays its own project with its own tasks, plans and checks. Creating a workspace adds
 * its repositories as projects; removing a repository from it, or deleting it, keeps the projects.
 * A repository belongs to at most one workspace. The common parent folder of a workspace's
 * repositories counts as the workspace for a session started there.
 */

export type WorkspaceChannel = 'cli' | 'dashboard';

export class WorkspaceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkspaceServiceOptions {
  db: Kysely<JerrySchema>;
  store: StateStore;
  /** The Git working tree root containing a path, or null. */
  findGitRoot: (target: string) => string | null;
  /** Resolves links of the nearest existing ancestor. */
  realPath: (target: string) => string;
  /** Throws when a repository may not be a project (e.g. inside JERRY's data). */
  checkProjectRoot: (repoRoot: string) => string;
}

/** Folders a scan never enters. */
const SKIPPED = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'bin', 'obj']);
/** Folders a scan looks at, at most. */
const MAX_SCANNED = 400;
/** Repositories a scan returns, at most. */
const MAX_FOUND = 200;
/** States in which a task waits for the user's decision. */
const WAITING: ReadonlySet<string> = new Set(['WAIT_PLAN_APPROVAL', 'WAIT_IMPLEMENTATION_ACCEPTANCE', 'WAIT_REVIEW_FIX_APPROVAL', 'FINAL_REPORT']);

const keyOf = (target: string): string => comparablePath(target, target, process.platform);
const nameKey = (name: string): string => name.trim().toLowerCase();

interface Row {
  id: number;
  name: string;
  createdAt: string;
  repos: string[];
}

export class WorkspaceService {
  private rows: Row[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkspaceServiceOptions) {}

  /** One change at a time. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Reads the workspaces from the database and tells the store which parent folders count. */
  async reload(): Promise<void> {
    const workspaces = await this.options.db.selectFrom('workspaces').selectAll().orderBy('name_key').execute();
    const repos = await this.options.db.selectFrom('workspace_repos').selectAll().orderBy('repo_key').execute();
    this.rows = workspaces.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at, repos: repos.filter((repo) => repo.workspace_id === row.id).map((repo) => repo.repo_root) }));
    this.options.store.setWorkspaceFolders(this.rows.map((row) => commonParent(row.repos)).filter((folder): folder is string => folder !== null));
  }

  private repoOf(repoRoot: string): WorkspaceRepo {
    // Its own tasks and multi-repository tasks that cover it.
    const tasks = this.options.store.snapshot().tasks.filter((task) => taskTouchesRepo(task, repoRoot, process.platform) && !isTerminal(task.state));
    return {
      repoRoot,
      project: this.options.store.projects().some((project) => keyOf(project.repoRoot) === keyOf(repoRoot)),
      present: fs.existsSync(path.join(repoRoot, '.git')),
      openTasks: tasks.length,
      waiting: tasks.filter((task) => WAITING.has(task.state)).length,
      openTaskIds: tasks.map((task) => task.taskId),
      waitingTaskIds: tasks.filter((task) => WAITING.has(task.state)).map((task) => task.taskId),
    };
  }

  private view(row: Row): Workspace {
    return { id: row.id, name: row.name, createdAt: row.createdAt, repos: row.repos.map((repo) => this.repoOf(repo)) };
  }

  list(): Workspace[] {
    return this.rows.map((row) => this.view(row));
  }

  get(id: number): Workspace {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined) throw new WorkspaceError(404, `There is no workspace ${id}.`);
    return this.view(row);
  }

  /**
   * The workspace of a path: the one with the repository that contains it, or, for a folder outside
   * any repository, the one whose repositories all lie under it (a session in their common parent).
   */
  workspaceOf(target: string): RepositoryWorkspace | null {
    const key = keyOf(this.options.realPath(path.resolve(target)));
    const byRepo = this.rows.find((row) => row.repos.some((repo) => isComparableInside(key, keyOf(repo))));
    // A folder outside the repositories: the common parent itself (or a folder below it that still holds them all).
    const inParent = (candidate: Row): boolean => {
      const parent = commonParent(candidate.repos);
      return parent !== null && isComparableInside(key, keyOf(parent)) && candidate.repos.every((repo) => isComparableInside(keyOf(repo), key));
    };
    const row = byRepo ?? this.rows.find(inParent);
    return row === undefined ? null : { id: row.id, name: row.name, repos: row.repos.map((repo) => this.repoOf(repo)) };
  }

  /**
   * The workspace whose parent folder this is: a folder outside every repository that holds all of
   * the workspace's repositories. Null inside a repository and elsewhere.
   */
  parentFolderOf(target: string): { name: string; repoRoots: string[] } | null {
    if (this.options.findGitRoot(this.options.realPath(path.resolve(target))) !== null) return null;
    const workspace = this.workspaceOf(target);
    return workspace === null ? null : { name: workspace.name, repoRoots: workspace.repos.map((repo) => repo.repoRoot) };
  }

  /** The Git repositories in a folder and up to two levels below it (not inside other repositories). */
  scan(folder: string): WorkspaceScan {
    const root = path.resolve(folder);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new WorkspaceError(400, `${folder} is not a folder.`);
    const found: string[] = [];
    let visited = 0;
    let truncated = false;
    const walk = (dir: string, depth: number): void => {
      if (truncated) return;
      if (visited++ >= MAX_SCANNED || found.length >= MAX_FOUND) {
        truncated = true;
        return;
      }
      if (fs.existsSync(path.join(dir, '.git'))) {
        found.push(dir);
        return;
      }
      if (depth >= 2) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED.has(entry.name.toLowerCase())) continue;
        walk(path.join(dir, entry.name), depth + 1);
      }
    };
    walk(root, 0);
    return {
      folder: root,
      repos: found.map((repoRoot) => ({
        repoRoot,
        project: this.options.store.projects().some((project) => keyOf(project.repoRoot) === keyOf(repoRoot)),
        workspace: this.rows.find((row) => row.repos.some((repo) => keyOf(repo) === keyOf(repoRoot)))?.name ?? null,
      })),
      truncated,
    };
  }

  /** A path as a repository root: it must exist and be the root of a Git repository. */
  repositoryRoot(target: string): string {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) throw new WorkspaceError(400, `${target} does not exist.`);
    const real = this.options.realPath(resolved);
    const root = this.options.findGitRoot(real);
    if (root === null) throw new WorkspaceError(400, `${target} is not a Git repository; a workspace holds Git repositories.`);
    if (keyOf(root) !== keyOf(real)) throw new WorkspaceError(400, `${target} is inside the Git repository ${root}; give the repository root.`);
    return this.options.checkProjectRoot(root);
  }

  private nameTaken(name: string, except: number | null): boolean {
    return this.rows.some((row) => row.id !== except && nameKey(row.name) === nameKey(name));
  }

  private ownerOf(repoRoot: string): Row | undefined {
    return this.rows.find((row) => row.repos.some((repo) => keyOf(repo) === keyOf(repoRoot)));
  }

  /** Adds the repositories that are not projects yet as projects; returns the ones it added. */
  private async addProjects(roots: readonly string[], channel: WorkspaceChannel, now: Date, workspace: string): Promise<string[]> {
    const added: string[] = [];
    for (const root of roots) {
      const result = await this.options.store.addProject(root, now, channel, `added with workspace ${workspace}`);
      if (result.added) added.push(result.project.repoRoot);
    }
    return added;
  }

  async create(name: string, paths: readonly string[], channel: WorkspaceChannel, now: Date = new Date()): Promise<WorkspaceChangeResult> {
    return this.exclusive(async () => {
      if (this.nameTaken(name, null)) throw new WorkspaceError(409, `There is already a workspace named ${name}.`);
      const roots = uniqueRoots(paths.map((target) => this.repositoryRoot(target)));
      for (const root of roots) {
        const owner = this.ownerOf(root);
        if (owner !== undefined) throw new WorkspaceError(409, `${root} is already in the workspace ${owner.name}; a repository belongs to one workspace.`);
      }
      const at = now.toISOString();
      const { id } = await this.options.db.insertInto('workspaces').values({ name: name.trim(), name_key: nameKey(name), created_at: at, created_by: channel }).returning('id').executeTakeFirstOrThrow();
      for (const root of roots) await this.options.db.insertInto('workspace_repos').values({ workspace_id: id, repo_root: root, repo_key: keyOf(root), added_at: at }).execute();
      const addedProjects = await this.addProjects(roots, channel, now, name.trim());
      await this.reload();
      return { workspace: this.get(id), addedProjects };
    });
  }

  async addRepo(id: number, target: string, channel: WorkspaceChannel, now: Date = new Date()): Promise<WorkspaceChangeResult> {
    return this.exclusive(async () => {
      const workspace = this.get(id);
      const root = this.repositoryRoot(target);
      const owner = this.ownerOf(root);
      if (owner !== undefined) {
        if (owner.id === id) return { workspace, addedProjects: [] };
        throw new WorkspaceError(409, `${root} is already in the workspace ${owner.name}; a repository belongs to one workspace.`);
      }
      await this.options.db.insertInto('workspace_repos').values({ workspace_id: id, repo_root: root, repo_key: keyOf(root), added_at: now.toISOString() }).execute();
      const addedProjects = await this.addProjects([root], channel, now, workspace.name);
      await this.reload();
      return { workspace: this.get(id), addedProjects };
    });
  }

  /** Takes a repository out of the workspace; it stays a project. */
  async removeRepo(id: number, target: string): Promise<WorkspaceChangeResult> {
    return this.exclusive(async () => {
      this.get(id);
      const key = keyOf(path.resolve(target));
      const result = await this.options.db.deleteFrom('workspace_repos').where('workspace_id', '=', id).where('repo_key', '=', key).executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) throw new WorkspaceError(404, `${target} is not in this workspace.`);
      await this.reload();
      return { workspace: this.get(id), addedProjects: [] };
    });
  }

  async rename(id: number, name: string): Promise<WorkspaceChangeResult> {
    return this.exclusive(async () => {
      this.get(id);
      if (this.nameTaken(name, id)) throw new WorkspaceError(409, `There is already a workspace named ${name}.`);
      await this.options.db.updateTable('workspaces').set({ name: name.trim(), name_key: nameKey(name) }).where('id', '=', id).execute();
      await this.reload();
      return { workspace: this.get(id), addedProjects: [] };
    });
  }

  /** Deletes the workspace only: its repositories stay projects. */
  async delete(id: number): Promise<WorkspaceChangeResult> {
    return this.exclusive(async () => {
      this.get(id);
      await this.options.db.deleteFrom('workspace_repos').where('workspace_id', '=', id).execute();
      await this.options.db.deleteFrom('workspaces').where('id', '=', id).execute();
      await this.reload();
      return { workspace: null, addedProjects: [] };
    });
  }
}

function uniqueRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = keyOf(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The deepest folder containing every repository (null without repositories or across drives). */
export function commonParent(repos: readonly string[]): string | null {
  if (repos.length === 0) return null;
  const split = (repo: string): string[] => path.resolve(repo).split(/[\\/]+/);
  let common = split(path.dirname(path.resolve(repos[0]!)));
  for (const repo of repos.slice(1)) {
    const parts = split(path.dirname(path.resolve(repo)));
    let length = 0;
    while (length < common.length && length < parts.length && (process.platform === 'win32' ? common[length]!.toLowerCase() === parts[length]!.toLowerCase() : common[length] === parts[length])) length += 1;
    common = common.slice(0, length);
  }
  // Only a drive (or "/") in common: no folder to speak of.
  if (common.length <= 1) return null;
  return common.join(path.sep);
}
