import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Env } from './jerry-home.js';

export interface ClaudeBinary {
  path: string;
  source: 'JERRY_CLAUDE_BIN' | 'PATH' | 'native-installer' | 'vscode-extension';
}

/**
 * Locates the official Claude Code CLI. On Windows the VS Code extension ships its own
 * claude.exe, which is often the only copy on the machine and is not on PATH.
 */
export function findClaudeBinary(env: Env = process.env, platform: NodeJS.Platform = process.platform): ClaudeBinary | null {
  const explicit = env['JERRY_CLAUDE_BIN'];
  if (explicit !== undefined && explicit.trim() !== '') {
    return isFile(explicit) ? { path: path.resolve(explicit), source: 'JERRY_CLAUDE_BIN' } : null;
  }

  const exeName = platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, exeName);
    if (isFile(candidate)) return { path: candidate, source: 'PATH' };
  }

  const home = os.homedir();
  const nativeInstaller = path.join(home, '.local', 'bin', exeName);
  if (isFile(nativeInstaller)) return { path: nativeInstaller, source: 'native-installer' };

  const extensionsDir = path.join(home, '.vscode', 'extensions');
  const extensionBinaries = safeReadDir(extensionsDir)
    .filter((name) => name.startsWith('anthropic.claude-code-'))
    .map((name) => ({ name, version: parseExtensionVersion(name) }))
    .filter((entry): entry is { name: string; version: number[] } => entry.version !== null)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((entry) => path.join(extensionsDir, entry.name, 'resources', 'native-binary', exeName))
    .filter(isFile);
  const newest = extensionBinaries[0];
  return newest === undefined ? null : { path: newest, source: 'vscode-extension' };
}

function parseExtensionVersion(directoryName: string): number[] | null {
  const match = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/.exec(directoryName);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
