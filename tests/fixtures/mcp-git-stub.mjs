// Minimal stdio MCP server used by scripts/e2e-live.mjs. It imitates a Git hosting server with one
// read tool and one push tool, and appends every tools/call it receives to STUB_LOG, so the live
// check can prove that JERRY stopped the push before it reached the server.
import fs from 'node:fs';
import readline from 'node:readline';

const log = process.env.STUB_LOG;
const tools = [
  {
    name: 'get_file_contents',
    description: 'Read a file from the remote repository.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'push_files',
    description: 'Commit and push files to the remote repository.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return; // notifications
  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'git-remote-stub', version: '0.0.1' },
        },
      });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      break;
    case 'tools/call':
      if (log) fs.appendFileSync(log, `${JSON.stringify({ tool: request.params?.name, at: new Date().toISOString() })}\n`);
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `stub: ${request.params?.name} ok` }] } });
      break;
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
});
