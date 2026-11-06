import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, TEST_CORE_ENV } from './harness.js';

export const MCP_SERVER = path.join(ROOT, 'dist', 'plugin', 'mcp', 'server.mjs');

/** A tiny MCP client speaking newline-delimited JSON-RPC over the bundled server's stdio. */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(env: Record<string, string>) {
    // CLAUDE_CODE_SESSION_ID is cleared so a test run inside Claude Code never leaks its own session.
    this.child = spawn(process.execPath, [MCP_SERVER], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...TEST_CORE_ENV, ...env }, windowsHide: true });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      const resolve = this.pending.get(message['id'] as number);
      if (resolve !== undefined) {
        this.pending.delete(message['id'] as number);
        resolve(message);
      }
    });
  }

  /** Starts the server and completes the MCP handshake. */
  static async connect(env: Record<string, string>): Promise<McpClient> {
    const client = new McpClient(env);
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    if (typeof init['result'] !== 'object') throw new Error(`MCP initialize failed: ${JSON.stringify(init)}`);
    client.notify('notifications/initialized');
    return client;
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

  /** `toolUseId` is sent the way Claude Code sends it: `_meta["claudecode/toolUseId"]`. */
  async call(name: string, args: Record<string, unknown> = {}, toolUseId?: string): Promise<{ structured: Record<string, unknown>; text: string; isError: boolean }> {
    const response = await this.request('tools/call', { name, arguments: args, ...(toolUseId === undefined ? {} : { _meta: { 'claudecode/toolUseId': toolUseId, progressToken: 1 } }) });
    const result = response['result'] as { content: Array<{ text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { structured: result.structuredContent ?? {}, text: result.content[0]?.text ?? '', isError: result.isError === true };
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}
