import { createHash } from 'node:crypto';
import type { ReadFile } from './detectors.js';

/**
 * Documentation index, project-instruction inventory and prompt-injection findings (ADR 0019).
 * Spec §6.3: repository content is data. Governance files (CLAUDE.md, AGENTS.md, .claude/rules…)
 * may serve as project rules, below JERRY's and the user's rules; text anywhere else never
 * instructs the agent. JERRY stores paths, titles and hashes, never document contents.
 */

export interface IndexedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface DocEntry {
  path: string;
  kind: 'readme' | 'adr' | 'architecture' | 'guide' | 'changelog' | 'contributing' | 'doc';
  /** First Markdown heading, if any. */
  title: string | null;
  /** sha256 of the content, or null when too large to read. */
  hash: string | null;
  size: number;
}

export interface InstructionEntry {
  path: string;
  kind: 'claude-md' | 'agents-md' | 'claude-rule' | 'claude-skill' | 'claude-agent' | 'claude-command' | 'claude-settings' | 'mcp-config' | 'cursor-rules' | 'copilot-instructions' | 'other-agent-rules';
  /** rules: the agent follows them as project rules (below JERRY and the user); config: changes how Claude Code behaves. */
  role: 'rules' | 'config';
  hash: string | null;
  size: number;
  /** What JERRY noticed, e.g. "defines 2 hook(s)" in project settings. */
  notes: string[];
}

export interface InjectionFinding {
  path: string;
  line: number;
  rule: string;
  /** The matching line, shortened and with token-like strings masked. */
  excerpt: string;
}

const MAX_READ_BYTES = 1024 * 1024;
const MAX_DOCS = 500;
const MAX_FINDINGS = 100;
/** Files and bytes the injection scan reads at most. */
const SCAN_FILE_LIMIT = 3000;
const SCAN_BYTE_BUDGET = 32 * 1024 * 1024;
const SCAN_FILE_MAX_BYTES = 256 * 1024;

const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const baseName = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

function docKind(file: string): DocEntry['kind'] | null {
  const name = baseName(file).toLowerCase();
  if (!/\.(md|mdx|rst|adoc|txt)$/.test(name) && name !== 'readme') return null;
  if (/^readme(\.|$)/.test(name)) return 'readme';
  if (/^changelog/.test(name) || /^history\.md$/.test(name)) return 'changelog';
  if (/^contributing/.test(name)) return 'contributing';
  const lower = file.toLowerCase();
  if (/(^|\/)(adr|adrs|decisions|architecture-decisions)\//.test(lower)) return 'adr';
  if (/(^|\/)architecture|(^|\/)design\//.test(lower)) return 'architecture';
  if (/(^|\/)docs?\//.test(lower)) return /guide|how-?to|tutorial|getting-started/.test(lower) ? 'guide' : 'doc';
  return file.includes('/') ? null : 'doc';
}

export function indexDocs(files: readonly IndexedFile[], read: ReadFile): DocEntry[] {
  const docs: DocEntry[] = [];
  for (const file of files) {
    if (docs.length >= MAX_DOCS) break;
    const kind = docKind(file.path);
    if (kind === null || isInstruction(file.path) !== null) continue;
    const text = file.size <= MAX_READ_BYTES ? read(file.path) : null;
    const heading = text === null ? null : (/^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(text.slice(0, 8192))?.[1] ?? null);
    docs.push({ path: file.path, kind, title: heading === null ? null : heading.slice(0, 160), hash: text === null ? null : hashOf(text), size: file.size });
  }
  return docs;
}

/** The kind and role of a project-instruction file, or null. */
export function isInstruction(file: string): Pick<InstructionEntry, 'kind' | 'role'> | null {
  const name = baseName(file);
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') return { kind: 'claude-md', role: 'rules' };
  if (name === 'AGENTS.md') return { kind: 'agents-md', role: 'rules' };
  if (/^\.claude\/rules\/.+\.md$/.test(file)) return { kind: 'claude-rule', role: 'rules' };
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file)) return { kind: 'claude-skill', role: 'rules' };
  if (/^\.claude\/agents\/[^/]+\.md$/.test(file)) return { kind: 'claude-agent', role: 'rules' };
  if (/^\.claude\/commands\/.+\.md$/.test(file)) return { kind: 'claude-command', role: 'rules' };
  if (file === '.claude/settings.json' || file === '.claude/settings.local.json') return { kind: 'claude-settings', role: 'config' };
  if (file === '.mcp.json') return { kind: 'mcp-config', role: 'config' };
  if (file === '.cursorrules' || /^\.cursor\/rules\//.test(file)) return { kind: 'cursor-rules', role: 'rules' };
  if (file === '.github/copilot-instructions.md') return { kind: 'copilot-instructions', role: 'rules' };
  if (file === '.windsurfrules' || file === 'GEMINI.md' || file === '.clinerules') return { kind: 'other-agent-rules', role: 'rules' };
  return null;
}

function settingsNotes(kind: InstructionEntry['kind'], text: string | null): string[] {
  if (text === null) return [];
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return ['not valid JSON'];
  }
  const notes: string[] = [];
  if (kind === 'claude-settings') {
    const hooks = json['hooks'];
    if (typeof hooks === 'object' && hooks !== null) {
      const count = Object.values(hooks as Record<string, unknown>).reduce<number>((sum, entries) => sum + (Array.isArray(entries) ? entries.length : 0), 0);
      if (count > 0) notes.push(`defines ${count} hook group(s): they run commands in Claude Code sessions`);
    }
    const permissions = json['permissions'];
    if (typeof permissions === 'object' && permissions !== null) {
      const allow = (permissions as Record<string, unknown>)['allow'];
      if (Array.isArray(allow) && allow.length > 0) notes.push(`pre-approves ${allow.length} permission rule(s)`);
      if ((permissions as Record<string, unknown>)['defaultMode'] === 'bypassPermissions') notes.push('sets bypassPermissions');
    }
  }
  if (kind === 'mcp-config') {
    const servers = json['mcpServers'];
    if (typeof servers === 'object' && servers !== null) notes.push(`declares MCP server(s): ${Object.keys(servers).join(', ')}`);
  }
  return notes;
}

export function inventoryInstructions(files: readonly IndexedFile[], read: ReadFile): InstructionEntry[] {
  const entries: InstructionEntry[] = [];
  for (const file of files) {
    const classified = isInstruction(file.path);
    if (classified === null) continue;
    const text = file.size <= MAX_READ_BYTES ? read(file.path) : null;
    entries.push({ path: file.path, ...classified, hash: text === null ? null : hashOf(text), size: file.size, notes: settingsNotes(classified.kind, text) });
  }
  return entries;
}

/**
 * Patterns of text that tries to steer an agent: overriding its instructions, running code from
 * the network, reaching for secrets, or disabling guardrails. A match is a finding for the user;
 * it never blocks anything and is never acted on.
 */
const INJECTION_RULES: ReadonlyArray<[string, RegExp]> = [
  ['override-instructions', /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier|system)\s+(instructions|prompts?|rules)/i],
  ['role-hijack', /\byou\s+are\s+now\s+(in\s+)?(developer|dan|jailbreak|unrestricted|god)\s*mode/i],
  ['pipe-to-shell', /\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]{0,200}\|\s*(sh|bash|zsh|iex|invoke-expression|powershell|pwsh)\b/i],
  ['secret-access', /\b(cat|type|get-content|less|more|cp|copy)\s+[^\n]{0,80}(\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]credentials|\.npmrc|\.netrc|\.git-credentials)/i],
  ['exfiltration', /\b(send|post|upload|exfiltrate)\b[^\n]{0,60}\b(tokens?|api[ _-]?keys?|secrets?|passwords?|credentials|\.env)\b[^\n]{0,60}\b(to|at)\s+https?:\/\//i],
  ['disable-guardrails', /\b(disable|turn\s+off|uninstall|bypass|remove)\s+(jerry|the\s+hooks|claude\s+code\s+hooks|guardrails|the\s+sandbox)\b/i],
  ['skip-permissions', /--dangerously-skip-permissions\b|["']defaultMode["']\s*:\s*["']bypassPermissions["']/],
  ['agent-directive', /\b(ai|assistant|agent|claude|llm)s?\b[,:]?\s+(must|should|always|now)\s+(run|execute|delete|push|commit|curl|download)\b/i],
];

const SCANNED_EXTENSIONS = /\.(md|mdx|txt|rst|adoc|html?|ya?ml|json|toml|ini|cfg|xml|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|rb|php|go|rs|java|kt|cs|sh|ps1|bat|cmd|vue|svelte)$/i;

/** Masks token-like strings so an excerpt never carries a credential. */
export function maskExcerpt(line: string): string {
  const trimmed = line.trim().replace(/[A-Za-z0-9_\-+/]{24,}={0,2}/g, '…');
  return trimmed.length > 160 ? `${trimmed.slice(0, 159)}…` : trimmed;
}

export function scanForInjection(files: readonly IndexedFile[], read: ReadFile): { findings: InjectionFinding[]; scannedFiles: number; complete: boolean } {
  const findings: InjectionFinding[] = [];
  let scannedFiles = 0;
  let bytes = 0;
  let complete = true;
  for (const file of files) {
    if (!SCANNED_EXTENSIONS.test(file.path) && isInstruction(file.path) === null && !/^(\.cursorrules|\.windsurfrules|\.clinerules)$/.test(file.path)) continue;
    if (file.size > SCAN_FILE_MAX_BYTES) continue;
    if (scannedFiles >= SCAN_FILE_LIMIT || bytes + file.size > SCAN_BYTE_BUDGET) {
      complete = false;
      break;
    }
    const text = read(file.path);
    if (text === null) continue;
    scannedFiles += 1;
    bytes += file.size;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      for (const [rule, pattern] of INJECTION_RULES) {
        if (!pattern.test(line)) continue;
        findings.push({ path: file.path, line: index + 1, rule, excerpt: maskExcerpt(line) });
        if (findings.length >= MAX_FINDINGS) return { findings, scannedFiles, complete: false };
        break;
      }
    }
  }
  return { findings, scannedFiles, complete };
}
