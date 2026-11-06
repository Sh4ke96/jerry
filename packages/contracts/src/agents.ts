/**
 * JERRY's agent registry. Plain constants: the plugin ships one
 * Claude Code subagent definition per role (claude-plugin/agents/<id>.md), and tests keep the two
 * in sync. At most three subagents run at a time and per phase; the main session is not counted.
 */

export const MAX_SUBAGENTS = 3;

export type AgentPhase = 'analysis' | 'implementation' | 'review';

export interface AgentRole {
  /** Subagent name; Claude Code shows plugin agents as "jerry:<id>". */
  id: string;
  phase: AgentPhase;
  /** Analysts and reviewers only read; their definitions grant no write or shell tools. */
  readOnly: boolean;
  /** The perspectives this role covers. */
  covers: readonly string[];
}

export const AGENT_ROLES: readonly AgentRole[] = [
  { id: 'jerry-architecture-analyst', phase: 'analysis', readOnly: true, covers: ['architecture and impact', 'API and contracts', 'database and data integrity', 'cross-repository integration', 'repository discovery'] },
  { id: 'jerry-risk-analyst', phase: 'analysis', readOnly: true, covers: ['security and threats', "devil's advocate: wrong assumptions and failure scenarios"] },
  { id: 'jerry-quality-analyst', phase: 'analysis', readOnly: true, covers: ['tests and QA strategy', 'regression', 'UI/UX and accessibility'] },
  { id: 'jerry-implementer', phase: 'implementation', readOnly: false, covers: ['implementation of an assigned, disjoint file scope'] },
  { id: 'jerry-correctness-reviewer', phase: 'review', readOnly: true, covers: ['correctness', 'tests and coverage'] },
  { id: 'jerry-security-reviewer', phase: 'review', readOnly: true, covers: ['security', 'API contracts'] },
  { id: 'jerry-design-reviewer', phase: 'review', readOnly: true, covers: ['architecture', 'code quality', 'UX and accessibility'] },
];

/** Tools a read-only role may never have. */
export const WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor'];
