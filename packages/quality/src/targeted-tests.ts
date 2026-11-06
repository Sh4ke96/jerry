import { isTestFile } from './engine.js';

/**
 * Targeted tests: which test files belong to the files that changed, and the
 * command that runs only them. JERRY suggests; Claude runs it. JERRY never runs project commands.
 */

const SOURCE_ROOTS = /^(src|lib|app|source|pkg|internal)\//;

/** Candidate test files for one changed source file, by the common conventions. */
export function testCandidates(file: string): string[] {
  const normalized = file.replaceAll('\\', '/');
  if (isTestFile(normalized)) return [normalized];
  const match = /^(.*?)([^/]+)\.([cm]?[jt]sx?|py|go|rb|php|java|kt|cs)$/.exec(normalized);
  if (match === null) return [];
  const [, directory = '', name = '', extension = ''] = match;
  const inner = directory.replace(SOURCE_ROOTS, '');
  switch (extension) {
    case 'py':
      return [`${directory}test_${name}.py`, `${directory}${name}_test.py`, `tests/${inner}test_${name}.py`, `tests/test_${name}.py`, `test/test_${name}.py`];
    case 'go':
      return [`${directory}${name}_test.go`];
    case 'rb':
      return [`spec/${inner}${name}_spec.rb`, `test/${inner}${name}_test.rb`];
    case 'php':
      return [`tests/${inner}${capitalize(name)}Test.php`, `tests/Unit/${capitalize(name)}Test.php`, `tests/Feature/${capitalize(name)}Test.php`];
    case 'java':
    case 'kt':
      return [`${directory.replace('src/main/', 'src/test/')}${name}Test.${extension}`];
    case 'cs':
      return [`${directory}${name}Tests.cs`, `tests/${inner}${name}Tests.cs`];
    default: {
      const base = extension.replace(/^[cm]/, '');
      const variants = [...new Set([base, base.replace('x', ''), 'ts', 'js'])];
      return variants.flatMap((ext) => [
        `${directory}${name}.test.${ext}`,
        `${directory}${name}.spec.${ext}`,
        `${directory}__tests__/${name}.test.${ext}`,
        `tests/${inner}${name}.test.${ext}`,
        `test/${inner}${name}.test.${ext}`,
        `tests/unit/${inner}${name}.test.${ext}`,
      ]);
    }
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export interface TargetedTests {
  /** Existing test files for the changed files, repo-relative. */
  files: string[];
  /** Changed source files without any test file found. */
  untested: string[];
  /** The project's test command limited to those files, or null when it cannot be narrowed. */
  command: string | null;
}

/**
 * @param exists tells whether a repo-relative file exists (Core checks the disk, read-only).
 * @param testCommand the project's test command as it runs here (from the profile), if known.
 */
export function selectTargetedTests(changed: readonly string[], exists: (file: string) => boolean, testCommand: string | null): TargetedTests {
  const files = new Set<string>();
  const untested: string[] = [];
  for (const file of changed) {
    const candidates = testCandidates(file);
    if (candidates.length === 0) continue;
    const found = candidates.filter((candidate) => exists(candidate));
    if (found.length === 0) untested.push(file);
    for (const candidate of found) files.add(candidate);
  }
  const list = [...files].sort();
  return { files: list, untested: untested.sort(), command: narrowCommand(testCommand, list) };
}

/** Adds the files to the project's command where the runner takes file arguments. */
function narrowCommand(command: string | null, files: readonly string[]): string | null {
  if (command === null || files.length === 0) return null;
  const quoted = files.map((file) => (/\s/.test(file) ? `"${file}"` : file)).join(' ');
  // Package-manager scripts pass arguments after "--" to vitest, jest, mocha and similar.
  if (/^(corepack\s+)?(npm|pnpm|yarn|bun)\b/.test(command)) return `${command} -- ${quoted}`;
  if (/\b(pytest|vitest|jest|mocha|phpunit|rspec|python -m pytest)\b/.test(command)) return `${command} ${quoted}`;
  if (/^go test\b/.test(command)) return `go test ${[...new Set(files.map((file) => `./${file.replace(/\/[^/]+$/, '')}`))].join(' ')}`;
  return null;
}

const TEST_RUNNERS = /\b(vitest|jest|mocha|pytest|phpunit|rspec|go test|cargo test|dotnet test|mvn(\s+\S+)*\s+test|gradlew?\s+test|(npm|pnpm|yarn|bun)(\s+run)?\s+test)\b/;

/** Whether a shell command runs tests: a known runner, or the project's own test command. */
export function isTestCommand(command: string, projectTestCommands: readonly string[] = []): boolean {
  const normalized = command.trim().replace(/\s+/g, ' ');
  return TEST_RUNNERS.test(normalized) || projectTestCommands.some((known) => known !== '' && normalized.includes(known.trim()));
}

/** "Exit code 1" in a failed tool call's error text. */
export function exitCodeOf(error: string | null | undefined): number | null {
  const match = /exit code[:\s]+(-?\d+)/i.exec(error ?? '');
  return match === null ? null : Number(match[1]);
}
