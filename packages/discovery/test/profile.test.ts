import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fingerprintScan, scanRepository, staleParts } from '../src/index.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-profile-'));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

function repo(): string {
  const root = fs.mkdtempSync(path.join(base, 'r'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    'README.md': '# App',
    'CLAUDE.md': '# Rules',
    'docs/openapi.yaml': 'openapi: 3.1.0',
    '.github/workflows/ci.yml': 'on: push',
    'src/index.ts': 'export {};',
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

/** mtime resolution differs between file systems; a later mtime makes a change certain. */
function touch(file: string, content: string): void {
  fs.writeFileSync(file, content);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

describe('profile freshness', () => {
  it('is fresh right after a scan', () => {
    const root = repo();
    const scan = scanRepository(root);
    expect(staleParts(root, fingerprintScan(root, scan), scan.scannedAt)).toEqual([]);
  });

  it('marks exactly the parts whose sources changed', () => {
    const root = repo();
    const scan = scanRepository(root);
    const fingerprints = fingerprintScan(root, scan);
    touch(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }));
    expect(staleParts(root, fingerprints, scan.scannedAt)).toEqual(['stack']);
    touch(path.join(root, 'CLAUDE.md'), '# Rules v2');
    touch(path.join(root, 'docs/openapi.yaml'), 'openapi: 3.1.1');
    expect(staleParts(root, fingerprints, scan.scannedAt)).toEqual(['apiSchemas', 'instructions', 'stack']);
    touch(path.join(root, 'README.md'), '# App v2');
    expect(staleParts(root, fingerprints, scan.scannedAt)).toContain('docs');
  });

  it('notices new top-level files, removed files, and age', () => {
    const root = repo();
    const scan = scanRepository(root);
    const fingerprints = fingerprintScan(root, scan);
    fs.rmSync(path.join(root, '.github/workflows/ci.yml'));
    expect(staleParts(root, fingerprints, scan.scannedAt)).toContain('ci');
    fs.writeFileSync(path.join(root, 'composer.json'), '{}');
    const root2 = fs.statSync(root);
    fs.utimesSync(root, root2.atime, new Date(Date.now() + 5000));
    expect(staleParts(root, fingerprints, scan.scannedAt)).toContain('layout');
    expect(staleParts(root, fingerprintScan(root, scan), '2020-01-01T00:00:00.000Z')).toEqual(['age']);
  });
});
