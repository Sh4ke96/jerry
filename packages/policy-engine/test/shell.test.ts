import { describe, expect, it } from 'vitest';
import { assessGitUsage, assessShellCommand, shellWriteTargets } from '../src/shell.js';

describe('assessGitUsage', () => {
  it.each([
    ['git status', 'bash'],
    ['git diff --stat', 'bash'],
    ['git log --oneline -5 | head -3', 'bash'],
    ['git -C ../other show HEAD:README.md', 'bash'],
    ['git branch --show-current', 'powershell'],
    ['git config --get user.name', 'bash'],
    ['git diff > changes.patch', 'bash'],
    ['ls .git', 'bash'],
    ['cat .github/workflows/ci.yml', 'bash'],
    ['npm test', 'bash'],
    ['gh pr view 12', 'bash'],
    ['gh --version', 'bash'],
    ['git --no-optional-locks status --short', 'bash'],
    ['git -P log --oneline', 'powershell'],
  ] as const)('%s does not change Git state', (command, dialect) => {
    expect(assessGitUsage(command, dialect)).toMatchObject({ mutating: false });
  });

  it.each([
    ['git commit -m x', 'not read-only'],
    ['git push', 'not read-only'],
    ['git add .', 'not read-only'],
    ['git fetch origin', 'not read-only'],
    ['git pull', 'not read-only'],
    ['git stash', 'not read-only'],
    ['git switch -c feature', 'not read-only'],
    ['git restore src', 'not read-only'],
    ['git tag v1', 'not read-only'],
    ['git branch -D old', 'create or delete'],
    ['git config user.email x', 'without --get'],
    ['git -c alias.x=!rm log', 'global option'],
    ['ls && git commit -m x', 'not read-only'],
    ['/usr/bin/git push', 'not read-only'],
    ['xargs git push', 'indirectly'],
    ['bash -c "git push"', 'indirectly'],
    ['GIT_DIR=x git commit', 'indirectly'],
    ['echo $(git commit -m x)', 'substitution'],
    ['git-lfs push origin', 'Git extension'],
    ['gh pr create --fill', 'can change'],
    ['gh pr merge 12', 'can change'],
    ['pnpm version minor', 'creates a Git commit'],
  ])('%s changes Git state (%s)', (command, reason) => {
    const result = assessGitUsage(command, 'bash');
    expect(result.mutating).toBe(true);
    expect(result.reason).toContain(reason);
  });

  it.each([
    "& 'C:\\Program Files\\Git\\cmd\\git.exe' push",
    'Start-Process git -ArgumentList push',
    'Invoke-Expression "git push"',
    'Get-ChildItem | ForEach-Object { git add $_ }',
    '(git commit -m x)',
  ])('PowerShell: %s changes Git state', (command) => {
    expect(assessGitUsage(command, 'powershell').mutating).toBe(true);
  });
});

const readOnlyBash = [
  'git status',
  'git status --porcelain=v2',
  'git --no-pager log --oneline -5',
  'git -C ../other diff HEAD~1',
  'git branch --show-current',
  'git remote -v',
  'git config --get user.name',
  'ls -la && pwd',
  'cat README.md | head -20',
  'grep -rn "TODO" src 2>/dev/null',
  'rg foo src | wc -l',
  'find . -name "*.ts" -type f',
  'node --version',
  'cd sub && git log',
  'echo "a > b"',
  'git --no-optional-locks status --short',
  'node dist/cli/jerry.mjs status',
  'node D:\\Projekciki\\jerry\\dist\\cli\\jerry.mjs task list',
  'jerry repo list',
  'jerry core status',
  'jerry events',
  'node dist/cli/jerry.mjs events --limit 20 --verdict warn',
  'jerry db backups',
  'sed -n 1,80p apps/core/src/usage-store.ts',
  "sed -n '$p' file.txt",
  "sed -n '/^export/p' a.ts b.ts",
  "sed -nE '10,+5p; 40p' file",
  "sed -n -e '1p' -e '$=' file",
  "sed -n '/foo/,/bar/!p' file",
  'sed 5p file',
  'cut -d: -f1 /etc/passwd | sort | uniq -c',
  'nl -ba file | tac',
  "tr ',' ' '",
  'uniq file.txt',
  'tree -L 2 -a src',
];

const writeCapableBash = [
  ['rm -rf src', 'not on the read-only allowlist'],
  ['echo hi > file.txt', 'output redirection'],
  ['cat a >> b', 'output redirection'],
  ['git commit -m x', 'not read-only'],
  ['git checkout -- .', 'not read-only'],
  ['git branch new-feature', 'create or delete'],
  ['git remote add evil https://x', 'modify remotes'],
  ['git config user.name x', 'without --get'],
  ['git -c core.pager=rm log', 'global option'],
  ['git diff --output=patch.txt', 'writes or runs a pager'],
  ['ls; rm -rf .', 'not on the read-only allowlist'],
  ['ls && touch x', 'not on the read-only allowlist'],
  ['ls || npm install', 'not on the read-only allowlist'],
  ['cat $(rm x)', 'command substitution'],
  ['cat `rm x`', 'command substitution'],
  ['find . -delete', 'find action'],
  ['find . -exec rm {} ;', 'find action'],
  ['sort -o out.txt in.txt', 'output file'],
  ['node -e "require(\'fs\').writeFileSync(\'x\',\'\')"', 'arbitrary code'],
  ['FOO=1 ls', 'environment assignment'],
  ['./ls', 'explicit executable path'],
  ['ls\nrm -rf .', 'multi-line'],
  ['echo "unterminated', 'unbalanced quotes'],
  ['cat <(rm x)', 'process substitution'],
  ['sed -i s/a/b/ file', 'sed option -i'],
  ['sed -ni 1p file', 'sed option -ni'],
  ['sed --in-place 1p file', 'sed option --in-place'],
  ['sed -n -f script.sed file', 'sed option -f'],
  ["sed -n '1w out.txt' file", 'not print-only'],
  ["sed -n '1W out.txt' file", 'not print-only'],
  ["sed 's/a/b/' file", 'not print-only'],
  ["sed 's/a/b/w out.txt' file", 'not print-only'],
  ["sed 's/a/id/e' file", 'not print-only'],
  ["sed '1e rm -rf .' file", 'not print-only'],
  ["sed -n -e 1p -e '1w out' file", 'not print-only'],
  ['sed -n', 'sed without a script'],
  ['sed -n 1p a > b', 'output redirection'],
  ['uniq in.txt out.txt', 'second file argument'],
  ['tree -o out.txt', 'output file'],
  ['tree -aR', 'output file'],
  ['tac a; rm b', 'not on the read-only allowlist'],
  ['node dist/cli/jerry.mjs task create --repo . --title x --scope a', 'changes JERRY state'],
  ['jerry plan revise JRY-0001 --scope a', 'changes JERRY state'],
  ['node scripts/other.mjs status', 'arbitrary code'],
] as const;

describe('assessShellCommand (bash)', () => {
  it.each(readOnlyBash)('treats %s as read-only', (command) => {
    expect(assessShellCommand(command, 'bash')).toMatchObject({ readOnly: true });
  });

  it.each(writeCapableBash)('treats %s as write-capable (%s)', (command, reason) => {
    const result = assessShellCommand(command, 'bash');
    expect(result.readOnly).toBe(false);
    expect(result.reason).toContain(reason);
  });
});

describe('assessShellCommand (powershell)', () => {
  it.each([
    'Get-ChildItem -Recurse -Filter *.ts',
    'Get-Content README.md | Select-Object -First 20',
    'git status',
    'Test-Path .\\src',
    'Select-String -Path src\\*.ts -Pattern TODO 2>$null',
    'Get-ChildItem src | Group-Object Extension',
    'Get-Item README.md | Get-Member',
    'Get-ChildItem | Format-Wide Name',
    'Compare-Object -ReferenceObject a -DifferenceObject b',
  ])('treats %s as read-only', (command) => {
    expect(assessShellCommand(command, 'powershell')).toMatchObject({ readOnly: true });
  });

  it.each([
    ['Set-Content x.txt hi', 'not on the read-only allowlist'],
    ['Remove-Item -Recurse src', 'not on the read-only allowlist'],
    ['Get-Content a > b', 'output redirection'],
    ['Get-Content (Remove-Item x)', 'sub-expression'],
    ['Get-ChildItem | Where-Object { Remove-Item $_; $true }', 'script block'],
    ['& rm x', 'not on the read-only allowlist'],
    ['Get-Content a; Remove-Item b', 'not on the read-only allowlist'],
    ['iex "rm x"', 'not on the read-only allowlist'],
  ] as const)('treats %s as write-capable (%s)', (command, reason) => {
    const result = assessShellCommand(command, 'powershell');
    expect(result.readOnly).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it('does not accept bash-only commands in PowerShell', () => {
    expect(assessShellCommand('head -5 a.txt', 'powershell').readOnly).toBe(false);
  });
});

describe('shellWriteTargets', () => {
  it.each([
    ["mkdir -p src notes && printf 'a' > src/a.txt && printf 'b' > notes/b.txt", ['src/a.txt', 'notes/b.txt']],
    ['echo x >> log.txt', ['log.txt']],
    ['echo x>out.txt', ['out.txt']],
    ['cmd 2> err.log', ['err.log']],
    ['echo "a > b" > "my file.txt"', ['my file.txt']],
    ['echo x | tee -a a.txt b.txt', ['a.txt', 'b.txt']],
    ['touch -d 2026-01-01 x.txt y.txt', ['x.txt', 'y.txt']],
    ['cat a > b; cat c > b', ['b']],
    ["printf 'a'\n> multi.txt", ['multi.txt']],
    // Not files, or not resolvable from the text: left out.
    ['npm test > /dev/null 2>&1', []],
    ['echo x >&2', []],
    ['echo x 1>&2 && echo y > y.txt', ['y.txt']],
    ['echo $X > $OUT', []],
    ['echo x > ~/out.txt', []],
    ['echo x > logs/*.txt', []],
    ['echo x > /dev/stderr', []],
    ['cp a b', []],
    ['echo "unbalanced > x', []],
  ] as const)('bash: %s writes %j', (command, expected) => {
    expect(shellWriteTargets(command, 'bash')).toEqual(expected);
  });

  it.each([
    ["Set-Content -Path notes/b.txt -Value 'b'", ['notes/b.txt']],
    ['Set-Content x.txt hi', ['x.txt']],
    ["'b' | Out-File -FilePath out.txt -Encoding utf8", ['out.txt']],
    ["Add-Content -Value 'x' -LiteralPath 'C:\\Repo\\log.txt'", ['C:\\Repo\\log.txt']],
    ['New-Item -ItemType File -Path src -Name a.ts', ['src/a.ts']],
    ['New-Item -ItemType Directory -Path notes', []],
    ['Get-Process | Tee-Object procs.txt', ['procs.txt']],
    ['Get-Content a *> all.txt', ['all.txt']],
    ['Get-Content a > $null', []],
    ['Set-Content -Path $env:TEMP/x.txt -Value 1', []],
    ['tee a.txt', ['a.txt']],
  ] as const)('PowerShell: %s writes %j', (command, expected) => {
    expect(shellWriteTargets(command, 'powershell')).toEqual(expected);
  });

  it('keeps the read-only verdicts of redirecting commands', () => {
    expect(assessShellCommand('echo x >&2', 'bash')).toMatchObject({ readOnly: false, reason: 'output redirection' });
    expect(assessShellCommand('cat a 2>&1 | head -5', 'bash').readOnly).toBe(true);
  });
});
