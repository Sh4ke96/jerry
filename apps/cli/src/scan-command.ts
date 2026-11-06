import fs from 'node:fs';
import path from 'node:path';
import { projectProfileSchema, workspaceGraphSchema, type ProjectProfile } from '@jerry/contracts';
import { scanRepository } from '@jerry/discovery';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';

/** Nearest ancestor containing ".git" (directory or file), like Core's resolver. */
function gitRootOf(target: string): string | null {
  let current = path.resolve(target);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `jerry repo profile`: the profile Core keeps for the repository (ADR 0020), rescanned when stale
 * (or always with --refresh). Commands are shown as they run on this machine.
 */
export async function profileCommand(target: string, options: { refresh: boolean; json: boolean }): Promise<void> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const params = new URLSearchParams({ path: path.resolve(target), refresh: options.refresh ? 'force' : 'auto' });
  const profile = projectProfileSchema.parse(await requestCore(info, { method: 'GET', path: `/api/v1/repositories/profile?${params.toString()}`, timeoutMs: 60_000 }));
  if (options.json) {
    console.log(JSON.stringify(profile, null, 2));
    return;
  }
  console.log(`Profile of ${profile.repoRoot}: scanned ${profile.scannedAt}${profile.stale.length === 0 ? '' : ` (stale: ${profile.stale.join(', ')})`}`);
  // Commands as they run on this machine (e.g. through corepack).
  printScan({ ...profile, root: profile.repoRoot, commands: profile.commands.map((command) => ({ kind: command.kind, command: command.run, source: command.source })) });
  if (profile.environment.notes.length > 0 || profile.environment.missingRunners.length > 0) {
    console.log(`  environment: ${[...profile.environment.notes, ...profile.environment.missingRunners.map((runner) => `${runner} is not installed`)].join('; ')}`);
  }
}

/** `jerry repo graph`: links between the repositories JERRY has profiles for (ADR 0021). */
export async function graphCommand(options: { json: boolean }): Promise<void> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const graph = workspaceGraphSchema.parse(await requestCore(info, { method: 'GET', path: '/api/v1/workspace/graph', timeoutMs: 10_000 }));
  if (options.json) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }
  console.log(`${graph.nodes.length} repositor${graph.nodes.length === 1 ? 'y' : 'ies'} with a profile, ${graph.edges.length} link(s)`);
  for (const edge of graph.edges) console.log(`  ${edge.from}\n    → ${edge.to}  [${edge.kind}]  ${edge.evidence}`);
  if (graph.edges.length === 0) console.log('  No links found. Repositories appear here once a Claude Code session started in them or they were scanned (jerry repo profile <path>).');
}

/**
 * `jerry repo scan`: what JERRY's scanner sees in a repository (ADR 0018). Read-only: it lists
 * files and reads a few manifests; it runs nothing and writes nothing.
 */
export function scanCommand(target: string, options: { json: boolean }): void {
  const root = gitRootOf(target) ?? path.resolve(target);
  const scan = scanRepository(root);
  if (options.json) {
    console.log(JSON.stringify(scan, null, 2));
    return;
  }
  printScan(scan);
}

/** What both a fresh scan and a stored profile can show. */
type ScanView = Omit<ProjectProfile, 'formatVersion' | 'repoRoot' | 'checkedAt' | 'stale' | 'environment' | 'commands'> & {
  root: string;
  commands: Array<{ kind: string; command: string; source: string }>;
};

function printScan(scan: ScanView): void {
  const list = (items: readonly string[]): string => (items.length === 0 ? 'none found' : items.join(', '));
  console.log(`${scan.root}  (${scan.files} file(s)${scan.truncated ? ', walk stopped at a limit' : ''})`);
  console.log(`  languages:   ${list(scan.languages.slice(0, 8).map((language) => `${language.name} ${language.files}`))}`);
  console.log(`  manifests:   ${list(scan.manifests.map((manifest) => `${manifest.path}${manifest.lockfile === null ? '' : ` + ${manifest.lockfile}`}`))}`);
  console.log(`  package mgr: ${scan.packageManager ?? 'none'}`);
  console.log(`  frameworks:  ${list(scan.frameworks.map((framework) => framework.name))}`);
  console.log('  commands:');
  if (scan.commands.length === 0) console.log('    none found');
  for (const command of scan.commands) console.log(`    ${command.kind.padEnd(9)} ${command.command}   (${command.source})`);
  console.log(`  CI:          ${list(scan.ci.map((entry) => `${entry.path} (${entry.kind})`))}`);
  console.log(`  containers:  ${list(scan.containers.map((entry) => entry.path))}`);
  console.log(`  API schemas: ${list(scan.apiSchemas.map((entry) => `${entry.path} (${entry.kind})`))}`);
  console.log(`  migrations:  ${list(scan.migrations.map((entry) => `${entry.path} (${entry.kind}, ${entry.files})`))}`);
  console.log(`  docs:        ${scan.docs.length === 0 ? 'none found' : `${scan.docs.length} (${[...new Set(scan.docs.map((doc) => doc.kind))].join(', ')})`}`);
  console.log('  project instructions (read-only; rules rank below JERRY and you):');
  if (scan.instructions.length === 0) console.log('    none found');
  for (const entry of scan.instructions) console.log(`    ${entry.role.padEnd(6)} ${entry.path}${entry.notes.length === 0 ? '' : `  (${entry.notes.join('; ')})`}`);
  const { findings, scannedFiles, complete } = scan.injection;
  console.log(`  suspicious instructions in repository text (${scannedFiles} file(s) read${complete ? '' : ', scan stopped at a limit'}):`);
  if (findings.length === 0) console.log('    none found');
  for (const finding of findings) console.log(`    ${finding.path}:${finding.line}  [${finding.rule}]  ${finding.excerpt}`);
  if (scan.skippedDirectories.length > 0) console.log(`  not scanned: ${scan.skippedDirectories.slice(0, 10).join(', ')}${scan.skippedDirectories.length > 10 ? ', …' : ''}`);
}
