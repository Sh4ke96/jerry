import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BUILT_IN_RULES } from '@jerry/quality';

/**
 * What an eval run measured: hashes of the plugin's skills, agents and hooks, and of the
 * quality rules' ids and versions, plus the skills the user added through JERRY (Claude Code loads
 * them in every session, so they can change what the evals see). When one of them differs from the
 * baseline's, the evals should run again (every plugin, skill or rule change may trigger its suite).
 */

export interface JerryFingerprint {
  /** addedSkills is absent while no skill was added, so older baselines stay comparable. */
  components: { skills: string; agents: string; hooks: string; rules: string; addedSkills?: string };
  total: string;
}

/** A skill the user added through JERRY: its name and the hash of its files. */
export interface AddedSkillFingerprint {
  name: string;
  contentHash: string;
}

function hashFiles(root: string, sub: string): string {
  const dir = path.join(root, sub);
  const hash = createHash('sha256');
  if (fs.existsSync(dir)) {
    for (const entry of (fs.readdirSync(dir, { recursive: true }) as string[]).sort()) {
      const file = path.join(dir, entry);
      if (!fs.statSync(file).isFile()) continue;
      hash.update(entry.replaceAll('\\', '/'));
      // Line endings do not change what a skill says.
      hash.update(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/** Order-independent hash of the added skills; null when there are none. */
export function addedSkillsHash(skills: readonly AddedSkillFingerprint[]): string | null {
  if (skills.length === 0) return null;
  const lines = skills.map((skill) => `${skill.name}@${skill.contentHash}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export function jerryFingerprint(pluginDir: string, addedSkills: readonly AddedSkillFingerprint[] = []): JerryFingerprint {
  const added = addedSkillsHash(addedSkills);
  const components: JerryFingerprint['components'] = {
    skills: hashFiles(pluginDir, 'skills'),
    agents: hashFiles(pluginDir, 'agents'),
    hooks: hashFiles(pluginDir, 'hooks'),
    rules: createHash('sha256')
      .update(BUILT_IN_RULES.map((rule) => `${rule.id}@${rule.version}`).sort().join('\n'))
      .digest('hex')
      .slice(0, 16),
    ...(added === null ? {} : { addedSkills: added }),
  };
  return { total: createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 16), components };
}

/** The components that changed since the baseline was measured. */
export function changedComponents(baseline: JerryFingerprint | null, now: JerryFingerprint): string[] {
  if (baseline === null) return Object.keys(now.components);
  const keys = new Set([...Object.keys(baseline.components), ...Object.keys(now.components)]) as Set<keyof JerryFingerprint['components']>;
  return [...keys].filter((key) => baseline.components[key] !== now.components[key]);
}
