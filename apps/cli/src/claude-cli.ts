import { spawnSync } from 'node:child_process';
import { findClaudeBinary, type ClaudeBinary } from '@jerry/platform';

export const MARKETPLACE_NAME = 'jerry-local';
export const PLUGIN_NAME = 'jerry';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

export interface InstalledPlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
  readFromFolder?: string;
}

export interface ClaudeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function requireClaudeBinary(): ClaudeBinary {
  const binary = findClaudeBinary();
  if (binary === null) {
    throw new Error(
      'Claude Code CLI not found (checked JERRY_CLAUDE_BIN, PATH, ~/.local/bin and the VS Code extension). Install Claude Code or set JERRY_CLAUDE_BIN.',
    );
  }
  return binary;
}

/** Runs the official Claude Code CLI. All Claude settings changes go through it, never through direct file edits. */
export function runClaude(binary: ClaudeBinary, args: readonly string[]): ClaudeRunResult {
  const result = spawnSync(binary.path, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (result.error !== undefined) {
    throw new Error(`Failed to run ${binary.path} ${args.join(' ')}: ${result.error.message}`);
  }
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function runClaudeOrThrow(binary: ClaudeBinary, args: readonly string[]): ClaudeRunResult {
  const result = runClaude(binary, args);
  if (result.exitCode !== 0) {
    throw new Error(`claude ${args.join(' ')} failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function claudeVersion(binary: ClaudeBinary): string {
  return runClaudeOrThrow(binary, ['--version']).stdout.trim();
}

export function listInstalledPlugins(binary: ClaudeBinary): InstalledPlugin[] {
  const output = runClaudeOrThrow(binary, ['plugin', 'list', '--json']).stdout;
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('claude plugin list --json did not return an array');
  return parsed.filter((entry): entry is InstalledPlugin => typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string');
}

export function listMarketplaceNames(binary: ClaudeBinary): string[] {
  const output = runClaudeOrThrow(binary, ['plugin', 'marketplace', 'list', '--json']).stdout;
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('claude plugin marketplace list --json did not return an array');
  return parsed
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string');
}
