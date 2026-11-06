import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDashboard } from '../src/static-files.js';

describe('dashboard files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-dashboard-'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/index-old.js"></script>');
  fs.writeFileSync(path.join(dir, 'assets', 'index-old.js'), 'old();');
  fs.writeFileSync(path.join(dir, 'assets', 'notes.txt'), 'not served');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('serves the files of its own start, even after the directory is replaced by a newer build', () => {
    const dashboard = loadDashboard(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="/assets/index-new.js"></script>');
    fs.writeFileSync(path.join(dir, 'assets', 'index-new.js'), 'new();');
    fs.rmSync(path.join(dir, 'assets', 'index-old.js'));

    expect(dashboard.read('', 'index.html')?.body.toString()).toContain('index-old.js');
    expect(dashboard.read('assets', 'index-old.js')).toMatchObject({ contentType: 'text/javascript; charset=utf-8' });
    expect(dashboard.read('assets', 'index-new.js')).toBeNull();
    // A restart picks up the new build.
    expect(loadDashboard(dir).read('assets', 'index-new.js')?.body.toString()).toBe('new();');
  });

  it('refuses unknown types, unsafe names and a missing directory', () => {
    const dashboard = loadDashboard(dir);
    expect(dashboard.read('assets', 'notes.txt')).toBeNull();
    expect(dashboard.read('assets', '..%2Findex.html')).toBeNull();
    expect(dashboard.read('assets', '.env')).toBeNull();
    expect(loadDashboard(undefined).read('', 'index.html')).toBeNull();
    expect(loadDashboard(path.join(dir, 'missing')).read('', 'index.html')).toBeNull();
  });
});
