import fs from 'node:fs';
import path from 'node:path';
import { scanRepository, type RepositoryScanResult } from '@jerry/discovery';

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

function printScan(scan: RepositoryScanResult): void {
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
