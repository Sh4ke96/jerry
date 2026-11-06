import type { GitAssessment } from './shell.js';

/**
 * Hard rule for MCP tools: MCP servers for Git hosting or Git itself (GitHub, GitLab,
 * Bitbucket, Gitea, mcp-server-git, ...) can push, commit, branch and merge without any shell
 * command. Only those servers are inspected, so unrelated tools that happen to share a verb
 * (a payment "checkout", a document "merge") are never blocked. Issues, comments and reviews are
 * not Git operations and stay available.
 */

const GIT_SERVER = /git|bitbucket/i;

const READ_ONLY_VERBS = new Set([
  'get', 'list', 'search', 'read', 'show', 'view', 'find', 'query', 'describe', 'status', 'diff', 'log', 'blame', 'compare', 'download',
]);

/** Verbs that write something when combined with a Git object (create_branch, delete_file, ...). */
const WRITE_VERBS = new Set([
  'create', 'update', 'delete', 'remove', 'add', 'write', 'edit', 'set', 'put', 'upload', 'rename', 'move', 'close', 'reopen', 'publish',
  'commit', 'push', 'merge', 'rebase', 'revert', 'stash', 'checkout', 'switch', 'restore', 'reset', 'cherry', 'amend', 'fetch', 'pull',
  'init', 'clone', 'fork', 'tag',
]);

/** Leading verbs that change Git state on any Git server (push_files, merge_pull_request, fork_repository). */
const DIRECT_GIT_VERBS = new Set(['push', 'commit', 'merge', 'rebase', 'revert', 'cherry', 'fork']);

/** Leading verbs of "git_<verb>" tools (mcp-server-git style) that change state. */
const GIT_PREFIXED_MUTATING_VERBS = new Set([
  'add', 'commit', 'push', 'pull', 'merge', 'rebase', 'revert', 'stash', 'checkout', 'switch', 'restore', 'reset', 'cherry', 'fetch', 'init', 'clone', 'tag', 'branch',
]);

const GIT_OBJECTS = new Set([
  'branch', 'branches', 'commit', 'commits', 'ref', 'refs', 'tag', 'tags', 'file', 'files', 'contents', 'repository', 'repositories',
  'repo', 'repos', 'fork', 'release', 'releases', 'pr', 'mr',
]);

/** Collaboration objects that are not Git state. */
const NON_GIT_OBJECTS = new Set(['issue', 'issues', 'comment', 'comments', 'review', 'reviews', 'discussion', 'label', 'labels', 'notification', 'notifications']);

export interface McpToolName {
  server: string;
  tool: string;
}

/** Splits "mcp__<server>__<tool>" (plugin servers: "mcp__plugin_<plugin>_<server>__<tool>"). */
export function parseMcpToolName(toolName: string): McpToolName | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match === null ? null : { server: match[1]!, tool: match[2]! };
}

export function assessMcpGitUsage({ server, tool }: McpToolName): GitAssessment {
  if (!GIT_SERVER.test(server)) return { mutating: false, reason: `${server} is not a Git server` };

  const tokens = tool.toLowerCase().split(/[_\-.\s]+/).filter((token) => token !== '');
  const gitPrefixed = tokens[0] === 'git' && tokens.length > 1;
  const core = gitPrefixed ? tokens.slice(1) : tokens;
  const [verb] = core;
  if (verb === undefined) return { mutating: false, reason: 'empty tool name' };

  const mutating = (): GitAssessment => ({ mutating: true, reason: `MCP tool ${server}/${tool} changes or publishes Git state` });

  if (READ_ONLY_VERBS.has(verb)) return { mutating: false, reason: `${tool} only reads` };
  if (gitPrefixed && GIT_PREFIXED_MUTATING_VERBS.has(verb)) return mutating();
  if (DIRECT_GIT_VERBS.has(verb)) return mutating();

  // "pull"/"merge" directly before "request" name a pull/merge request, not an action.
  const hasWriteVerb = core.some((token, index) => WRITE_VERBS.has(token) && !((token === 'pull' || token === 'merge') && core[index + 1] === 'request'));
  if (!hasWriteVerb && core.some((token) => READ_ONLY_VERBS.has(token))) return { mutating: false, reason: `${tool} only reads` };
  if (core.some((token) => NON_GIT_OBJECTS.has(token))) return { mutating: false, reason: `${tool} works on issues, comments or reviews` };

  const touchesPullRequest = (core.includes('pull') || core.includes('merge')) && core.includes('request');
  if (hasWriteVerb && (touchesPullRequest || core.some((token) => GIT_OBJECTS.has(token)))) return mutating();
  return { mutating: false, reason: `${tool} does not change Git objects` };
}
