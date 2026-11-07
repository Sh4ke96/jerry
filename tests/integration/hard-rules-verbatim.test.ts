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
    // Last changed with the owner's explicit approval: "jerry project add/remove" and
    // "jerry data prune/forget" added to the user-only commands.
    expect(sha256(text ?? '')).toBe('140792725acdd57d214a6274c240662ea730d8f5375e271362e917f27fabc6b0');
    expect(text).toContain('"jerry project add/remove", "jerry data prune/forget"');
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
    expect(lines).toHaveLength(8);
    expect(sha256(lines.join('\n'))).toBe('1a0e2d1e4ccdef510e750065a639d179afb8319be0ae3528234101641fd5d561');
  });
});
