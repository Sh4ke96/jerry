import { JERRY_VERSION } from '@jerry/contracts';
import { serve } from './protocol.js';
import { TOOLS } from './tools.js';

/** JERRY's MCP server, started by Claude Code from the plugin's .mcp.json (stdio). */
serve(
  { name: 'jerry', version: JERRY_VERSION },
  // Kept short: it stays in the context of every session (token cost, see ADR 0008).
  'JERRY state, the project profile, path checks, plans, implementation reports and progress checkpoints. Use them for the live plan state, the project\'s commands, to submit a plan or report, or to save progress; nothing here can approve or accept.',
  TOOLS,
);
