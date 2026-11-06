import { JERRY_VERSION } from '@jerry/contracts';
import { serve } from './protocol.js';
import { TOOLS } from './tools.js';

/** JERRY's MCP server, started by Claude Code from the plugin's .mcp.json (stdio). */
serve(
  { name: 'jerry', version: JERRY_VERSION },
  // Kept short: it stays in the context of every session (token cost, see ADR 0008).
  'Read-only JERRY state. Use these tools only when you need the live plan state; they cannot approve anything.',
  TOOLS,
);
