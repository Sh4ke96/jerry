import { describe, expect, it } from 'vitest';
import { testCommandFor } from '../src/test-runs.js';

/** Profile commands in manifest order, as the scanner lists them (this repository's shape). */
const COMMANDS = [
  { kind: 'build', run: 'corepack pnpm run build (in apps/desktop)', source: 'apps/desktop/package.json scripts.build' },
  { kind: 'test', run: 'corepack pnpm run test (in apps/desktop)', source: 'apps/desktop/package.json scripts.test' },
  { kind: 'test', run: 'cargo test (in apps/desktop/src-tauri)', source: 'apps/desktop/src-tauri/Cargo.toml (convention)' },
  { kind: 'test', run: 'corepack pnpm run test', source: 'package.json scripts.test' },
];

describe('the test command for the changed files', () => {
  it("takes the repository root's command for changes outside the packages, not the first one found", () => {
    expect(testCommandFor(COMMANDS, ['apps/core/src/app.ts', 'packages/evals/src/runner.ts'])).toBe('corepack pnpm run test');
    expect(testCommandFor(COMMANDS, [])).toBe('corepack pnpm run test');
  });

  it("takes the deepest package's command when every change lies inside it", () => {
    expect(testCommandFor(COMMANDS, ['apps/desktop/src/main.ts'])).toBe('corepack pnpm run test (in apps/desktop)');
    expect(testCommandFor(COMMANDS, ['apps/desktop/src-tauri/src/tray.rs'])).toBe('cargo test (in apps/desktop/src-tauri)');
    // Changes in two packages: the root's.
    expect(testCommandFor(COMMANDS, ['apps/desktop/src/main.ts', 'README.md'])).toBe('corepack pnpm run test');
  });

  it('falls back to the first test command without a root one, and to none without any', () => {
    expect(testCommandFor(COMMANDS.slice(0, 3), ['src/a.ts'])).toBe('corepack pnpm run test (in apps/desktop)');
    expect(testCommandFor([{ kind: 'build', run: 'make', source: 'Makefile target build' }], ['a'])).toBeNull();
  });
});
