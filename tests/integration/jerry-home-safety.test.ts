import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CORE, createFixtureRepo, snapshotRepo, tempDir } from '../helpers/harness.js';

/** ADR 0002: JERRY never writes into a repository, even when JERRY_HOME is misconfigured to point into one. */
describe('JERRY_HOME inside a repository', () => {
  const base = tempDir('home-safety');
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('Core refuses to start and creates nothing in the repository', () => {
    const repo = createFixtureRepo(path.join(base, 'repo'));
    const before = snapshotRepo(repo);

    const result = spawnSync(process.execPath, [CORE], {
      env: { ...process.env, JERRY_HOME: path.join(repo, 'src', '.jerry') },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is inside the Git repository');
    expect(snapshotRepo(repo)).toEqual(before);
  });
});
