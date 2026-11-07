import { JERRY_VERSION } from '@jerry/contracts';
import { serve } from './protocol.js';
import { withShareCounter } from './share.js';
import { TOOLS } from './tools.js';

/** JERRY's MCP server, started by Claude Code from the plugin's .mcp.json (stdio). */
serve(
  { name: 'jerry-guardian', version: JERRY_VERSION },
  // Kept short: it stays in the context of every session, so every word costs tokens.
  'JERRY state, the project profile, path checks, plans, implementation reports and progress checkpoints. Use them for the live plan state, the project\'s commands, to submit a plan or report and wait for the user\'s decision on it, or to save progress; nothing here can approve or accept.',
  withShareCounter(TOOLS),
);
