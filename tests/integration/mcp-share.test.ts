import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolDefinition, ToolResult } from '../../apps/mcp-server/src/protocol.js';
import { answerChars, withShareCounter } from '../../apps/mcp-server/src/share.js';

describe("MCP server: JERRY's share counter", () => {
  // No Core here: an empty JERRY home, so the counter call has nowhere to go (never the user's Core).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-mcp-share-'));
  const saved = process.env['JERRY_HOME'];
  beforeAll(() => {
    process.env['JERRY_HOME'] = home;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env['JERRY_HOME'];
    else process.env['JERRY_HOME'] = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const answer: ToolResult = { content: [{ type: 'text', text: '✅ summary' }, { type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } };
  const tool: ToolDefinition = { name: 'get_state', title: 'State', description: 'd', inputSchema: {}, readOnly: true, handler: async () => answer };

  it('counts the text Claude receives, not the repeated structured content', () => {
    expect(answerChars(answer)).toBe('✅ summary'.length + '{"a":1}'.length);
  });

  it('returns every answer unchanged, also without a running Core', async () => {
    const [wrapped] = withShareCounter([tool]);
    expect(wrapped).toMatchObject({ name: 'get_state', title: 'State', readOnly: true });
    expect(await wrapped!.handler({}, { toolUseId: 'toolu_1' })).toBe(answer);
  });
});
