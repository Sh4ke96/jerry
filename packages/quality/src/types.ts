import type { FindingSeverity } from '@jerry/contracts';

/**
 * The static rule engine's model (ADR 0028). Pure: no file system, no processes. Core reads the
 * files (read-only) and hands over their content and the lines that changed.
 */

export type Language = 'typescript' | 'javascript' | 'python' | 'php' | 'java' | 'csharp' | 'go' | 'ruby' | 'other';

export type RuleCategory = 'naming' | 'comments' | 'error-handling' | 'test-quality' | 'security';

/** One file to check: its full content (for context) and the lines that changed (1-based). */
export interface CheckedFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  content: string;
  /** 'all' for a new or untracked file. */
  changedLines: ReadonlySet<number> | 'all';
}

/** What a rule saw, one per offending line (or block). */
export interface RuleHit {
  line: number;
  lineEnd?: number;
  /** The offending text, trimmed; never more than one line, never a secret value. */
  evidence: string;
  /** A sharper title for this hit, when the rule's title is too general. */
  title?: string;
}

export interface RuleContext {
  file: CheckedFile;
  language: Language;
  isTest: boolean;
  lines: readonly string[];
  /** Whether a 1-based line changed in this batch. */
  changed(line: number): boolean;
  /** Comment text of a line, without the comment marker, or null when the line is not a comment. */
  comment(line: number): string | null;
}

export interface Rule {
  id: string;
  version: string;
  category: RuleCategory;
  source: 'static' | 'security';
  severity: FindingSeverity;
  confidence: number;
  /** Languages the rule understands; 'any' for text rules. */
  languages: readonly Language[] | 'any';
  /** test: test files only; code: never in test files; all: everywhere. */
  files: 'test' | 'code' | 'all';
  title: string;
  why: string;
  fix: string;
  /** Lines the rule must flag, and lines it must not (they are the rule's tests). */
  examples: { positive: readonly string[]; negative: readonly string[]; language: Language; testFile?: boolean };
  /** When the rule deliberately stays quiet. */
  exceptions: string;
  check(context: RuleContext): RuleHit[];
}

/** A finding as the engine reports it; Core adds task, file identity, status and timestamps. */
export interface DetectedFinding {
  ruleId: string;
  ruleVersion: string;
  /** Stable across line moves: the rule and the normalized evidence. */
  fingerprint: string;
  source: 'static' | 'security';
  category: RuleCategory;
  severity: FindingSeverity;
  confidence: number;
  lineStart: number;
  lineEnd: number;
  title: string;
  evidence: string;
  whyItMatters: string;
  suggestedFix: string;
}

/**
 * The interface for security scanners (ADR 0028): the built-in rules implement it, and an external
 * tool (for example a SAST scanner the user installed) can later be plugged in behind it.
 */
export interface SecurityScanner {
  name: string;
  scan(files: readonly CheckedFile[]): DetectedFinding[] | Promise<DetectedFinding[]>;
}
