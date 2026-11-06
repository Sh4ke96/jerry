import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api, createFixtureRepo, ROOT, runBridge, preToolUse, startCore, tempDir, TEST_CORE_ENV, type RunningCore } from '../helpers/harness.js';

const MCP_SERVER = path.join(ROOT, 'dist', 'plugin', 'mcp', 'server.mjs');

/** A tiny MCP client speaking newline-delimited JSON-RPC over the server's stdio. */
class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, ...TEST_CORE_ENV, ...env }, windowsHide: true });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      const resolve = this.pending.get(message['id'] as number);
      if (resolve !== undefined) {
        this.pending.delete(message['id'] as number);
        resolve(message);
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ structured: Record<string, unknown>; text: string; isError: boolean }> {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response['result'] as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { structured: result.structuredContent ?? {}, text: result.content[0]?.text ?? '', isError: result.isError === true };
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

describe('JERRY MCP server (bundled)', () => {
  const base = tempDir('mcp');
  const repo = createFixtureRepo(path.join(base, 'repo'));
  const home = path.join(base, 'home');
  let core: RunningCore;
  let client: McpClient;

  beforeAll(async () => {
    core = await startCore(home);
  });
  afterEach(() => client?.close());
  afterAll(async () => {
    await core.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const connect = async (env: Record<string, string> = { JERRY_HOME: home, CLAUDE_PROJECT_DIR: repo }): Promise<McpClient> => {
    client = new McpClient(env);
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init['result']).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'jerry' }, capabilities: { tools: {} } });
    client.notify('notifications/initialized');
    return client;
  };

  it('offers only read-only tools, and none that approves anything', async () => {
    const mcp = await connect();
    const listed = (await mcp.request('tools/list'))['result'] as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['jerry_check_paths', 'jerry_get_state', 'jerry_list_deviations']);
    expect(listed.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(names.some((name) => /approve|reject|exclude|done|complete/.test(name))).toBe(false);
  });

  it('reports the live plan state: none, waiting, approved', async () => {
    const mcp = await connect();
    expect((await mcp.call('jerry_get_state')).structured).toMatchObject({ guard: 'GUARDED', monitored: true, currentTask: null, next: { action: 'propose-plan' } });

    const created = (await api(core, 'POST', '/api/v1/tasks', { repoPath: repo, title: 'Live state', scope: ['src/**'] })).body as { taskId: string };
    expect((await mcp.call('jerry_get_state')).structured).toMatchObject({
      currentTask: { taskId: created.taskId, status: 'WAITING_FOR_APPROVAL' },
      next: { action: 'wait-for-approval' },
    });

    // Approved while the session is running: the tool sees it immediately.
    await api(core, 'POST', `/api/v1/tasks/${created.taskId}/approvals`, { stage: 'PLAN', version: 1, decision: 'APPROVED' });
    const state = (await mcp.call('jerry_get_state')).structured;
    expect(state).toMatchObject({ approved: [{ taskId: created.taskId, scope: ['src/**'], status: 'APPROVED' }], notApproved: [], next: { action: 'work-within-approved-scope' } });
    expect(String(state['hardRules'])).toContain('No Git command');
  });

  it('previews gate decisions without recording them', async () => {
    const mcp = await connect();
    const before = ((await api(core, 'GET', '/api/v1/events?limit=500')).body as unknown[]).length;
    const result = await mcp.call('jerry_check_paths', { paths: ['src/app.ts', 'README.md', '.git/config'] });
    expect(result.structured).toMatchObject({
      decisions: [
        { path: 'src/app.ts', verdict: 'PASS', rule: 'monitor.in-approved-scope' },
        { path: 'README.md', verdict: 'WARN', rule: 'monitor.out-of-scope' },
        { path: '.git/config', verdict: 'DENY', rule: 'hard.git-metadata' },
      ],
    });
    expect(((await api(core, 'GET', '/api/v1/events?limit=500')).body as unknown[]).length).toBe(before);
  });

  it('lists recorded deviations of the repository', async () => {
    runBridge('pre-tool-use', preToolUse(repo, 'Write', { file_path: path.join(repo, 'README.md') }), { JERRY_HOME: home });
    runBridge('pre-tool-use', preToolUse(repo, 'Bash', { command: 'git push' }), { JERRY_HOME: home });
    const mcp = await connect();
    const result = await mcp.call('jerry_list_deviations');
    const deviations = result.structured['deviations'] as Array<{ verdict: string; rule: string }>;
    expect(deviations.map((deviation) => `${deviation.verdict}:${deviation.rule}`)).toEqual(expect.arrayContaining(['WARN:monitor.out-of-scope']));
  });

  it('says plainly when Core is unreachable, instead of guessing', async () => {
    const mcp = await connect({ JERRY_HOME: path.join(base, 'no-core-here'), CLAUDE_PROJECT_DIR: repo });
    const result = await mcp.call('jerry_get_state');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('JERRY Core is not reachable');
  });

  it('answers protocol errors without crashing', async () => {
    const mcp = await connect();
    expect((await mcp.request('tools/call', { name: 'approve_plan' }))['error']).toMatchObject({ code: -32602 });
    expect((await mcp.request('resources/list'))['error']).toMatchObject({ code: -32601 });
    expect((await mcp.request('ping'))['result']).toEqual({});
  });
});
