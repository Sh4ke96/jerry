import fs from 'node:fs';
import path from 'node:path';
import { AGENT_ROLES, MAX_SUBAGENTS, WRITE_TOOLS } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../helpers/harness.js';

/** Frontmatter of a Claude Code subagent definition (name, description, tools). */
function frontmatter(file: string): Record<string, string> {
  const text = fs.readFileSync(file, 'utf8');
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  return Object.fromEntries(block.split(/\r?\n/).map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()]));
}

const agentsDir = path.join(ROOT, 'claude-plugin', 'agents');

describe('agent registry and plugin subagents (ADR 0022)', () => {
  it('ships exactly one subagent definition per registered role', () => {
    const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith('.md')).sort();
    expect(files).toEqual(AGENT_ROLES.map((role) => `${role.id}.md`).sort());
    for (const role of AGENT_ROLES) {
      const meta = frontmatter(path.join(agentsDir, `${role.id}.md`));
      expect(meta['name'], role.id).toBe(role.id);
      expect(meta['description']?.length ?? 0, role.id).toBeGreaterThan(40);
    }
  });

  it('gives read-only roles no tool that writes or runs commands', () => {
    for (const role of AGENT_ROLES) {
      const tools = (frontmatter(path.join(agentsDir, `${role.id}.md`))['tools'] ?? '').split(',').map((tool) => tool.trim());
      expect(tools.length, role.id).toBeGreaterThan(0);
      if (role.readOnly) expect(tools.filter((tool) => WRITE_TOOLS.includes(tool)), role.id).toEqual([]);
      // Everyone may read JERRY's state; nobody gets a tool that decides anything (there is none to get).
      expect(tools.some((tool) => /approve|accept|reject/i.test(tool)), role.id).toBe(false);
    }
  });

  it('keeps every phase within the three-subagent cap of ADR 0015', () => {
    expect(MAX_SUBAGENTS).toBe(3);
    for (const phase of ['analysis', 'review'] as const) {
      expect(AGENT_ROLES.filter((role) => role.phase === phase), phase).toHaveLength(MAX_SUBAGENTS);
    }
  });

  it('is part of the built plugin', () => {
    for (const role of AGENT_ROLES) expect(fs.existsSync(path.join(ROOT, 'dist', 'plugin', 'agents', `${role.id}.md`)), role.id).toBe(true);
  });
});
