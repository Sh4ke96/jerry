import { parseMcpToolName } from './mcp.js';
import type { ShellDialect } from './shell.js';

export type ToolAction =
  | { kind: 'file-write'; paths: string[] }
  /** A write tool whose target path could not be determined: always denied. */
  | { kind: 'file-write-unknown'; detail: string }
  | { kind: 'shell'; command: string; dialect: ShellDialect }
  /** Background/long-running command tools: never treated as read-only. */
  | { kind: 'shell-opaque'; command: string }
  /** A tool of an MCP server; only Git-capable ones are subject to the hard rules. */
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'not-guarded' };

const FILE_PATH_FIELD: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

const SHELL_DIALECT: Readonly<Record<string, ShellDialect>> = {
  Bash: 'bash',
  PowerShell: 'powershell',
};

const OPAQUE_COMMAND_TOOLS = new Set(['Monitor']);

export function classifyToolCall(toolName: string, toolInput: Readonly<Record<string, unknown>>): ToolAction {
  const pathField = FILE_PATH_FIELD[toolName];
  if (pathField !== undefined) {
    const target = toolInput[pathField];
    return typeof target === 'string' && target.trim() !== ''
      ? { kind: 'file-write', paths: [target] }
      : { kind: 'file-write-unknown', detail: `${toolName} call without a string "${pathField}"` };
  }

  const dialect = SHELL_DIALECT[toolName];
  const command = toolInput['command'];
  if (dialect !== undefined) {
    return typeof command === 'string'
      ? { kind: 'shell', command, dialect }
      : { kind: 'shell-opaque', command: '' };
  }
  if (OPAQUE_COMMAND_TOOLS.has(toolName)) {
    return { kind: 'shell-opaque', command: typeof command === 'string' ? command : '' };
  }
  const mcpTool = parseMcpToolName(toolName);
  if (mcpTool !== null) return { kind: 'mcp', ...mcpTool };
  return { kind: 'not-guarded' };
}
