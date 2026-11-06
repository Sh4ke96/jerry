import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fingerprintFiles, gitReader, parseStatus, stripCredentials } from '../../apps/core/src/git-reader.js';
import { createFixtureRepo, snapshotRepo, tempDir } from '../helpers/harness.js';

const IDENTITY = ['-c', 'user.name=JERRY Test', '-c', 'user.email=jerry-test@example.invalid', '-c', 'commit.gpgsign=false'];
const base = tempDir('git-reader');
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

/** Every byte of the repository, .git included. */
const bytes = (dir: string) => snapshotRepo(dir).files;

describe('read-only Git reader', () => {
  it('reads branch, HEAD and the user’s uncommitted work without changing a byte of the repository', async () => {
    const repo = createFixtureRepo(path.join(base, 'dirty'));
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    execFileSync('git', ['-C', repo, 'add', 'staged.txt']);
    const before = bytes(repo);

    const snapshot = await gitReader.snapshot(repo);
    const changed = await gitReader.changedSince(repo, snapshot.head);
    fingerprintFiles(repo, changed);

    expect(snapshot).toMatchObject({ branch: 'main', upstream: null, remoteUrl: null, staged: ['staged.txt'], unstaged: ['src/app.ts'], untracked: ['notes.txt'], truncated: false });
    expect(snapshot.head).toMatch(/^[0-9a-f]{40}$/);
    expect(changed).toEqual(['notes.txt', 'src/app.ts', 'staged.txt']);
    expect(bytes(repo)).toEqual(before);
  });

  it('sees committed changes since a baseline, a detached HEAD and a repository without commits', async () => {
    const repo = createFixtureRepo(path.join(base, 'history'));
    const baseline = await gitReader.snapshot(repo);
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later\n');
    execFileSync('git', [...IDENTITY, '-C', repo, 'add', 'later.txt']);
    execFileSync('git', [...IDENTITY, '-C', repo, 'commit', '-q', '-m', 'later']);
    // A committed change is still a change since the baseline.
    expect(await gitReader.changedSince(repo, baseline.head)).toEqual(['later.txt', 'notes.txt', 'src/app.ts']);

    execFileSync('git', ['-C', repo, 'checkout', '-q', '--detach']);
    expect(await gitReader.snapshot(repo)).toMatchObject({ branch: null });

    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty);
    execFileSync('git', ['init', '-q', '-b', 'main', empty]);
    fs.writeFileSync(path.join(empty, 'first.txt'), 'x\n');
    expect(await gitReader.snapshot(empty)).toMatchObject({ head: null, branch: 'main', untracked: ['first.txt'] });
    expect(await gitReader.changedSince(empty, null)).toEqual(['first.txt']);
  });

  it('never keeps credentials from a remote URL', async () => {
    const secret = ['ghp', 'x'.repeat(20)].join('_');
    expect(stripCredentials(`https://user:${secret}@github.com/a/b.git\n`)).toBe('https://github.com/a/b.git');
    expect(stripCredentials('git@github.com:a/b.git')).toBe('git@github.com:a/b.git');
    const repo = createFixtureRepo(path.join(base, 'remote'));
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', `https://${secret}@example.invalid/a/b.git`]);
    const snapshot = await gitReader.snapshot(repo);
    expect(snapshot.remoteUrl).toBe('https://example.invalid/a/b.git');
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('parses porcelain status entries and fingerprints file contents', () => {
    expect(parseStatus('M  a.ts\0 M b.ts\0MM c.ts\0?? d.ts\0D  e.ts\0')).toEqual({ staged: ['a.ts', 'c.ts', 'e.ts'], unstaged: ['b.ts', 'c.ts'], untracked: ['d.ts'], truncated: false });
    const dir = path.join(base, 'files');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    const first = fingerprintFiles(dir, ['a.txt', 'gone.txt']);
    expect(first['gone.txt']).toBe('missing');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two');
    expect(fingerprintFiles(dir, ['a.txt'])['a.txt']).not.toBe(first['a.txt']);
  });
});
