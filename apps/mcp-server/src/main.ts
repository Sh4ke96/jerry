import { JERRY_VERSION } from '@jerry/contracts';
import { serve } from './protocol.js';
import { TOOLS } from './tools.js';

/** JERRY's MCP server, started by Claude Code from the plugin's .mcp.json (stdio). */
serve(
  { name: 'jerry', version: JERRY_VERSION },
  [
    'JERRY monitors this session. Its tools are read-only.',
    'The plan state can change during a session: use jerry_get_approval_status or jerry_get_next_required_action instead of relying on the session start message.',
    'Use jerry_check_paths before edits that may fall outside the approved scope, and jerry_list_deviations before summarizing work, so the user hears about every deviation.',
    'JERRY never approves anything on the user’s behalf, and only the user performs Git operations.',
  ].join(' '),
  TOOLS,
);
