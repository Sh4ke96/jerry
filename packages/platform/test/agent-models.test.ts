import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyAgentModels, readAgentModel, withAgentModel, withoutAgentModel } from '../src/index.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-agent-models-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const AGENT = ['---', 'name: jerry-quality-analyst', 'description: Read-only analyst. model: is not a key here', 'tools: Read, Grep', '---', '', '# Body', 'model: stays in the body', ''].join('\n');

describe('model and effort in an agent file', () => {
  it('adds model and effort to the frontmatter and keeps everything else', () => {
    const updated = withAgentModel(AGENT, { model: 'claude-haiku-5-5', effort: 'low' })!;
    expect(updated).toContain('tools: Read, Grep\nmodel: claude-haiku-5-5\neffort: low\n---\n');
    expect(updated).toContain('description: Read-only analyst. model: is not a key here');
    expect(updated.endsWith('# Body\nmodel: stays in the body\n')).toBe(true);
    expect(readAgentModel(updated)).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
  });

  it('replaces earlier lines instead of adding more', () => {
    const once = withAgentModel(AGENT, { model: 'claude-opus-5-5', effort: 'high' })!;
    const twice = withAgentModel(once, { model: 'claude-sonnet-5-5', effort: 'medium' })!;
    expect(twice.match(/^model:/gm)).toHaveLength(2); // frontmatter + the body line
    expect(readAgentModel(twice)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
  });

  it('removes the lines for inherit and default', () => {
    const set = withAgentModel(AGENT, { model: 'claude-opus-5-5', effort: 'max' })!;
    const cleared = withAgentModel(set, { model: 'inherit', effort: 'default' })!;
    expect(cleared).toBe(AGENT);
    expect(readAgentModel(cleared)).toEqual({ model: 'inherit', effort: 'default' });
  });

  it('keeps Windows line endings', () => {
    const crlf = AGENT.replace(/\n/g, '\r\n');
    expect(withAgentModel(crlf, { model: 'claude-opus-5-5', effort: 'high' })).toContain('tools: Read, Grep\r\nmodel: claude-opus-5-5\r\neffort: high\r\n---\r\n');
  });

  it('refuses values outside the enums and files without frontmatter', () => {
    expect(withAgentModel(AGENT, { model: 'evil\nhooks: x' as never, effort: 'high' })).toBeNull();
    expect(withAgentModel('# no frontmatter', { model: 'claude-opus-5-5', effort: 'high' })).toBeNull();
  });

  it('compares files without the model and effort lines', () => {
    expect(withoutAgentModel(withAgentModel(AGENT, { model: 'claude-opus-5-5', effort: 'high' })!)).toBe(AGENT);
  });
});

describe('applyAgentModels', () => {
  it('writes each role into the plugin folder and reports missing files', () => {
    const plugin = path.join(base, 'plugin');
    fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'agents', 'jerry-quality-analyst.md'), AGENT);
    const problems = applyAgentModels(
      plugin,
      new Map([
        ['jerry-quality-analyst', { model: 'claude-haiku-5-5', effort: 'low' }],
        ['jerry-risk-analyst', { model: 'claude-opus-5-5', effort: 'high' }],
      ] as const),
    );
    expect(readAgentModel(fs.readFileSync(path.join(plugin, 'agents', 'jerry-quality-analyst.md'), 'utf8'))).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('jerry-risk-analyst');
  });

  it('tells when the plugin is not installed', () => {
    expect(applyAgentModels(path.join(base, 'missing'), new Map())[0]).toContain('jerry install');
  });
});
