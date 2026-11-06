import { describe, expect, it } from 'vitest';
import { absolutePath, comparablePath, globToRegExp, isComparableInside, matchesAnyGlob, relativeInside } from '../src/paths.js';

describe('absolutePath (win32)', () => {
  const cwd = 'D:\\Work\\Repo';

  it('resolves relative paths against cwd and uses forward slashes', () => {
    expect(absolutePath('src\\a.ts', cwd, 'win32')).toBe('D:/Work/Repo/src/a.ts');
  });

  it('converts Git Bash /d/... paths', () => {
    expect(absolutePath('/d/Work/Repo/src/a.ts', cwd, 'win32')).toBe('D:/Work/Repo/src/a.ts');
  });

  it('collapses .. segments so they cannot escape a scope check', () => {
    expect(absolutePath('src/../../Other/x.ts', cwd, 'win32')).toBe('D:/Work/Other/x.ts');
  });

  it('strips the \\\\?\\ long-path prefix', () => {
    expect(absolutePath('\\\\?\\D:\\Work\\Repo\\a.ts', cwd, 'win32')).toBe('D:/Work/Repo/a.ts');
  });

  it('normalizes Unicode to NFC', () => {
    const decomposed = 'Zo\u0301ł.ts';
    expect(absolutePath(decomposed, cwd, 'win32')).toBe('D:/Work/Repo/Zół.ts');
  });
});

describe('containment', () => {
  it('is case-insensitive on Windows', () => {
    const child = comparablePath('d:/work/REPO/src/a.ts', 'C:/', 'win32');
    const parent = comparablePath('D:\\Work\\Repo', 'C:/', 'win32');
    expect(isComparableInside(child, parent)).toBe(true);
  });

  it('does not treat a sibling with a common prefix as inside', () => {
    expect(isComparableInside('d:/work/repo-other/a.ts', 'd:/work/repo')).toBe(false);
  });

  it('computes repo-relative paths', () => {
    expect(relativeInside('D:/Work/Repo/src/a.ts', 'd:\\work\\repo', 'win32')).toBe('src/a.ts');
    expect(relativeInside('D:/Work/Other/a.ts', 'D:/Work/Repo', 'win32')).toBeNull();
  });
});

describe('globToRegExp', () => {
  it('"**" crosses directories, "*" does not', () => {
    expect(matchesAnyGlob('src/a/b/c.ts', ['src/**'], false)).toBe(true);
    expect(matchesAnyGlob('src/a/b/c.ts', ['src/*'], false)).toBe(false);
    expect(matchesAnyGlob('src/c.ts', ['src/*.ts'], false)).toBe(true);
  });

  it('"**/" matches zero or more directories', () => {
    expect(matchesAnyGlob('test/a.test.ts', ['**/*.test.ts'], false)).toBe(true);
    expect(matchesAnyGlob('a.test.ts', ['**/*.test.ts'], false)).toBe(true);
  });

  it('a trailing slash means everything below the directory', () => {
    expect(matchesAnyGlob('docs/guide/x.md', ['docs/'], false)).toBe(true);
    expect(matchesAnyGlob('docs', ['docs/'], false)).toBe(false);
  });

  it('treats regex metacharacters literally', () => {
    expect(globToRegExp('src/(a)+.ts', false).test('src/(a)+.ts')).toBe(true);
    expect(globToRegExp('src/(a)+.ts', false).test('src/aa.ts')).toBe(false);
  });

  it('honours case-insensitivity only when asked', () => {
    expect(matchesAnyGlob('SRC/A.ts', ['src/**'], true)).toBe(true);
    expect(matchesAnyGlob('SRC/A.ts', ['src/**'], false)).toBe(false);
  });
});
