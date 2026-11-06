import path from 'node:path';
import readline from 'node:readline/promises';
import { repositoryExclusionSchema } from '@jerry/contracts';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import { z } from 'zod';
import { mark } from './emoji.js';

const exclusionResultSchema = z.object({ repoRoot: z.string(), excluded: z.boolean() });

async function callCore(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  return requestCore(info, { method, path: apiPath, timeoutMs: 5000, ...(body === undefined ? {} : { body }) });
}

/**
 * Turning monitoring off weakens oversight, so, like approvals, it needs an interactive terminal
 * and a typed confirmation. Hard rules (no Git changes, no JERRY tampering) keep applying.
 */
export async function excludeRepository(repo: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Excluding a repository requires an interactive terminal (PowerShell or the VS Code terminal).');
  }
  const repoPath = path.resolve(repo);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await prompt.question(`JERRY will stop monitoring the repository containing ${repoPath}.\nGit and JERRY-protection rules stay enforced. Type "exclude" to confirm: `)).trim();
  prompt.close();
  if (typed !== 'exclude') {
    console.log(mark('fail', 'Confirmation did not match. Nothing changed.'));
    process.exitCode = 1;
    return;
  }
  const result = exclusionResultSchema.parse(await callCore('POST', '/api/v1/repositories/exclusions', { repoPath, excluded: true }));
  console.log(mark('paused', `Excluded ${result.repoRoot} from monitoring.`));
}

export async function includeRepository(repo: string): Promise<void> {
  const result = exclusionResultSchema.parse(await callCore('POST', '/api/v1/repositories/exclusions', { repoPath: path.resolve(repo), excluded: false }));
  console.log(mark('pass', `JERRY monitors ${result.repoRoot} again.`));
}

export async function listExcludedRepositories(): Promise<void> {
  const exclusions = z.array(repositoryExclusionSchema).parse(await callCore('GET', '/api/v1/repositories/exclusions'));
  if (exclusions.length === 0) {
    console.log(mark('pass', 'No excluded repositories. JERRY monitors every Git repository.'));
    return;
  }
  for (const exclusion of exclusions) {
    console.log(mark('repository', `${exclusion.repoRoot}  (excluded ${exclusion.excludedAt})`));
  }
}
