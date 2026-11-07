import path from 'node:path';
import readline from 'node:readline/promises';
import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';

/**
 * Terminal helpers for the user's decisions about projects and data. Like approvals they need an
 * interactive terminal: Claude Code's shell tools have none, so an agent cannot complete them.
 */

export function requireTerminal(what: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${what} requires an interactive terminal (PowerShell or the VS Code terminal). In Git Bash/mintty run it via "winpty".`);
  }
}

/** Asks one question and returns the trimmed answer. */
export async function ask(question: string): Promise<string> {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}

/** A typed path matches the expected one in any case and with either separator on Windows. */
export function samePath(typed: string, expected: string): boolean {
  const key = (value: string): string => {
    const resolved = path.resolve(value.replace(/^["']|["']$/g, '')).replaceAll('\\', '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return typed !== '' && key(typed) === key(expected);
}

export async function callCore(method: 'GET' | 'POST', apiPath: string, body?: unknown, timeoutMs = 5000): Promise<unknown> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  return requestCore(info, { method, path: apiPath, timeoutMs, ...(body === undefined ? {} : { body }) });
}

/** 1536 -> "1.5 KiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
