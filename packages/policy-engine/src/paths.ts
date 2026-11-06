import path from 'node:path';

/**
 * Path handling for policy decisions. All comparisons go through comparablePath so that
 * Windows case-insensitivity, separator variants, MSYS paths (/c/...) and Unicode
 * normalization cannot be used to slip a write past a scope check.
 */

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Converts Git Bash/MSYS style "/c/Users/x" to "C:/Users/x" on Windows. */
function fromMsysPath(input: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return input;
  const match = /^\/([a-zA-Z])(\/.*)?$/.exec(input);
  if (match === null) return input;
  return `${match[1]!.toUpperCase()}:${match[2] ?? '/'}`;
}

function stripWin32LongPathPrefix(input: string): string {
  return input.startsWith('\\\\?\\') && !input.startsWith('\\\\?\\UNC\\') ? input.slice(4) : input;
}

/** Absolute, NFC-normalized path with forward slashes and no trailing slash (keeps original case). */
export function absolutePath(target: string, cwd: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  const cleanTarget = fromMsysPath(stripWin32LongPathPrefix(target.normalize('NFC')), platform);
  const cleanCwd = fromMsysPath(stripWin32LongPathPrefix(cwd.normalize('NFC')), platform);
  const resolved = api.resolve(cleanCwd, cleanTarget);
  const forward = platform === 'win32' ? resolved.replaceAll('\\', '/') : resolved;
  return forward.length > 1 && forward.endsWith('/') && !/^[A-Za-z]:\/$/.test(forward) ? forward.slice(0, -1) : forward;
}

/** Key for equality/containment checks: absolutePath, lower-cased on Windows. */
export function comparablePath(target: string, cwd: string, platform: NodeJS.Platform): string {
  const absolute = absolutePath(target, cwd, platform);
  return platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** True when child equals parent or lies underneath it. Both must already be comparable paths. */
export function isComparableInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(prefix);
}

/** Repo-relative path with forward slashes, or null when target is outside root. */
export function relativeInside(target: string, root: string, platform: NodeJS.Platform): string | null {
  const absoluteTarget = absolutePath(target, root, platform);
  const absoluteRoot = absolutePath(root, root, platform);
  const key = platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (!isComparableInside(key(absoluteTarget), key(absoluteRoot))) return null;
  if (absoluteTarget.length === absoluteRoot.length) return '';
  const offset = absoluteRoot.endsWith('/') ? absoluteRoot.length : absoluteRoot.length + 1;
  return absoluteTarget.slice(offset);
}

/**
 * Glob for plan scopes: "**" matches any characters including "/", "*" and "?" never cross "/".
 * A pattern ending with "/" matches everything below that directory.
 * Every other character is literal; there are no brace or character-class expansions,
 * so a scope means exactly what it says.
 */
export function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  const normalized = glob.normalize('NFC').replaceAll('\\', '/').replace(/^\.\//, '');
  const pattern = normalized.endsWith('/') ? `${normalized}**` : normalized;
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        const followedBySlash = pattern[i + 2] === '/';
        source += followedBySlash ? '(?:.*/)?' : '.*';
        i += followedBySlash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'iu' : 'u');
}

export function matchesAnyGlob(relativePath: string, globs: readonly string[], caseInsensitive: boolean): boolean {
  const candidate = relativePath.normalize('NFC');
  return globs.some((glob) => globToRegExp(glob, caseInsensitive).test(candidate));
}
