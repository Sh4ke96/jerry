import fs from 'node:fs';
import path from 'node:path';
import { assessMcpGitUsage, parseMcpToolName } from '@jerry/policy-engine';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../apps/mcp-server/src/tools.js';

/**
 * JERRY's MCP server is 'guardian' in the plugin 'jerry', so Claude Code shows its tools as
 * "Plugin Jerry Guardian [get_state]" with ids mcp__plugin_jerry_guardian__<tool>. Agents, skills,
 * eval cases and the live check name tools by those ids or names: a typo or a leftover old name
 * would silently take a tool away from an agent, so every reference must exist.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PREFIX = 'mcp__plugin_jerry_guardian__';
const NAMES = new Set(TOOLS.map((tool) => tool.name));

function filesUnder(dir: string, extensions: RegExp): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { recursive: true })
    .map((name) => path.join(ROOT, dir, String(name)))
    .filter((file) => fs.statSync(file).isFile() && extensions.test(file));
}

const SOURCES = [
  ...filesUnder('claude-plugin', /\.(md|json)$/),
  ...filesUnder('evals/cases', /\.json$/),
  path.join(ROOT, 'scripts', 'e2e-live.mjs'),
];

describe('MCP tool references', () => {
  it('declares the server as guardian', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-plugin', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(config.mcpServers)).toEqual(['guardian']);
  });

  it('names only tools that exist, with no old ids left', () => {
    const missing: string[] = [];
    for (const file of SOURCES) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, path.relative(ROOT, file)).not.toMatch(/plugin_jerry_jerry|plugin:jerry:jerry|\bjerry_(get|submit|list|check|save|start|assign|finish|report|record)_/);
      for (const match of text.matchAll(/mcp__plugin_jerry_guardian__([a-z_]+)/g)) {
        if (!NAMES.has(match[1]!)) missing.push(`${path.relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every agent at least one JERRY tool', () => {
    for (const file of filesUnder('claude-plugin/agents', /\.md$/)) {
      const tools = /^tools:(.*)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
      expect(tools, path.basename(file)).toContain(PREFIX);
    }
  });

  it("never treats JERRY's own tools as Git tools", () => {
    for (const name of NAMES) {
      const parsed = parseMcpToolName(`${PREFIX}${name}`);
      expect(parsed).not.toBeNull();
      expect(assessMcpGitUsage(parsed!).mutating, name).toBe(false);
    }
  });
});
