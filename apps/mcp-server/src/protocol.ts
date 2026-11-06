import readline from 'node:readline';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, ping, tools/list and
 * tools/call. JERRY's tools are few and read-only, so the protocol surface is kept this small on
 * purpose and has no dependencies.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** False for tools that submit something to JERRY (never for approvals: those do not exist here). */
  readOnly: boolean;
  handler: (args: Record<string, unknown>, call: CallContext) => Promise<ToolResult>;
}

/** What Claude Code tells the server about a call beyond its arguments. */
export interface CallContext {
  /** `_meta["claudecode/toolUseId"]`: the same ID the PreToolUse hook saw for this call. */
  toolUseId: string | null;
}

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export function serve(serverInfo: { name: string; version: string }, instructions: string, tools: readonly ToolDefinition[], output: NodeJS.WritableStream = process.stdout): void {
  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: Request['id'], result: unknown): void => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Request['id'], code: number, message: string): void => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '') return;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      fail(null, -32700, 'Parse error');
      return;
    }
    if (request.id === undefined) return; // notifications (initialized, cancelled) need no answer
    void handle(request).catch((error: unknown) => fail(request.id, -32603, error instanceof Error ? error.message : 'Internal error'));
  });

  async function handle(request: Request): Promise<void> {
    switch (request.method) {
      case 'initialize': {
        const requested = request.params?.['protocolVersion'];
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
        reply(request.id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo, instructions });
        return;
      }
      case 'ping':
        reply(request.id, {});
        return;
      case 'tools/list':
        reply(request.id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
          })),
        });
        return;
      case 'tools/call': {
        const name = request.params?.['name'];
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined) {
          fail(request.id, -32602, `Unknown tool: ${String(name)}`);
          return;
        }
        const args = request.params?.['arguments'];
        const meta = request.params?.['_meta'];
        const toolUseId = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)['claudecode/toolUseId'] : undefined;
        const call: CallContext = { toolUseId: typeof toolUseId === 'string' && toolUseId !== '' ? toolUseId : null };
        reply(request.id, await tool.handler(typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}, call));
        return;
      }
      default:
        fail(request.id, -32601, `Method not found: ${String(request.method)}`);
    }
  }
}
