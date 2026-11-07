import type { DecisionConfirmation, FinalReport, ImplementationReportRecord, ProjectSummary, QaLanguage, ReviewMode, Settings, SettingsUpdateRequest, TaskSummary } from '@jerry/contracts';

/**
 * The workflow settings and the fields Core added with them (review mode, QA language, decision
 * confirmation). Read defensively: an older Core sends none of them, and the dashboard then behaves
 * as before.
 */

export type { DecisionConfirmation, QaLanguage, ReviewMode };
/** The settings as Core sends them; a Core without decision confirmations leaves that field out. */
export type WorkflowSettings = Omit<Settings, 'decisionConfirmation'> & { decisionConfirmation?: DecisionConfirmation };
export type SettingsUpdate = SettingsUpdateRequest;

/**
 * How the dashboard confirms reversible decisions: one click unless the user chose to type the task
 * ID (also one click when Core does not send the setting). A one-click decision still sends the task
 * ID, which every Core accepts, so an older Core that requires it keeps working. Irreversible actions
 * always ask for their typed confirmation and do not read this.
 */
export function decisionConfirmation(settings: WorkflowSettings | null): DecisionConfirmation {
  return settings?.decisionConfirmation === 'typed' ? 'typed' : 'click';
}

/** Whether the usage bar shows in the top bar: on unless the user turned it off (an older Core sends nothing: on). */
export function showsUsageBar(settings: WorkflowSettings | null): boolean {
  return settings?.usageShowBar !== false;
}

/** A project's own review setting: null inherits the global one. */
export type ProjectReviewMode = ReviewMode | null;

export const REVIEW_MODE_LABEL: Record<ReviewMode, string> = { optional: 'Optional', required: 'Required' };
export const QA_LANGUAGE_LABEL: Record<QaLanguage, string> = { pl: 'Polski', en: 'English' };

function reviewMode(value: unknown): ReviewMode | null {
  return value === 'optional' || value === 'required' ? value : null;
}

/** The review mode that applies to the task (project setting, else the global one); null from an older Core. */
export function taskReviewMode(task: TaskSummary): ReviewMode | null {
  return reviewMode((task as { effectiveReviewMode?: unknown }).effectiveReviewMode);
}

/** Whether the user sent the task to independent review at acceptance; null when not decided or unknown. */
export function taskReviewRequested(task: TaskSummary): boolean | null {
  const value = (task as { reviewRequested?: unknown }).reviewRequested;
  return typeof value === 'boolean' ? value : null;
}

/** The project's own review setting; undefined from an older Core that has none. */
export function projectOwnReviewMode(project: ProjectSummary): ProjectReviewMode | undefined {
  const value = (project as { reviewMode?: unknown }).reviewMode;
  if (value === null) return null;
  return reviewMode(value) ?? undefined;
}

export function projectReviewMode(project: ProjectSummary): ReviewMode | null {
  return reviewMode((project as { effectiveReviewMode?: unknown }).effectiveReviewMode);
}

/** The language the QA scenarios were written in, when the report says so. */
export function reportQaLanguage(report: ImplementationReportRecord): QaLanguage | null {
  for (const value of [(report as { qaLanguage?: unknown }).qaLanguage, (report.document as { qaLanguage?: unknown }).qaLanguage]) {
    if (value === 'pl' || value === 'en') return value;
  }
  return null;
}

/** Whether the review was requested, from the final report; null when it does not say. */
export function finalReportReviewRequested(report: FinalReport): boolean | null {
  const value = (report.review as { requested?: unknown } | null)?.requested;
  return typeof value === 'boolean' ? value : null;
}
