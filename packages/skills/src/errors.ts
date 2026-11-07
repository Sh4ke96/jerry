import type { SkillErrorDetails } from '@jerry/contracts';

/**
 * A refusal with the HTTP status Core answers with (Core's error handler uses statusCode). The
 * message is shown to the user as it is, so it says what to do.
 */
export class SkillError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    /** Sent with the error (e.g. the skill folders to pick from); Core passes it on as "details". */
    readonly details?: SkillErrorDetails,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

/** The skill content is not acceptable (validation). */
export const invalid = (message: string): SkillError => new SkillError(400, message);
