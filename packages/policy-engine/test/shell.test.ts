import { describe, expect, it } from 'vitest';
import { assessShellCommand } from '../src/shell.js';

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
  ['sed -i s/a/b/ file', 'not on the read-only allowlist'],
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
