import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { skillsListSchema } from '@jerry/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSkillStates, triggerText } from '../../apps/cli/src/skill-commands.js';
import { skillMd } from '../../packages/skills/test/zip-fixture.js';
import { ROOT, startCore, tempDir, TEST_CORE_ENV } from '../helpers/harness.js';

const CLI = path.join(ROOT, 'dist', 'cli', 'jerry.mjs');
const base = tempDir('skills-cli');
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

/** Core and the CLI both use an isolated CLAUDE_CONFIG_DIR: the real ~/.claude is never read or written. */
describe('jerry skill (CLI)', () => {
  it('lists and shows read-only, and refuses every change without an interactive terminal', async () => {
    const home = path.join(base, 'home');
    const claudeConfigDir = path.join(base, 'claude');
    fs.mkdirSync(path.join(claudeConfigDir, 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(claudeConfigDir, 'skills', 'mine', 'SKILL.md'), skillMd('mine', 'My own skill.'));
    const source = path.join(base, 'source', 'notes');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), skillMd('notes'));
    const env = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    const core = await startCore(home, env, { projects: [] });
    const run = (args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...TEST_CORE_ENV, JERRY_HOME: home, JERRY_NO_EMOJI: '1', ...env }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
      return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
    };
    try {
      const listed = run(['skill', 'list', '--json']);
      expect(listed.exitCode, listed.stderr).toBe(0);
      const list = skillsListSchema.parse(JSON.parse(listed.stdout));
      expect(list.skillsDir).toBe(path.join(claudeConfigDir, 'skills'));
      expect(list.added).toEqual([]);
      expect(list.personal.map((skill) => skill.name)).toEqual(['mine']);
      expect(run(['skill']).stdout).toContain('No skills added through JERRY yet');
      expect(run(['skill', 'show', 'mine']).stdout).toContain('My own skill.');

      for (const args of [['skill', 'add', source], ['skill', 'enable', 'notes'], ['skill', 'disable', 'notes'], ['skill', 'update', 'notes'], ['skill', 'states', 'notes', 'CODE_REVIEW'], ['skill', 'remove', 'notes']]) {
        const refused = run(args);
        expect(refused.exitCode, args.join(' ')).toBe(1);
        expect(refused.stderr, args.join(' ')).toContain('interactive terminal');
      }
      expect(fs.readdirSync(path.join(claudeConfigDir, 'skills'))).toEqual(['mine']);
      expect(fs.existsSync(path.join(claudeConfigDir, 'settings.json'))).toBe(false);
    } finally {
      await core.stop();
    }
  });

  it('reads task states from the command line: case and commas, refusing states JERRY cannot start a skill in', () => {
    expect(parseSkillStates(['code_review,REVERIFICATION', 'code_review'])).toEqual(['CODE_REVIEW', 'REVERIFICATION']);
    expect(() => parseSkillStates(['DONE'])).toThrow(/Not a state JERRY can start a skill in: DONE/);
    expect(() => parseSkillStates(['nope'])).toThrow(/Use: DISCOVERY/);
    expect(triggerText({ states: [], jerryTriggered: true })).toContain('Claude does not use it');
    expect(triggerText({ states: ['CODE_REVIEW'], jerryTriggered: true })).toBe('Started by JERRY in: CODE_REVIEW.');
    expect(triggerText({ states: ['CODE_REVIEW'], jerryTriggered: false })).toContain('Claude may still pick it on its own');
  });
});
