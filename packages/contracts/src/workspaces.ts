import { z } from 'zod';

/**
 * Workspaces: several repositories under one name the user chose (like a VS Code workspace with
 * several folders, but kept by JERRY). A grouping only: each repository stays its own project with
 * its own tasks, plans and checks. Creating a workspace adds its repositories as projects; removing
 * a repository from it or deleting it keeps the projects. Every change is the user's: the CLI asks
 * in a terminal, the dashboard needs CSRF and the confirmation the Settings option asks for.
 */

export const WORKSPACE_NAME_MAX = 60;
/** Letters, digits, spaces and . _ - ; no path or control characters. */
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(WORKSPACE_NAME_MAX)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, 'a workspace name has letters, digits, spaces, dots, dashes and underscores');

/** One repository of a workspace, with what waits in it. */
export const workspaceRepoSchema = z.object({
  repoRoot: z.string(),
  /** JERRY monitors it (a workspace adds its repositories as projects; one may have been removed since). */
  project: z.boolean(),
  /** The folder is still a Git repository on this computer. */
  present: z.boolean(),
  openTasks: z.number().int().nonnegative(),
  /** Open tasks whose next step is the user's decision. */
  waiting: z.number().int().nonnegative(),
  /**
   * The IDs behind those counts: a task across several repositories of the workspace counts in each,
   * so totals over a workspace count distinct IDs. Empty from an older Core.
   */
  openTaskIds: z.array(z.string()).default([]),
  waitingTaskIds: z.array(z.string()).default([]),
});
export type WorkspaceRepo = z.infer<typeof workspaceRepoSchema>;

export const workspaceSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  repos: z.array(workspaceRepoSchema),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** A Git repository found under a folder, for the New workspace dialog. */
export const workspaceScanEntrySchema = z.object({
  repoRoot: z.string(),
  project: z.boolean(),
  /** The workspace it already belongs to; null when none. */
  workspace: z.string().nullable(),
});
export const workspaceScanSchema = z.object({
  folder: z.string(),
  repos: z.array(workspaceScanEntrySchema),
  /** The scan stopped at its limit; some repositories may be missing. */
  truncated: z.boolean(),
});
export type WorkspaceScan = z.infer<typeof workspaceScanSchema>;

const confirmation = z.string().max(300).optional();
const paths = z.array(z.string().trim().min(1).max(1000)).min(1).max(50);

/** POST /api/v1/workspaces. */
export const workspaceCreateRequestSchema = z.object({ name: workspaceNameSchema, paths, confirmation });
/** POST …/workspaces/:id/repos and …/repos/remove. */
export const workspaceRepoRequestSchema = z.object({ path: z.string().trim().min(1).max(1000), confirmation });
/** POST …/workspaces/:id/rename. */
export const workspaceRenameRequestSchema = z.object({ name: workspaceNameSchema, confirmation });
/** POST …/workspaces/:id/delete. */
export const workspaceDeleteRequestSchema = z.object({ confirmation });
/** POST /api/v1/workspaces/scan. */
export const workspaceScanRequestSchema = z.object({ folder: z.string().trim().min(1).max(1000) });

/** What a change did: the workspace after it (null after delete) and the repositories it made projects. */
export const workspaceChangeResultSchema = z.object({
  workspace: workspaceSchema.nullable(),
  addedProjects: z.array(z.string()),
});
export type WorkspaceChangeResult = z.infer<typeof workspaceChangeResultSchema>;

/** The workspace of a repository in its state: its name and the other repositories, with what waits there. */
export const repositoryWorkspaceSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  repos: z.array(workspaceRepoSchema),
});
export type RepositoryWorkspace = z.infer<typeof repositoryWorkspaceSchema>;
