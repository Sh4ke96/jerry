import { z } from 'zod';

/**
 * Shared, versioned contracts between the Claude Code hook bridge, JERRY Core and the CLI.
 * Everything crossing a process boundary is validated against these schemas.
 */

export const JERRY_VERSION = '0.0.1-m0';

// ---------------------------------------------------------------------------
// Claude Code hook input (stdin of a command hook)
// ---------------------------------------------------------------------------

/**
 * Fields Claude Code sends to every hook. Unknown fields are kept because
 * Claude Code adds fields between versions and the bridge must not reject them.
 */
export const hookCommonInputSchema = z.looseObject({
  session_id: z.string().min(1),
  transcript_path: z.string().optional(),
  cwd: z.string().min(1),
  hook_event_name: z.string().min(1),
  permission_mode: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
});

export const preToolUseInputSchema = hookCommonInputSchema.extend({
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.string().min(1),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
});
export type PreToolUseInput = z.infer<typeof preToolUseInputSchema>;

export const sessionStartInputSchema = hookCommonInputSchema.extend({
  hook_event_name: z.literal('SessionStart'),
  source: z.string().optional(),
});
export type SessionStartInput = z.infer<typeof sessionStartInputSchema>;

// ---------------------------------------------------------------------------
// Gate (PreToolUse decision)
// ---------------------------------------------------------------------------

export const gateCheckRequestSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  toolName: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()),
  toolUseId: z.string().nullable(),
  agentId: z.string().nullable(),
});
export type GateCheckRequest = z.infer<typeof gateCheckRequestSchema>;

/**
 * PASS: JERRY has no objection; Claude Code's own permission system decides.
 *       JERRY never grants permissions, it only restricts them.
 * ASK:  escalate to the user (permissionDecision "ask").
 * DENY: block the tool call.
 */
export const gateVerdictSchema = z.enum(['PASS', 'ASK', 'DENY']);
export type GateVerdict = z.infer<typeof gateVerdictSchema>;

export const gateDecisionSchema = z.object({
  verdict: gateVerdictSchema,
  ruleId: z.string().min(1),
  reason: z.string().min(1),
  taskId: z.string().nullable(),
  repoRoot: z.string().nullable(),
});
export type GateDecision = z.infer<typeof gateDecisionSchema>;

// ---------------------------------------------------------------------------
// Tasks, plans, approvals
// ---------------------------------------------------------------------------

export const taskIdSchema = z.string().regex(/^JRY-\d{4,}$/);
export const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Repo-relative glob patterns, forward slashes, e.g. "src/**". */
export const planScopeSchema = z.array(z.string().min(1)).min(1);

export const planSchema = z.object({
  version: z.number().int().positive(),
  contentHash: contentHashSchema,
  scope: planScopeSchema,
  createdAt: z.iso.datetime(),
});
export type Plan = z.infer<typeof planSchema>;

export const approvalStageSchema = z.enum(['PLAN']);
export const approvalDecisionSchema = z.enum(['APPROVED', 'REJECTED']);

export const approvalRecordSchema = z.object({
  approvalId: z.string().min(1),
  taskId: taskIdSchema,
  stage: approvalStageSchema,
  version: z.number().int().positive(),
  contentHash: contentHashSchema,
  decision: approvalDecisionSchema,
  approvedBy: z.literal('local-user'),
  approvedAt: z.iso.datetime(),
  comment: z.string(),
});
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export const taskSchema = z.object({
  taskId: taskIdSchema,
  title: z.string().min(1),
  repoRoot: z.string().min(1),
  createdAt: z.iso.datetime(),
  plan: planSchema,
});
export type Task = z.infer<typeof taskSchema>;

export const taskCreateRequestSchema = z.object({
  repoPath: z.string().min(1),
  title: z.string().min(1),
  scope: planScopeSchema,
});
export type TaskCreateRequest = z.infer<typeof taskCreateRequestSchema>;

export const planReviseRequestSchema = z.object({
  scope: planScopeSchema,
});
export type PlanReviseRequest = z.infer<typeof planReviseRequestSchema>;

export const approvalRequestSchema = z.object({
  stage: approvalStageSchema,
  version: z.number().int().positive(),
  decision: approvalDecisionSchema,
  comment: z.string().default(''),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

// ---------------------------------------------------------------------------
// Sessions and Core state
// ---------------------------------------------------------------------------

export const sessionRegistrationSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  source: z.string().nullable(),
});
export type SessionRegistration = z.infer<typeof sessionRegistrationSchema>;

export const approvedPlanSummarySchema = z.object({
  taskId: taskIdSchema,
  planVersion: z.number().int().positive(),
  scope: planScopeSchema,
});
export type ApprovedPlanSummary = z.infer<typeof approvedPlanSummarySchema>;

/** Core's answer to SessionStart: what is currently approved for the session's repository. */
export const sessionRegistrationResponseSchema = z.object({
  registered: z.literal(true),
  repoRoot: z.string().nullable(),
  approvedPlans: z.array(approvedPlanSummarySchema),
});
export type SessionRegistrationResponse = z.infer<typeof sessionRegistrationResponseSchema>;

export const sessionRecordSchema = sessionRegistrationSchema.extend({
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export const coreStateSchema = z.object({
  schemaVersion: z.literal(1),
  nextTaskNumber: z.number().int().positive(),
  tasks: z.array(taskSchema),
  approvals: z.array(approvalRecordSchema),
  sessions: z.array(sessionRecordSchema),
});
export type CoreState = z.infer<typeof coreStateSchema>;

/** Written by Core to JERRY_HOME/run/core.json; read by the bridge and CLI to reach Core. */
export const coreRuntimeInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  startedAt: z.iso.datetime(),
  version: z.string().min(1),
});
export type CoreRuntimeInfo = z.infer<typeof coreRuntimeInfoSchema>;

export const coreStatusSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  pid: z.number().int(),
  startedAt: z.iso.datetime(),
  jerryHome: z.string(),
  taskCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
});
export type CoreStatus = z.infer<typeof coreStatusSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
