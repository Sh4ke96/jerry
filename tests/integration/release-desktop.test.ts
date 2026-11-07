import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JERRY_VERSION } from '@jerry/contracts';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The release package carries the Jerry desktop app installer when one was built, with checksums like
 * every other file, and is built as before without one. A small fake installer stands in for the
 * real one, so these tests need no Rust toolchain.
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RELEASE_SCRIPT = path.join(ROOT, 'scripts', 'release.mjs');
const INSTALLER = `Jerry-${JERRY_VERSION}-x64-setup.exe`;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A dist directory with the four parts the release copies, each holding one small file. */
function stagedDist(): string {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-release-'));
  temps.push(dist);
  for (const part of ['cli', 'core', 'plugin', 'evals']) {
    fs.mkdirSync(path.join(dist, part), { recursive: true });
    fs.writeFileSync(path.join(dist, part, `${part}.txt`), `${part}\n`);
  }
  return dist;
}

function addInstaller(dist: string, name: string): void {
  fs.mkdirSync(path.join(dist, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'desktop', name), 'fake installer\n');
}

function release(dist: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [RELEASE_SCRIPT, '--skip-build', '--dist', dist], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const stage = (dist: string): string => path.join(dist, 'release', `jerry-${JERRY_VERSION}`);

describe('release package and Jerry desktop app', () => {
  it('includes a built installer with its checksum', () => {
    const dist = stagedDist();
    addInstaller(dist, INSTALLER);
    const result = release(dist);
    expect(result.status, result.output).toBe(0);

    const manifest = JSON.parse(fs.readFileSync(path.join(stage(dist), 'manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
    expect(manifest.files.map((file) => file.path)).toContain(`desktop/${INSTALLER}`);
    expect(fs.readFileSync(path.join(stage(dist), 'SHA256SUMS'), 'utf8')).toContain(`  desktop/${INSTALLER}`);
    expect(fs.readFileSync(path.join(stage(dist), 'RELEASE-NOTES.md'), 'utf8')).toContain('Jerry, the desktop app (optional)');
    expect(fs.existsSync(path.join(dist, 'release', `jerry-${JERRY_VERSION}.tar.gz`))).toBe(true);
  });

  it('builds without an installer, and says so in the notes', () => {
    const dist = stagedDist();
    const result = release(dist);
    expect(result.status, result.output).toBe(0);
    expect(fs.existsSync(path.join(stage(dist), 'desktop'))).toBe(false);
    expect(fs.readFileSync(path.join(stage(dist), 'RELEASE-NOTES.md'), 'utf8')).toContain('Not included in this package');
  });

  it('refuses an installer of another version', () => {
    const dist = stagedDist();
    addInstaller(dist, 'Jerry-0.0.1-x64-setup.exe');
    const result = release(dist);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('installer of another version');
  });
});
