import { readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';
import type { CallContext, ToolDefinition, ToolResult } from './protocol.js';

/**
 * JERRY's share of Claude's context: the length of every tool answer's text goes to Core in a small
 * counter call after the answer is sent (fire and forget, so no answer waits for it). Core keeps it
 * only for a session it registered in a project; the call's tool-use ID and the session ID tell it
 * which one.
 */

const SHARE_TIMEOUT_MS = 1000;

/** Characters of the text Claude receives (structuredContent repeats the JSON and is not counted). */
export function answerChars(result: ToolResult): number {
  return result.content.reduce((sum, part) => sum + part.text.length, 0);
}

function report(chars: number, call: CallContext): void {
  const sessionId = process.env['CLAUDE_CODE_SESSION_ID'];
  const origin = { ...(call.toolUseId === null ? {} : { toolUseId: call.toolUseId }), ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }) };
  try {
    const info = readCoreRuntimeInfo(resolveJerryHome());
    void requestCore(info, { method: 'POST', path: '/api/v1/usage/jerry-share', body: { kind: 'mcp', chars, origin }, timeoutMs: SHARE_TIMEOUT_MS }).catch(() => undefined);
  } catch {
    // Core not running: nothing to count.
  }
}

/** The same tools, each answer counted after it is produced. */
export function withShareCounter(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    handler: async (args, call) => {
      const result = await tool.handler(args, call);
      const chars = answerChars(result);
      if (chars > 0) report(chars, call);
      return result;
    },
  }));
}
