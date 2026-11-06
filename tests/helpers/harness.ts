import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreRuntimeInfoSchema, type CoreRuntimeInfo } from '@jerry/contracts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BRIDGE = path.join(ROOT, 'dist', 'plugin', 'hooks', 'bridge.mjs');
export const CORE = path.join(ROOT, 'dist', 'core', 'core.mjs');

export function tempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `jerry-${prefix}-`)));
}

export interface RunningCore {
  home: string;
  info: CoreRuntimeInfo;
  process: ChildProcess;
  stop(): Promise<void>;
}

export async function startCore(home: string): Promise<RunningCore> {
  const child = spawn(process.execPath, [CORE], { env: { ...process.env, JERRY_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const coreFile = path.join(home, 'run', 'core.json');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(coreFile)) {
      const info = coreRuntimeInfoSchema.parse(JSON.parse(fs.readFileSync(coreFile, 'utf8')));
      if (info.pid === child.pid) {
        return {
          home,
          info,
          process: child,
          stop: () =>
            new Promise<void>((resolve) => {
              // A killed process reports signalCode, not exitCode.
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once('exit', () => resolve());
              child.kill();
            }),
        };
      }
    }
    if (child.exitCode !== null) throw new Error(`Core exited early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Core did not start: ${output}`);
}

export async function api(core: RunningCore, method: 'GET' | 'POST', apiPath: string, body?: unknown, token = core.info.token): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: core.info.port,
        method,
        path: apiPath,
        headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString()));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) }));
      },
    );
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

export interface BridgeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runBridge(event: 'pre-tool-use' | 'session-start', input: unknown, env: Record<string, string>): BridgeResult {
  const started = performance.now();
  const result = spawnSync(process.execPath, [BRIDGE, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, durationMs: performance.now() - started };
}

export function preToolUse(cwd: string, toolName: string, toolInput: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: 'test-session',
    transcript_path: 'C:/nowhere/transcript.jsonl',
    cwd,
    hook_event_name: 'PreToolUse',
    permission_mode: 'acceptEdits',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_test',
  };
}

const GIT_IDENTITY = ['-c', 'user.name=JERRY Test', '-c', 'user.email=jerry-test@example.invalid', '-c', 'commit.gpgsign=false'];

/** A small Git repository with history and a deliberately dirty working tree (user's uncommitted work). */
export function createFixtureRepo(dir: string): string {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n');
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const answer = 42;\n');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', [...GIT_IDENTITY, '-C', dir, 'add', '.']);
  execFileSync('git', [...GIT_IDENTITY, '-C', dir, 'commit', '-q', '-m', 'initial']);
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const answer = 43; // user change, uncommitted\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked user file\n');
  return dir;
}

/**
 * Everything that would reveal a footprint: every file (including .git internals) with its
 * hash, plus git status. Two equal snapshots mean the repository was not touched.
 */
export function snapshotRepo(dir: string): { files: Record<string, string>; status: string } {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        files[`${relative}/`] = 'dir';
        walk(full);
      } else {
        files[relative] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  // --no-optional-locks keeps `git status` itself from refreshing .git/index.
  const status = execFileSync('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v2', '--branch'], { encoding: 'utf8' });
  return { files, status };
}
