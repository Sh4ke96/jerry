import { addProject, listProjects, removeProject } from './project-commands.js';

/**
 * The former exclusion commands, kept as synonyms: JERRY monitors only the projects the user adds,
 * so including a repository adds it as a project and excluding it removes the project. Both ask in
 * an interactive terminal like "jerry project add|remove".
 */

export function excludeRepository(repo: string): Promise<void> {
  return removeProject(repo);
}

export function includeRepository(repo: string): Promise<void> {
  return addProject(repo);
}

export function listRepositories(): Promise<void> {
  return listProjects();
}
