import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { jerryPaths, readProjectsFile, writeProjectsFile } from '../src/index.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-projects-file-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('JERRY_HOME/run/projects.json', () => {
  it('round-trips the project roots', () => {
    const home = path.join(base, 'a');
    writeProjectsFile(home, ['D:/Work/shop', 'D:/Work/api']);
    expect(readProjectsFile(home)).toEqual(['D:/Work/shop', 'D:/Work/api']);
    expect(JSON.parse(fs.readFileSync(jerryPaths(home).projectsFile, 'utf8'))).toEqual({ version: 1, roots: ['D:/Work/shop', 'D:/Work/api'] });
    writeProjectsFile(home, []);
    expect(readProjectsFile(home)).toEqual([]);
  });

  it('is unknown (null) when missing, unreadable or of another shape', () => {
    const home = path.join(base, 'b');
    expect(readProjectsFile(home)).toBeNull();
    fs.mkdirSync(jerryPaths(home).runDir, { recursive: true });
    for (const content of ['not json', '[]', '{"version":2,"roots":[]}', '{"version":1}', '{"version":1,"roots":["ok",""]}', '{"version":1,"roots":[1]}', 'null']) {
      fs.writeFileSync(jerryPaths(home).projectsFile, content);
      expect(readProjectsFile(home), content).toBeNull();
    }
  });
});
