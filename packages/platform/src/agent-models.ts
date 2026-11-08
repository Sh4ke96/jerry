import fs from 'node:fs';
import path from 'node:path';
import { AGENT_EFFORTS, AGENT_MODELS, type AgentModelChoice } from '@jerry/contracts/agents';
import { writeFileAtomic } from './fs-atomic.js';

/**
 * The model and reasoning effort of JERRY's read-only subagents live in the `model:` and `effort:`
 * frontmatter of the installed plugin's agent files (<plugin>/agents/<role>.md), where Claude Code
 * reads them. Core writes the user's choice there; nothing else in the file changes. inherit and
 * default remove the line, so the subagent follows the session.
 */

const FRONTMATTER = /^---(\r?\n)([\s\S]*?)\r?\n---(\r?\n|$)/;
const KEY_LINE = (key: string): RegExp => new RegExp(`^${key}:.*$`, 'm');

/** The frontmatter with model:/effort: set to the choice; null when the text has no frontmatter. */
export function withAgentModel(text: string, choice: AgentModelChoice): string | null {
  // Only the fixed enum values ever reach the file.
  if (!(AGENT_MODELS as readonly string[]).includes(choice.model) || !(AGENT_EFFORTS as readonly string[]).includes(choice.effort)) return null;
  const match = FRONTMATTER.exec(text);
  if (match === null) return null;
  const newline = match[1]!;
  let lines = match[2]!.split(/\r?\n/).filter((line) => !KEY_LINE('model').test(line) && !KEY_LINE('effort').test(line));
  if (choice.model !== 'inherit') lines = [...lines, `model: ${choice.model}`];
  if (choice.effort !== 'default') lines = [...lines, `effort: ${choice.effort}`];
  const frontmatter = `---${newline}${lines.join(newline)}${newline}---${match[3]!}`;
  return frontmatter + text.slice(match[0].length);
}

/** The model and effort an agent file sets now (inherit/default when it sets none). */
export function readAgentModel(text: string): AgentModelChoice | null {
  const match = FRONTMATTER.exec(text);
  if (match === null) return null;
  const value = (key: string): string | undefined => KEY_LINE(key).exec(match[2]!)?.[0].slice(key.length + 1).trim();
  const model = value('model') ?? 'inherit';
  const effort = value('effort') ?? 'default';
  return { model: model as AgentModelChoice['model'], effort: effort as AgentModelChoice['effort'] };
}

/** The text with the model:/effort: lines of its frontmatter removed: how doctor compares agent files. */
export function withoutAgentModel(text: string): string {
  const match = FRONTMATTER.exec(text);
  if (match === null) return text;
  const lines = match[2]!.split(/\r?\n/).filter((line) => !KEY_LINE('model').test(line) && !KEY_LINE('effort').test(line));
  return `---${match[1]!}${lines.join(match[1]!)}${match[1]!}---${match[3]!}${text.slice(match[0].length)}`;
}

/** The plugin file that carries a role's model: agents/<role>.md, or skills/<skill>/SKILL.md for a routine skill ("jerry:<skill>"). */
export function modelFileOf(pluginDir: string, role: string): string {
  return role.startsWith('jerry:') ? path.join(pluginDir, 'skills', role.slice('jerry:'.length), 'SKILL.md') : path.join(pluginDir, 'agents', `${role}.md`);
}

/**
 * Writes each role's choice into its file in the installed plugin (modelFileOf). Files already right
 * are left alone. Returns the problems (missing plugin, unreadable or unwritable files) instead of
 * throwing.
 */
export function applyAgentModels(pluginDir: string, choices: ReadonlyMap<string, AgentModelChoice>): string[] {
  const problems: string[] = [];
  if (!fs.existsSync(path.join(pluginDir, 'agents'))) return [`JERRY's plugin is not installed at ${pluginDir}; run "jerry install".`];
  for (const [role, choice] of choices) {
    const file = modelFileOf(pluginDir, role);
    try {
      const text = fs.readFileSync(file, 'utf8');
      const updated = withAgentModel(text, choice);
      if (updated === null) {
        problems.push(`${role}: ${file} has no frontmatter; left unchanged.`);
        continue;
      }
      if (updated !== text) writeFileAtomic(file, updated);
    } catch (error) {
      problems.push(`${role}: cannot update ${file} (${(error as Error).message}).`);
    }
  }
  return problems;
}
