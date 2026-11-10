import { parseMcpToolName } from './mcp.js';
import type { ShellDialect } from './shell.js';

export type ToolAction =
  | { kind: 'file-write'; paths: string[] }
  /**
   * A tool that reads files: Read and NotebookRead read the file they name; Grep, Glob and LS
   * (search: true) read below the folders they name, the working directory (".") when they name none.
   */
  | { kind: 'file-read'; paths: string[]; search: boolean }
  /** A write tool whose target path could not be determined: always denied. */
  | { kind: 'file-write-unknown'; detail: string }
  | { kind: 'shell'; command: string; dialect: ShellDialect }
  /** Background/long-running command tools: never treated as read-only. */
  | { kind: 'shell-opaque'; command: string }
  /** A tool of an MCP server; only Git-capable ones are subject to the hard rules. */
  | { kind: 'mcp'; server: string; tool: string }
  /** Claude Code's Skill tool; name is null when the call does not say which skill. */
  | { kind: 'skill'; name: string | null }
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

/** Read tools and the field naming the file they read. */
const READ_FILE_FIELD: Readonly<Record<string, string>> = {
  Read: 'file_path',
  NotebookRead: 'notebook_path',
};

/**
 * Search tools: they read below their `path`, the working directory when it is missing. Grep's
 * `pattern` is a regular expression and its `glob` a filter of file names, never a place to search.
 */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob', 'LS']);

/** The working directory as a relative path: resolved against the call's cwd by the gate. */
const WORKING_DIRECTORY = '.';

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * The folder a glob pattern starts from: its segments before the first one with a wildcard
 * ("C:/x/JERRY/run/*.json" -> "C:/x/JERRY/run"), or null when the first segment already has one.
 */
export function globStaticPrefix(pattern: string): string | null {
  const segments = pattern.split(/[\\/]/);
  const firstWild = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
  const fixed = firstWild === -1 ? segments.slice(0, -1) : segments.slice(0, firstWild);
  if (fixed.length === 0) return null;
  const prefix = fixed.join('/');
  // "/x" splits into ["", "x"]: an empty prefix is the root folder.
  return prefix === '' ? '/' : prefix;
}

function searchPaths(toolName: string, toolInput: Readonly<Record<string, unknown>>): string[] {
  const root = nonEmpty(toolInput['path']) ? toolInput['path'] : WORKING_DIRECTORY;
  const paths = [root];
  const pattern = toolInput['pattern'];
  if (toolName === 'Glob' && nonEmpty(pattern)) {
    // An absolute pattern searches where it says, whatever the path; one with ".." climbs out of it.
    const prefix = globStaticPrefix(pattern.trim());
    if (prefix !== null && isAbsolutePattern(prefix)) paths.push(prefix);
    else if (prefix !== null && /(^|[\\/])\.\.([\\/]|$)/.test(prefix)) paths.push(`${root.replace(/[\\/]+$/, '')}/${prefix}`);
  }
  return paths;
}

/** POSIX, drive-letter, UNC and MSYS ("/c/...") absolute paths. */
function isAbsolutePattern(value: string): boolean {
  return /^(?:[\\/]|[a-zA-Z]:)/.test(value);
}

export function classifyToolCall(toolName: string, toolInput: Readonly<Record<string, unknown>>): ToolAction {
  const readField = READ_FILE_FIELD[toolName];
  if (readField !== undefined) {
    const target = toolInput[readField];
    return { kind: 'file-read', paths: nonEmpty(target) ? [target] : [], search: false };
  }
  if (SEARCH_TOOLS.has(toolName)) return { kind: 'file-read', paths: searchPaths(toolName, toolInput), search: true };

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
  if (toolName === 'Skill') {
    // Claude Code's Skill tool input: { skill: "<name>", args?: "..." }.
    const name = toolInput['skill'];
    return { kind: 'skill', name: typeof name === 'string' && name.trim() !== '' ? name.trim().replace(/^\//, '') : null };
  }
  const mcpTool = parseMcpToolName(toolName);
  if (mcpTool !== null) return { kind: 'mcp', ...mcpTool };
  return { kind: 'not-guarded' };
}
