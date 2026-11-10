import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The hard rules are never reworded or shortened without the owner's explicit approval. Emoji and
 * other formatting may only be added around them. These hashes pin the exact wording: if one fails,
 * the wording changed, and the change needs that approval before the hash is updated.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('hard rules stay verbatim', () => {
  it('keeps the hard-rule statement Claude is told at session start', () => {
    const bridge = fs.readFileSync(path.join(ROOT, 'apps', 'hook-bridge', 'src', 'main.ts'), 'utf8');
    const text = /const HARD_RULES_TEXT =\s*\n\s*'([^']*)';/.exec(bridge)?.[1];
    expect(text).toBeDefined();
    // Last changed with the owner's explicit approval (JRY-0046, additions only): the user-only
    // commands added since and the rule against reading JERRY data are named after the earlier
    // statement, which stays word for word.
    expect(sha256(text ?? '')).toBe('fbb538c13b91d79841b59a6d7b74e11b8c33f00c663b4a0496b22a7eeb55bd5c');
    expect(text).toContain('"jerry project add/remove", "jerry data prune/forget"');
    // The statement as approved in JRY-0024 is still its beginning, word for word.
    const jry0024 = text?.slice(0, text.indexOf(' The user alone also runs "jerry task complete"')) ?? '';
    expect(sha256(jry0024)).toBe('6f98d6de3b475110483a72748a7157a1c58746ed1489ca781e845f42d4833569');
    const before =
      'Hard rules, always enforced: you may not run any Git command that changes anything (commit, push, merge, rebase, checkout, switch, reset, restore, stash, fetch, pull, tag, branch changes, config changes, gh/npm version and similar), and you may not use MCP tools of Git servers that push, commit, create branches or files, or open or merge pull requests; the user does all Git operations manually. Read-only Git (status, diff, log, show, blame) is fine. You may not write inside .git, modify JERRY data or the Claude Code settings that enable JERRY, run "jerry approve/reject/install/uninstall/ui", "jerry repo exclude/include", "jerry project add/remove", "jerry data prune/forget", "jerry core start/stop" or "jerry db restore", or call the JERRY API or dashboard.';
    expect(sha256(before)).toBe('140792725acdd57d214a6274c240662ea730d8f5375e271362e917f27fabc6b0');
    expect(text?.startsWith(before)).toBe(true);
  });

  it('names every user-only command the gate blocks', () => {
    const bridge = fs.readFileSync(path.join(ROOT, 'apps', 'hook-bridge', 'src', 'main.ts'), 'utf8');
    const text = /const HARD_RULES_TEXT =\s*\n\s*'([^']*)';/.exec(bridge)?.[1] ?? '';
    for (const command of [
      'task pause/resume/cancel/recheck',
      'settings set',
      'statusline enable/disable',
      'usage enable/disable',
      'skill add/enable/disable/update/remove/states',
      'workspace create/add/remove/rename/delete',
      'task complete',
      'review skip',
      'findings set',
      'eval baseline/label',
    ]) {
      expect(text).toContain(`"jerry ${command}"`);
    }
  });

  it('names the JERRY data folders agents may not read', () => {
    const bridge = fs.readFileSync(path.join(ROOT, 'apps', 'hook-bridge', 'src', 'main.ts'), 'utf8');
    const text = /const HARD_RULES_TEXT =\s*\n\s*'([^']*)';/.exec(bridge)?.[1] ?? '';
    expect(text).toContain('You may not read JERRY data either: its run, config, state, database, backups, spool and logs folders (the plugin files stay readable).');
  });

  it('keeps every hard-rule DENY reason of the gate', () => {
    const dir = path.join(ROOT, 'packages', 'policy-engine', 'src');
    const lines = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.ts'))
      .sort()
      .flatMap((file) => fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/))
      .filter((line) => line.includes("decision('DENY'"))
      .map((line) => line.trim());
    // Last changed with the owner's explicit approval (JRY-0046, additions only): one new reason,
    // hard.protected-read; the eight earlier lines stay word for word.
    expect(lines).toHaveLength(9);
    expect(sha256(lines.join('\n'))).toBe('e2813b056f7993dc2858b39bde0a0e76d299ae7db4674a76af84626fbda5ef64');
    const earlier = lines.filter((line) => !line.includes("'hard.protected-read'"));
    expect(earlier).toHaveLength(8);
    expect(sha256(earlier.join('\n'))).toBe('1a0e2d1e4ccdef510e750065a639d179afb8319be0ae3528234101641fd5d561');
  });
});
