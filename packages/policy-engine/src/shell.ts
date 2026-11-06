/**
 * Conservative classifiers for shell commands.
 *
 * assessShellCommand answers "can this command modify files?". It is an allowlist: anything it
 * does not positively recognise as read-only is treated as write-capable, which only costs a
 * deviation warning.
 *
 * assessGitUsage answers "does this command change Git state?". Git changes are the user's job
 * alone (ADR 0003), so this check blocks; it stays strict but only looks at commands that
 * actually invoke Git tooling. Neither check is an OS sandbox.
 */

export type ShellDialect = 'bash' | 'powershell';

export interface ShellAssessment {
  readOnly: boolean;
  reason: string;
}

const BASH_READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'which',
  'file', 'stat', 'du', 'df', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'date',
  'whoami', 'sort', 'test', '[', 'true', 'false', 'cd', 'pushd', 'popd', 'git', 'node',
]);

const POWERSHELL_READ_ONLY = new Set([
  'get-childitem', 'gci', 'ls', 'dir', 'get-content', 'gc', 'cat', 'type', 'get-item', 'gi',
  'get-itemproperty', 'test-path', 'resolve-path', 'get-location', 'gl', 'pwd', 'select-string', 'sls',
  'measure-object', 'measure', 'select-object', 'select', 'where-object', 'sort-object', 'sort',
  'format-list', 'fl', 'format-table', 'ft', 'out-string', 'get-command', 'gcm', 'write-output', 'echo',
  'get-date', 'get-filehash', 'join-path', 'split-path', 'convertfrom-json', 'convertto-json',
  'set-location', 'cd', 'sl', 'push-location', 'pop-location', 'git', 'node',
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog',
  'cat-file', 'grep', 'branch', 'remote', 'config', 'rev-list', 'merge-base', 'name-rev', 'reflog',
]);

const GIT_BRANCH_READ_ONLY_ARGS = new Set(['--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '--no-color', '--color']);
/** `git remote <first-arg> ...` forms that only read. */
const GIT_REMOTE_READ_ONLY_FIRST_ARGS = new Set(['-v', '--verbose', 'show', 'get-url']);
const GIT_CONFIG_READ_ONLY_ARGS = new Set(['--get', '--get-all', '--list', '-l', '--show-origin', '--show-scope', '--global', '--local', '--system', '--name-only']);

/** Redirections that only discard output. */
const DISCARD_REDIRECTIONS = [/\b2>&1/g, /\d?>\s*\/dev\/null/g, /\d?>\s*\$null/gi, /\d?>\s*nul\b/gi];

export function assessShellCommand(command: string, dialect: ShellDialect): ShellAssessment {
  const trimmed = command.trim();
  if (trimmed === '') return { readOnly: false, reason: 'empty command' };
  if (/[\r\n]/.test(trimmed)) return writeCapable('multi-line command');

  // Constructs that execute nested commands. Checked on the raw text, ignoring quoting,
  // which is deliberately over-strict.
  if (trimmed.includes('$(') || trimmed.includes('`')) return writeCapable('command substitution or escape character');
  if (/[<>]\(/.test(trimmed)) return writeCapable('process substitution');
  if (dialect === 'powershell' && /[({]/.test(trimmed)) return writeCapable('PowerShell sub-expression or script block');

  const withoutDiscards = DISCARD_REDIRECTIONS.reduce((text, pattern) => text.replace(pattern, ' '), trimmed);
  const segments = splitTopLevel(withoutDiscards);
  if (segments === null) return writeCapable('unbalanced quotes');

  for (const segment of segments) {
    if (segment.redirectsOutput) return writeCapable('output redirection');
    const verdict = assessSegment(segment.words, dialect);
    if (!verdict.readOnly) return verdict;
  }
  return { readOnly: true, reason: 'all command segments are on the read-only allowlist' };
}

function writeCapable(reason: string): ShellAssessment {
  return { readOnly: false, reason };
}

function assessSegment(words: string[], dialect: ShellDialect): ShellAssessment {
  const [first, ...args] = words;
  if (first === undefined) return { readOnly: true, reason: 'empty segment' };
  if (first.includes('=')) return writeCapable(`environment assignment prefix "${first}"`);
  if (first.includes('/') || first.includes('\\')) return writeCapable(`explicit executable path "${first}"`);

  const name = first.toLowerCase().replace(/\.exe$/, '');
  const allowlist = dialect === 'powershell' ? POWERSHELL_READ_ONLY : BASH_READ_ONLY;
  if (!allowlist.has(name)) return writeCapable(`"${first}" is not on the read-only allowlist`);

  switch (name) {
    case 'git':
      return assessGit(args);
    case 'node':
      return args.length === 1 && (args[0] === '--version' || args[0] === '-v')
        ? { readOnly: true, reason: 'node version query' }
        : writeCapable('node can run arbitrary code');
    case 'find': {
      const dangerous = args.find((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg));
      return dangerous === undefined ? { readOnly: true, reason: 'find without actions' } : writeCapable(`find action ${dangerous}`);
    }
    case 'sort':
      return args.some((arg) => arg === '-o' || arg.startsWith('--output'))
        ? writeCapable('sort writes an output file')
        : { readOnly: true, reason: 'sort to stdout' };
    case 'rg':
      return args.some((arg) => arg.startsWith('--pre'))
        ? writeCapable('rg preprocessor runs a command')
        : { readOnly: true, reason: 'ripgrep search' };
    default:
      return { readOnly: true, reason: `"${name}" is read-only` };
  }
}

function assessGit(args: string[]): ShellAssessment {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === '--no-pager') {
      index += 1;
    } else if (arg === '-C') {
      index += 2;
    } else if (arg.startsWith('-')) {
      return writeCapable(`git global option ${arg} may change behaviour`);
    } else {
      break;
    }
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === undefined) return { readOnly: true, reason: 'bare git' };
  if (!GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return writeCapable(`git ${subcommand} is not read-only`);
  if (rest.some((arg) => arg.startsWith('--output') || arg === '-O' || arg.startsWith('--open-files-in-pager'))) {
    return writeCapable(`git ${subcommand} option writes or runs a pager`);
  }
  if (subcommand === 'branch' && !rest.every((arg) => GIT_BRANCH_READ_ONLY_ARGS.has(arg))) {
    return writeCapable('git branch with arguments can create or delete branches');
  }
  if (subcommand === 'remote' && rest.length > 0 && !GIT_REMOTE_READ_ONLY_FIRST_ARGS.has(rest[0]!)) {
    return writeCapable('git remote can modify remotes');
  }
  if (subcommand === 'config' && !rest.some((arg) => arg === '--get' || arg === '--get-all' || arg === '--list' || arg === '-l')) {
    return writeCapable('git config without --get/--list can write configuration');
  }
  if (subcommand === 'config' && !rest.every((arg) => GIT_CONFIG_READ_ONLY_ARGS.has(arg) || !arg.startsWith('-'))) {
    return writeCapable('git config option may write configuration');
  }
  return { readOnly: true, reason: `git ${subcommand} is read-only` };
}

interface Segment {
  words: string[];
  redirectsOutput: boolean;
}

/**
 * Splits on ; & && || | outside quotes and collects words. Returns null on unbalanced quotes.
 * Any ">" outside quotes marks the segment as redirecting output.
 */
function splitTopLevel(command: string): Segment[] | null {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = '';
  let wordStarted = false;
  let redirectsOutput = false;
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (wordStarted) words.push(word);
    word = '';
    wordStarted = false;
  };
  const endSegment = (): void => {
    endWord();
    segments.push({ words, redirectsOutput });
    words = [];
    redirectsOutput = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      wordStarted = true;
    } else if (char === ';' || char === '|' || char === '&') {
      // Backslash escapes are not interpreted: "\;" still splits, which can only make the
      // classifier stricter.
      endSegment();
      if ((char === '|' || char === '&') && command[i + 1] === char) i += 1;
    } else if (char === '>') {
      redirectsOutput = true;
      endWord();
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
      wordStarted = true;
    }
  }
  if (quote !== null) return null;
  endSegment();
  return segments.filter((segment) => segment.words.length > 0 || segment.redirectsOutput);
}

// ---------------------------------------------------------------------------
// Git usage (hard rule: only the user changes Git state)
// ---------------------------------------------------------------------------

export interface GitAssessment {
  /** True when the command changes, or may change, Git state (commits, refs, index, remotes, working tree via git). */
  mutating: boolean;
  reason: string;
}

/** Cheap pre-filter on raw text; ".git", "github" and "ghost" do not match. */
const GIT_TOOL_MENTION = /(?:^|[^a-z0-9_.-])(?:git(?:-[a-z0-9-]+)?|gh)(?:\.exe)?(?=$|[^a-z0-9_.-])/i;
const PACKAGE_MANAGER_VERSION = /\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+version\b/i;

const GH_READ_ONLY_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks']);
const GH_READ_ONLY_NOUNS = new Set(['pr', 'issue', 'repo', 'run', 'release', 'workflow']);

export function assessGitUsage(command: string, dialect: ShellDialect): GitAssessment {
  const trimmed = command.trim();
  const mentionsGit = GIT_TOOL_MENTION.test(trimmed);
  if (PACKAGE_MANAGER_VERSION.test(trimmed)) return gitMutation('"<package manager> version" creates a Git commit and tag');
  if (!mentionsGit) return { mutating: false, reason: 'no Git tooling invoked' };

  if (/[\r\n]/.test(trimmed)) return gitMutation('multi-line command invoking Git cannot be verified');
  if (trimmed.includes('$(') || trimmed.includes('`')) return gitMutation('Git invoked inside a command substitution');

  const segments = splitTopLevel(trimmed);
  if (segments === null) return gitMutation('Git command with unbalanced quotes cannot be verified');

  for (const { words } of segments) {
    const [first, ...args] = words;
    if (first === undefined) continue;
    const name = toolName(first);
    if (name === 'git') {
      const verdict = assessGit(args);
      if (!verdict.readOnly) return gitMutation(verdict.reason);
    } else if (name.startsWith('git-')) {
      return gitMutation(`${name} is a Git extension that can change repository state`);
    } else if (name === 'gh') {
      if (!isReadOnlyGh(args)) return gitMutation(`gh ${args.slice(0, 2).join(' ')} can change remote or local Git state`);
    } else if (words.slice(1).some((word) => word.split(/\s+/).some((token) => isGitToolToken(token)))) {
      return gitMutation(`Git invoked indirectly through "${first}"`);
    }
  }
  return { mutating: false, reason: `read-only Git usage (${dialect})` };
}

function gitMutation(reason: string): GitAssessment {
  return { mutating: true, reason };
}

/** Executable name of a word: basename, lower-case, without .exe and surrounding punctuation. */
function toolName(word: string): string {
  const stripped = word.replace(/^[({[@&$;,]+|[)}\];,]+$/g, '');
  const base = stripped.split(/[\\/]/).at(-1) ?? stripped;
  return base.toLowerCase().replace(/\.exe$/, '');
}

function isGitToolToken(token: string): boolean {
  const name = toolName(token);
  return name === 'git' || name === 'gh' || /^git-[a-z0-9-]+$/.test(name);
}

function isReadOnlyGh(args: string[]): boolean {
  const [noun, verb] = args;
  if (noun === '--version' || noun === 'version') return true;
  if (noun === 'auth' && verb === 'status') return true;
  return noun !== undefined && verb !== undefined && GH_READ_ONLY_NOUNS.has(noun) && GH_READ_ONLY_VERBS.has(verb);
}
