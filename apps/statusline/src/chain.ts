import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Runs the status line the user had before JERRY's, with the same input, so turning JERRY's on
 * takes nothing away. Bounded: a slow or hanging command is cut off and shows nothing.
 */

/** Set for the chained command, so a status line that points back at JERRY's cannot recurse. */
export const CHAINED_ENV = 'JERRY_STATUSLINE_CHAINED';
const MAX_OUTPUT_BYTES = 64 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * On Windows Claude Code runs status-line commands through Git Bash; JERRY does the same when it
 * finds it, else the command goes through cmd.exe. Elsewhere through /bin/sh.
 */
export function windowsGitBash(env: Env, exists: (file: string) => boolean = fs.existsSync): string | null {
  const configured = env['CLAUDE_CODE_GIT_BASH_PATH'];
  const candidates = [
    ...(configured !== undefined && configured !== '' ? [configured] : []),
    ...[env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)']].flatMap((root) => (root === undefined || root === '' ? [] : [path.join(root, 'Git', 'bin', 'bash.exe')])),
    ...(env['LOCALAPPDATA'] === undefined ? [] : [path.join(env['LOCALAPPDATA'], 'Programs', 'Git', 'bin', 'bash.exe')]),
  ];
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** The previous command's output (trailing whitespace trimmed), or "" when it could not start, timed out or printed nothing. */
export function runChained(command: string, input: string, timeoutMs: number, env: Env = process.env): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const childEnv = { ...env, [CHAINED_ENV]: '1' };
    const bash = process.platform === 'win32' ? windowsGitBash(env) : null;
    let child: ReturnType<typeof spawn>;
    try {
      child =
        bash === null
          ? spawn(command, { shell: true, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
          : spawn(bash, ['-c', command], { env: childEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      settle('');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString('utf8');
    });
    child.on('error', () => settle(''));
    child.on('close', () => settle(output.slice(0, MAX_OUTPUT_BYTES).trimEnd()));
    child.stdin?.on('error', () => {
      // The command may exit without reading its input.
    });
    child.stdin?.end(input);
  });
}
