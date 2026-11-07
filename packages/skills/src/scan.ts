import type { SkillScanFinding } from '@jerry/contracts';
import { maskExcerpt, scanForInjection } from '@jerry/discovery';
import type { SkillContentFile } from './content.js';
import type { Frontmatter } from './frontmatter.js';

/**
 * What the user should look at before installing a skill. Text that tries to steer the agent (the
 * project scanner's prompt-injection rules) and executables are red; scripts, network calls, secret
 * lookups, pre-approved tools and shell commands that run when the skill loads are amber. A finding
 * never blocks: the user decides. Nothing is run.
 */

const MAX_FINDINGS = 200;
/** Lines read per file for the pattern rules. */
const MAX_LINES = 5000;

const BINARY_EXTENSIONS = /\.(exe|dll|so|dylib|msi|com|scr|jar|bin|app|deb|rpm|pyc|class|wasm|node)$/i;
const SCRIPT_EXTENSIONS = /\.(sh|bash|zsh|fish|ps1|psm1|psd1|cmd|bat|vbs|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua|applescript|scpt)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|bmp|svgz|pdf|ttf|otf|woff2?)$/i;

const PATTERN_RULES: ReadonlyArray<{ rule: string; pattern: RegExp; message: string }> = [
  {
    rule: 'network',
    pattern: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|ssh|scp|ftp)\s|\bfetch\s*\(|\baxios\b|\brequests\.(get|post|put|delete)\b|\burllib\b|\bhttps?\.(get|request)\s*\(|\bnet\.connect\b|\bnew\s+WebSocket\b|\bsocket\.socket\b/,
    message: 'Reaches the network',
  },
  {
    rule: 'secrets',
    pattern: /\.ssh[\\/]|\bid_rsa\b|\bid_ed25519\b|\.aws[\\/]credentials|\.netrc\b|\.npmrc\b|\.git-credentials\b|\.env\b|\b[A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\b|\bprocess\.env\b|\$env:|\bos\.environ\b|\bgetenv\s*\(/,
    message: 'Reads secrets or environment variables',
  },
  {
    rule: 'destructive',
    pattern: /\brm\s+-[a-z]*r[a-z]*f|\bRemove-Item\b[^\n]*-Recurse|\brmdir\s+\/s\b|\bdel\s+\/[sq]\b|\bformat\s+[a-z]:|\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/i,
    message: 'Deletes files or changes Git history',
  },
];

const finding = (level: SkillScanFinding['level'], rule: string, file: string, line: number | null, message: string, excerpt: string | null = null): SkillScanFinding => ({ level, rule, file, line, message, excerpt });

function isText(file: SkillContentFile): boolean {
  if (BINARY_EXTENSIONS.test(file.path) || IMAGE_EXTENSIONS.test(file.path)) return false;
  return !file.data.subarray(0, 8000).includes(0);
}

export function scanSkill(files: readonly SkillContentFile[], frontmatter: Frontmatter): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const add = (entry: SkillScanFinding): boolean => {
    findings.push(entry);
    return findings.length < MAX_FINDINGS;
  };
  const texts = new Map(files.filter(isText).map((file) => [file.path, file.data.toString('utf8')]));

  // Frontmatter that changes what Claude may do without asking.
  const allowed = frontmatter.fields['allowed-tools'];
  if (allowed !== undefined && allowed !== '') {
    const tools = Array.isArray(allowed) ? allowed.join(', ') : String(allowed);
    add(finding(/\b(Bash|PowerShell)\b/.test(tools) ? 'danger' : 'warning', 'allowed-tools', 'SKILL.md', null, `Pre-approves tools while the skill runs: ${tools.slice(0, 200)}`));
  }
  if (frontmatter.fields['hooks'] !== undefined) add(finding('warning', 'hooks', 'SKILL.md', null, 'Declares hooks: commands that run on Claude Code events while the skill is active'));

  // Text that tries to steer the agent: the project scanner's rules, on every text file.
  const injection = scanForInjection(
    [...texts].map(([file, text]) => ({ path: file, size: Buffer.byteLength(text), mtimeMs: 0 })),
    (file) => texts.get(file) ?? null,
  );
  for (const hit of injection.findings) if (!add(finding('danger', `injection:${hit.rule}`, hit.path, hit.line, 'Text that tries to steer the agent', hit.excerpt))) return findings;

  for (const file of files) {
    if (BINARY_EXTENSIONS.test(file.path)) {
      if (!add(finding('danger', 'executable', file.path, null, 'A compiled program or library: its code cannot be reviewed here'))) return findings;
      continue;
    }
    if (SCRIPT_EXTENSIONS.test(file.path)) {
      if (!add(finding('warning', 'script', file.path, null, 'A script: Claude may run it when the skill tells it to'))) return findings;
    }
    const text = texts.get(file.path);
    if (text === undefined) {
      if (!IMAGE_EXTENSIONS.test(file.path) && !add(finding('warning', 'binary', file.path, null, 'A binary file of unknown type'))) return findings;
      continue;
    }
    const lines = text.split(/\r?\n/).slice(0, MAX_LINES);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      // Dynamic context: Claude Code runs !`command` and ```! blocks when the skill loads.
      if (file.path === 'SKILL.md' && (/!`[^`]+`/.test(line) || /^\s*```!/.test(line))) {
        if (!add(finding('warning', 'load-command', file.path, index + 1, 'Runs a shell command when the skill loads', maskExcerpt(line)))) return findings;
        continue;
      }
      for (const { rule, pattern, message } of PATTERN_RULES) {
        if (!pattern.test(line)) continue;
        if (!add(finding('warning', rule, file.path, index + 1, message, maskExcerpt(line)))) return findings;
        break;
      }
    }
  }
  return findings;
}

export function scanSummary(findings: readonly SkillScanFinding[]): { warnings: number; dangers: number } {
  return { warnings: findings.filter((entry) => entry.level === 'warning').length, dangers: findings.filter((entry) => entry.level === 'danger').length };
}
