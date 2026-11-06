import { describe, expect, it } from 'vitest';
import { exitCodeOf, isTestCommand, selectTargetedTests, testCandidates } from '../src/index.js';

describe('targeted tests', () => {
  it('finds test files by the usual conventions', () => {
    expect(testCandidates('src/auth/login.ts')).toEqual(expect.arrayContaining(['src/auth/login.test.ts', 'src/auth/__tests__/login.test.ts', 'tests/auth/login.test.ts']));
    expect(testCandidates('app/models/user.py')).toEqual(expect.arrayContaining(['app/models/test_user.py', 'tests/models/test_user.py']));
    expect(testCandidates('pkg/store/cache.go')).toEqual(['pkg/store/cache_test.go']);
    expect(testCandidates('src/main/java/x/Order.java')).toEqual(['src/test/java/x/OrderTest.java']);
    expect(testCandidates('src/a.test.ts')).toEqual(['src/a.test.ts']);
    expect(testCandidates('README.md')).toEqual([]);
  });

  it('selects existing tests, lists changed files without any, and narrows the project command', () => {
    const existing = new Set(['src/auth/login.test.ts', 'tests/models/test_user.py']);
    const exists = (file: string) => existing.has(file);
    const js = selectTargetedTests(['src/auth/login.ts', 'src/auth/logout.ts', 'docs/x.md'], exists, 'corepack pnpm run test');
    expect(js).toEqual({ files: ['src/auth/login.test.ts'], untested: ['src/auth/logout.ts'], command: 'corepack pnpm run test -- src/auth/login.test.ts' });
    expect(selectTargetedTests(['app/models/user.py'], exists, 'pytest').command).toBe('pytest tests/models/test_user.py');
    expect(selectTargetedTests(['src/auth/login.ts'], exists, 'make check').command).toBeNull();
    expect(selectTargetedTests(['src/auth/logout.ts'], exists, 'npm test').command).toBeNull();
    expect(selectTargetedTests(['pkg/a/b.go'], (file) => file === 'pkg/a/b_test.go', 'go test ./...').command).toBe('go test ./pkg/a');
  });

  it('recognises test commands and exit codes', () => {
    for (const command of ['npx vitest run', 'corepack pnpm test', 'npm run test -- a.test.ts', 'python -m pytest -q', 'go test ./...', 'dotnet test', './gradlew test']) expect(isTestCommand(command), command).toBe(true);
    for (const command of ['npm install', 'git status', 'node build.mjs', 'pnpm testing-library']) expect(isTestCommand(command), command).toBe(false);
    expect(isTestCommand('make check', ['make check'])).toBe(true);
    expect(exitCodeOf('Error: Exit code 1\nFAIL src/a.test.ts')).toBe(1);
    expect(exitCodeOf('timed out')).toBeNull();
  });
});
