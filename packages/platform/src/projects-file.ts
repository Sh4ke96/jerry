import fs from 'node:fs';
import { writeFileAtomic } from './fs-atomic.js';
import { jerryPaths } from './jerry-home.js';

/**
 * JERRY_HOME/run/projects.json: the roots of the projects the user added, written by Core after
 * every change and at start. The hook bridge reads it on every call to decide, without Core, whether
 * a path is monitored at all. Dependency-free: the bridge must stay small and fast.
 */
export const PROJECTS_FILE_VERSION = 1;

export interface ProjectsFile {
  version: typeof PROJECTS_FILE_VERSION;
  roots: string[];
}

export function writeProjectsFile(home: string, roots: readonly string[]): void {
  const content: ProjectsFile = { version: PROJECTS_FILE_VERSION, roots: [...roots] };
  writeFileAtomic(jerryPaths(home).projectsFile, `${JSON.stringify(content, null, 2)}\n`);
}

/**
 * The project roots, or null when the file is missing, unreadable or of an unknown shape: then
 * nobody can say which projects exist, and the caller behaves as if the file did not exist.
 */
export function readProjectsFile(home: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(jerryPaths(home).projectsFile, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { version, roots } = parsed as { version?: unknown; roots?: unknown };
  if (version !== PROJECTS_FILE_VERSION || !Array.isArray(roots)) return null;
  if (!roots.every((root): root is string => typeof root === 'string' && root.length > 0)) return null;
  return roots;
}
