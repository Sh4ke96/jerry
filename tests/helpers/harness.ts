import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreRuntimeInfoSchema, coreUserInfoSchema, type CoreRuntimeInfo } from '@jerry/contracts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BRIDGE = path.join(ROOT, 'dist', 'plugin', 'hooks', 'bridge.mjs');
export const CORE = path.join(ROOT, 'dist', 'core', 'core.mjs');

export function tempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `jerry-${prefix}-`)));
}

export interface RunningCore {
  home: string;
  /** run/core.json; its token is the agent token. */
  info: CoreRuntimeInfo;
  /** The agent token (run/core.json): what the hooks, the MCP server and the status line send. */
  agentToken: string;
  /** The user's token (run/core-user.json): what the jerry CLI and the desktop app send; api()'s default. */
  userToken: string;
  process: ChildProcess;
  stop(): Promise<void>;
}

/** run/core-user.json of the Core with this pid, or null while it is missing or another Core's. */
export function readUserToken(home: string, pid: number): string | null {
  try {
    const user = coreUserInfoSchema.parse(JSON.parse(fs.readFileSync(path.join(home, 'run', 'core-user.json'), 'utf8')));
    return user.pid === pid ? user.token : null;
  } catch {
    return null;
  }
}

/** Port 0 keeps test Cores away from the default port, which the user's real Core may hold. */
export const TEST_CORE_ENV = { JERRY_CORE_PORT: '0' } as const;

/** Fixture repositories created in this test file; test Cores add them as projects by default. */
const fixtureRepos: string[] = [];

export interface StartCoreOptions {
  /** Repositories to add as projects once Core runs (default: every fixture repository of this test file). */
  projects?: readonly string[];
}

/**
 * Starts a test Core. JERRY monitors only projects, so the fixture repositories created so far are
 * added as projects through the API, the way "jerry project add" does it; pass `projects: []` to
 * test a repository that is not added.
 */
export async function startCore(home: string, extraEnv: Record<string, string> = {}, options: StartCoreOptions = {}): Promise<RunningCore> {
  const core = await launchCore(home, extraEnv);
  for (const repo of options.projects ?? fixtureRepos) {
    if (fs.existsSync(repo)) await addProject(core, repo);
  }
  return core;
}

/** Adds a repository root as a project of the test Core. */
export async function addProject(core: RunningCore, repo: string): Promise<void> {
  const result = await api(core, 'POST', '/api/v1/projects', { path: repo });
  if (result.status !== 201 && result.status !== 200) throw new Error(`Adding ${repo} as a project failed: ${result.status} ${JSON.stringify(result.body)}`);
}

/** Adds a project through the Core that runs for `home` (started by the CLI, not by the harness). */
export async function addProjectAt(home: string, repo: string): Promise<void> {
  const info = coreRuntimeInfoSchema.parse(JSON.parse(fs.readFileSync(path.join(home, 'run', 'core.json'), 'utf8')));
  const userToken = readUserToken(home, info.pid);
  if (userToken === null) throw new Error(`No core-user.json of the Core with pid ${info.pid} in ${home}`);
  await addProject({ home, info, agentToken: info.token, userToken } as RunningCore, repo);
}

async function launchCore(home: string, extraEnv: Record<string, string>): Promise<RunningCore> {
  const child = spawn(process.execPath, [CORE], {
    env: { ...process.env, ...TEST_CORE_ENV, JERRY_HOME: home, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const coreFile = path.join(home, 'run', 'core.json');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(coreFile)) {
      const info = coreRuntimeInfoSchema.parse(JSON.parse(fs.readFileSync(coreFile, 'utf8')));
      // core-user.json follows core.json at once; wait for both.
      const userToken = info.pid === child.pid ? readUserToken(home, info.pid) : null;
      if (userToken !== null) {
        return {
          home,
          info,
          agentToken: info.token,
          userToken,
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

/** A Core API call; the user's token unless a test acts as an agent (pass core.agentToken). */
export async function api(core: RunningCore, method: 'GET' | 'POST', apiPath: string, body?: unknown, token = core.userToken): Promise<{ status: number; body: unknown }> {
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

export function runBridge(event: 'pre-tool-use' | 'session-start' | 'event', input: unknown, env: Record<string, string>): BridgeResult {
  const started = performance.now();
  const result = spawnSync(process.execPath, [BRIDGE, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, ...TEST_CORE_ENV, ...env },
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
  fixtureRepos.push(dir);
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
