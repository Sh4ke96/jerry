import { describe, expect, it } from 'vitest';
import { assessMcpGitUsage, parseMcpToolName } from '../src/mcp.js';

const assess = (toolName: string) => assessMcpGitUsage(parseMcpToolName(toolName)!);

describe('parseMcpToolName', () => {
  it('splits server and tool, including plugin-provided servers', () => {
    expect(parseMcpToolName('mcp__github__push_files')).toEqual({ server: 'github', tool: 'push_files' });
    expect(parseMcpToolName('mcp__plugin_jerry_guardian__get_status')).toEqual({ server: 'plugin_jerry_guardian', tool: 'get_status' });
    expect(parseMcpToolName('Write')).toBeNull();
  });
});

describe('assessMcpGitUsage', () => {
  it.each([
    // GitHub MCP
    'mcp__github__push_files',
    'mcp__github__create_or_update_file',
    'mcp__github__delete_file',
    'mcp__github__create_branch',
    'mcp__github__create_pull_request',
    'mcp__github__merge_pull_request',
    'mcp__github__update_pull_request_branch',
    'mcp__github__create_repository',
    'mcp__github__fork_repository',
    // GitLab / Bitbucket
    'mcp__gitlab__create_merge_request',
    'mcp__gitlab__push_files',
    'mcp__bitbucket__create_branch',
    // mcp-server-git
    'mcp__git__git_add',
    'mcp__git__git_commit',
    'mcp__git__git_reset',
    'mcp__git__git_checkout',
    'mcp__git__git_create_branch',
    'mcp__git__git_init',
    // plugin-provided Git server
    'mcp__plugin_tools_github__push_files',
  ])('%s changes Git state', (toolName) => {
    expect(assess(toolName).mutating).toBe(true);
  });

  it.each([
    'mcp__github__get_file_contents',
    'mcp__github__list_commits',
    'mcp__github__get_pull_request',
    'mcp__github__pull_request_read',
    'mcp__github__search_code',
    'mcp__github__create_issue',
    'mcp__github__add_issue_comment',
    'mcp__github__create_pending_pull_request_review',
    'mcp__git__git_status',
    'mcp__git__git_diff_unstaged',
    'mcp__git__git_log',
    'mcp__git__git_show',
    // Not a Git server: shared verbs must not be blocked
    'mcp__stripe__create_checkout_session',
    'mcp__docs__merge_documents',
    'mcp__claude_ai_Notion__create_page',
  ])('%s does not change Git state', (toolName) => {
    expect(assess(toolName).mutating).toBe(false);
  });
});
