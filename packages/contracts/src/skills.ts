import { z } from 'zod';
import { SKILL_TRIGGER_STATES, WORKFLOW_STATES } from './constants.js';

/**
 * Claude Code skills the user adds through JERRY: previewed (validated and scanned, never run),
 * then installed into CLAUDE_CONFIG_DIR/skills/<name>, switched off and on through Claude Code's
 * documented "skillOverrides" setting, updated and removed (with a backup). Every change is the
 * user's: the CLI asks in a terminal, the dashboard needs CSRF and, for install and remove, the
 * typed skill name.
 *
 * Added skills are started only by JERRY: their SKILL.md gets "user-invocable: false" (no / menu
 * entry) and skillOverrides "name-only" (Claude sees the name, not the description, so it never
 * picks the skill on its own). The user assigns each skill to task workflow states; JERRY's next
 * action tells Claude to use it while an open task is in one of them, and a call outside them is a
 * recorded warning.
 */

/** A skill folder name: lowercase letters, digits and single hyphens, as Claude Code's skill names. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX_LENGTH = 64;
export const skillNameSchema = z.string().min(1).max(SKILL_NAME_MAX_LENGTH).regex(SKILL_NAME_PATTERN);

/**
 * Limits of one skill: total size of its files and their number. Real skills are often whole folders
 * with scripts, references and assets, so the limits are generous; a skill above the "large"
 * thresholds gets an amber finding in the preview so it is never installed unnoticed.
 */
export const MAX_SKILL_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_FILES = 5000;
export const LARGE_SKILL_BYTES = 2 * 1024 * 1024;
export const LARGE_SKILL_FILES = 200;
/** A zip or .skill file sent from the dashboard (before base64). */
export const MAX_SKILL_UPLOAD_BYTES = 50 * 1024 * 1024;
/** A local zip or .skill file read from disk (it may hold more than the skill). */
export const MAX_SKILL_ARCHIVE_BYTES = 200 * 1024 * 1024;

/** A folder of a repository that holds a SKILL.md: offered when the given URL holds several skills. */
export const skillCandidateSchema = z.object({ folder: z.string(), url: z.string() });
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;
/** The details of a preview refusal: the skill folders to pick from, when the source holds several. */
export const skillErrorDetailsSchema = z.object({ candidates: z.array(skillCandidateSchema).default([]) });
export type SkillErrorDetails = z.infer<typeof skillErrorDetailsSchema>;

/** Shown after every change. */
export const SKILL_CHANGE_NOTE = 'Applies to new Claude Code sessions.';

export const skillSourceKindSchema = z.enum(['github', 'zip', 'folder']);
export type SkillSourceKind = z.infer<typeof skillSourceKindSchema>;

export const skillSourceSchema = z.object({
  kind: skillSourceKindSchema,
  /** The GitHub URL, or the path of the zip file or folder, as given. Uploaded files: their name. */
  source: z.string(),
  /** GitHub: the branch, tag or commit in the URL; null: the default branch. */
  ref: z.string().nullable(),
  /** GitHub: the commit the files came from. */
  commit: z.string().nullable(),
  /** GitHub: the folder inside the repository ('' for its root). */
  path: z.string().nullable(),
});
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillFileSchema = z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: z.string() });
export type SkillFile = z.infer<typeof skillFileSchema>;

/** warning: worth a look (scripts, network, secrets); danger: text that tries to steer the agent, binaries. */
export const skillScanLevelSchema = z.enum(['warning', 'danger']);
export type SkillScanLevel = z.infer<typeof skillScanLevelSchema>;

export const skillScanFindingSchema = z.object({
  level: skillScanLevelSchema,
  rule: z.string(),
  file: z.string(),
  line: z.number().int().positive().nullable(),
  message: z.string(),
  /** The matching line, shortened, with token-like strings masked. */
  excerpt: z.string().nullable(),
});
export type SkillScanFinding = z.infer<typeof skillScanFindingSchema>;

export const skillDiffSchema = z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) });
export type SkillDiff = z.infer<typeof skillDiffSchema>;

/** What would be installed; staged in JERRY's data, never run. */
export const skillPreviewSchema = z.object({
  previewId: z.string(),
  purpose: z.enum(['install', 'update']),
  name: skillNameSchema,
  description: z.string(),
  source: skillSourceSchema,
  /** SKILL.md as text (shortened when very long). */
  skillMd: z.string(),
  files: z.array(skillFileSchema),
  totalBytes: z.number().int().nonnegative(),
  contentHash: z.string(),
  scan: z.array(skillScanFindingSchema),
  /** CLAUDE_CONFIG_DIR/skills/<name>. */
  targetDir: z.string(),
  /** Why installing is refused (a folder of that name JERRY did not install); null when it can go ahead. */
  blocked: z.string().nullable(),
  /** Update: what changes against the installed version. */
  diff: skillDiffSchema.nullable(),
  /** Update: the installed version is the same. */
  upToDate: z.boolean(),
  expiresAt: z.iso.datetime(),
});
export type SkillPreview = z.infer<typeof skillPreviewSchema>;

/** POST /api/v1/skills/preview and …/update/preview: a GitHub URL or local path, or an uploaded zip. */
export const skillPreviewRequestSchema = z
  .object({
    source: z.string().trim().min(1).max(2000).optional(),
    upload: z
      .object({
        fileName: z.string().min(1).max(255),
        /** The file's bytes, base64. */
        dataBase64: z
          .string()
          .max(Math.ceil((MAX_SKILL_UPLOAD_BYTES * 4) / 3) + 4)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .optional(),
  })
  .refine((body) => !(body.source !== undefined && body.upload !== undefined), { message: 'give a source or an upload, not both' });
export type SkillPreviewRequest = z.infer<typeof skillPreviewRequestSchema>;

/** POST /api/v1/skills/install and …/update/apply. */
export const skillApplyRequestSchema = z.object({
  previewId: z.string().min(1).max(100),
  /** Dashboard: the skill name typed by the user. */
  confirmation: z.string().max(200).optional(),
});
export type SkillApplyRequest = z.infer<typeof skillApplyRequestSchema>;

/** POST /api/v1/skills/:name/remove, …/enable, …/disable. */
export const skillConfirmRequestSchema = z.object({ confirmation: z.string().max(200).optional() });

/** A state from SKILL_TRIGGER_STATES (constants.ts). */
export const skillTriggerStateSchema = z.enum(WORKFLOW_STATES).refine((state) => SKILL_TRIGGER_STATES.includes(state), {
  message: 'a skill can be assigned only to an open state in which Claude works (not DONE, CANCELLED, PAUSED or BLOCKED)',
});

/** POST …/skills/:name/states: the states JERRY starts the skill in (empty: never). */
export const skillStatesRequestSchema = z.object({
  states: z.array(skillTriggerStateSchema).max(WORKFLOW_STATES.length),
  confirmation: z.string().max(200).optional(),
});
export type SkillStatesRequest = z.infer<typeof skillStatesRequestSchema>;

/** What JERRY writes to skillOverrides for an added skill that is on: Claude sees only its name. */
export const SKILL_OVERRIDE_ON = 'name-only';

export const skillScanSummarySchema = z.object({ warnings: z.number().int().nonnegative(), dangers: z.number().int().nonnegative() });

/** A skill JERRY installed. */
export const addedSkillSchema = z.object({
  kind: z.literal('added'),
  name: skillNameSchema,
  description: z.string(),
  dir: z.string(),
  source: skillSourceSchema,
  contentHash: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  /** Not switched off in Claude Code's settings (skillOverrides). */
  enabled: z.boolean(),
  /** The workflow states JERRY starts the skill in, in workflow order; empty: Claude never uses it. */
  states: z.array(z.enum(WORKFLOW_STATES)),
  /** SKILL.md carries JERRY's "user-invocable: false"; false for a skill installed before that and not converted yet. */
  jerryTriggered: z.boolean(),
  /** The folder is still there. */
  present: z.boolean(),
  /** The folder's files differ from what JERRY installed (changed by hand). */
  modified: z.boolean(),
  scan: skillScanSummarySchema,
  installedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AddedSkill = z.infer<typeof addedSkillSchema>;

/** A skill JERRY did not install: its own plugin's (read-only) or one the user keeps in the skills folder. */
export const otherSkillSchema = z.object({
  kind: z.enum(['jerry', 'personal']),
  /** jerry: the command name, e.g. "jerry:plan". */
  name: z.string(),
  description: z.string(),
  dir: z.string(),
});
export type OtherSkill = z.infer<typeof otherSkillSchema>;

export const skillsListSchema = z.object({
  /** CLAUDE_CONFIG_DIR/skills. */
  skillsDir: z.string(),
  own: z.array(otherSkillSchema),
  added: z.array(addedSkillSchema),
  personal: z.array(otherSkillSchema),
  note: z.string(),
});
export type SkillsList = z.infer<typeof skillsListSchema>;

export const skillEventSchema = z.object({ action: z.string(), channel: z.string(), at: z.iso.datetime(), details: z.record(z.string(), z.unknown()) });
export type SkillEvent = z.infer<typeof skillEventSchema>;

/**
 * One time Claude used the skill (a Skill tool call JERRY saw): when, in which session and task,
 * and whether it was in the task states JERRY starts the skill in (PASS) or a deviation (WARN).
 */
export const skillUseSchema = z.object({
  at: z.iso.datetime(),
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  repoRoot: z.string().nullable(),
  verdict: z.string().nullable(),
  ruleId: z.string().nullable(),
});
export type SkillUse = z.infer<typeof skillUseSchema>;

/** GET /api/v1/skills/:name. */
export const skillDetailSchema = z.object({
  skill: z.union([addedSkillSchema, otherSkillSchema]),
  skillMd: z.string().nullable(),
  files: z.array(skillFileSchema),
  scan: z.array(skillScanFindingSchema),
  history: z.array(skillEventSchema),
  /** The latest uses of the skill, newest first (missing from an older Core). */
  uses: z.array(skillUseSchema).default([]),
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const skillChangeResultSchema = z.object({
  name: skillNameSchema,
  action: z.enum(['installed', 'updated', 'enabled', 'disabled', 'removed', 'states-set', 'unchanged']),
  skill: addedSkillSchema.nullable(),
  /** remove and update: where the previous folder went. */
  backupDir: z.string().nullable(),
  /** enable and disable: the copy of Claude Code's settings taken first (null when nothing changed). */
  settingsBackup: z.string().nullable(),
  note: z.string(),
});
export type SkillChangeResult = z.infer<typeof skillChangeResultSchema>;
