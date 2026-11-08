/**
 * JERRY's agent registry. Plain constants: the plugin ships one
 * Claude Code subagent definition per role (claude-plugin/agents/<id>.md), and tests keep the two
 * in sync. At most three subagents run at a time and per phase; the main session is not counted.
 */

export const MAX_SUBAGENTS = 3;

export type AgentPhase = 'analysis' | 'implementation' | 'review';

/**
 * Models a read-only subagent can run on: the value of the agent's `model:` frontmatter. inherit
 * uses the model of the session that starts it.
 */
export const AGENT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'inherit'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

/** Reasoning effort of a subagent: the agent's `effort:` frontmatter. default leaves the session's effort. */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface AgentModelChoice {
  model: AgentModel;
  effort: AgentEffort;
}

export interface AgentRole {
  /** Subagent name; Claude Code shows plugin agents as "jerry:<id>". */
  id: string;
  phase: AgentPhase;
  /** Analysts and reviewers only read; their definitions grant no write or shell tools. */
  readOnly: boolean;
  /** The perspectives this role covers. */
  covers: readonly string[];
  /**
   * Read-only roles: the model and effort the plugin ships in the agent's frontmatter, until the
   * user picks others. The implementer has none: it runs on the session's model.
   */
  defaults?: AgentModelChoice;
}

export const AGENT_ROLES: readonly AgentRole[] = [
  { id: 'jerry-architecture-analyst', phase: 'analysis', readOnly: true, covers: ['architecture and impact', 'API and contracts', 'database and data integrity', 'cross-repository integration', 'repository discovery'], defaults: { model: 'claude-opus-5-5', effort: 'high' } },
  { id: 'jerry-risk-analyst', phase: 'analysis', readOnly: true, covers: ['security and threats', "devil's advocate: wrong assumptions and failure scenarios"], defaults: { model: 'claude-opus-5-5', effort: 'high' } },
  { id: 'jerry-quality-analyst', phase: 'analysis', readOnly: true, covers: ['tests and QA strategy', 'regression', 'UI/UX and accessibility'], defaults: { model: 'claude-sonnet-5-5', effort: 'medium' } },
  { id: 'jerry-implementer', phase: 'implementation', readOnly: false, covers: ['implementation of an assigned, disjoint file scope'] },
  { id: 'jerry-correctness-reviewer', phase: 'review', readOnly: true, covers: ['correctness', 'tests and coverage'], defaults: { model: 'claude-opus-5-5', effort: 'high' } },
  { id: 'jerry-security-reviewer', phase: 'review', readOnly: true, covers: ['security', 'API contracts'], defaults: { model: 'claude-opus-5-5', effort: 'high' } },
  { id: 'jerry-design-reviewer', phase: 'review', readOnly: true, covers: ['architecture', 'code quality', 'UX and accessibility'], defaults: { model: 'claude-sonnet-5-5', effort: 'medium' } },
];

/** The read-only roles whose model and effort the user picks. */
export const MODEL_CHOICE_ROLES: readonly (AgentRole & { defaults: AgentModelChoice })[] = AGENT_ROLES.filter(
  (role): role is AgentRole & { defaults: AgentModelChoice } => role.readOnly && role.defaults !== undefined,
);

/**
 * JERRY's routine skills whose model and effort the user picks (their SKILL.md frontmatter). A
 * skill's model applies for the rest of the turn it runs in, so /jerry:report, after which review or
 * fixes may follow in the same turn, stays on the session's model by default.
 */
export interface SkillModelRole {
  /** The skill as Claude Code names it ("jerry:report"). */
  id: string;
  /** Its folder in the plugin (skills/<skill>/SKILL.md). */
  skill: string;
  defaults: AgentModelChoice;
}

export const SKILL_MODEL_ROLES: readonly SkillModelRole[] = [
  { id: 'jerry:report', skill: 'report', defaults: { model: 'inherit', effort: 'default' } },
  { id: 'jerry:commit-message', skill: 'commit-message', defaults: { model: 'claude-sonnet-5-5', effort: 'low' } },
  { id: 'jerry:artifact', skill: 'artifact', defaults: { model: 'claude-sonnet-5-5', effort: 'medium' } },
];

/** Analyst roles, in the order the analysis lists them. */
export const ANALYST_ROLES = ['jerry-architecture-analyst', 'jerry-risk-analyst', 'jerry-quality-analyst'] as const;
export type AnalystRole = (typeof ANALYST_ROLES)[number];

/** Tools a read-only role may never have. */
export const WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor'];
