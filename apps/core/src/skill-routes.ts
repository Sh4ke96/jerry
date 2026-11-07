import { MAX_SKILL_UPLOAD_BYTES, skillApplyRequestSchema, skillConfirmRequestSchema, skillNameSchema, skillPreviewRequestSchema, skillStatesRequestSchema, type DecisionConfirmation, type SkillChangeResult, type SkillDetail, type SkillPreview, type SkillPreviewRequest, type SkillsList } from '@jerry/contracts';
import { SkillError, type SkillInput } from '@jerry/skills';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { SkillChannel, SkillService } from './skill-service.js';

/**
 * Skills routes. Who may call: the CLI token (the CLI asks in a terminal first) or the dashboard
 * session; the app's preHandler checks CSRF and Origin for every state-changing browser request.
 * The dashboard must also type the skill name to install or remove one, and to update one when the
 * decision confirmation setting is "typed". Agents cannot reach these routes (the hard rules block
 * direct Core API calls and "jerry skill add|enable|disable|update|remove|states").
 */

const TOKEN_OR_SESSION = { clients: ['token', 'session'] } as const;
/** A zip from the dashboard arrives as base64 in JSON: 4/3 of the upload limit, plus room for the JSON. */
const PREVIEW_BODY_LIMIT = Math.ceil((MAX_SKILL_UPLOAD_BYTES * 4) / 3) + 64 * 1024;
/** A skill folder from GitHub comes file by file; previews answer within this. */
export const SKILL_PREVIEW_TIMEOUT_MS = 300_000;

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new SkillError(400, `Request validation failed${issue === undefined ? '' : `: ${issue.path.join('.') || 'body'}: ${issue.message}`}`);
  }
  return result.data;
}

const channelOf = (request: FastifyRequest): SkillChannel => (request.client?.kind === 'session' ? 'dashboard' : 'cli');
const fromDashboard = (request: FastifyRequest): boolean => request.client?.kind === 'session';
const typed = (confirmation: string | undefined, name: string): boolean => (confirmation?.trim().toLowerCase() ?? '') === name;

function nameParam(request: FastifyRequest): string {
  const raw = (request.params as { name: string }).name;
  return parse(skillNameSchema, raw.toLowerCase());
}

function inputOf(body: SkillPreviewRequest): SkillInput | null {
  if (body.upload !== undefined) return { upload: { fileName: body.upload.fileName, data: Buffer.from(body.upload.dataBase64, 'base64') } };
  if (body.source !== undefined) return { source: body.source };
  return null;
}

export function registerSkillRoutes(app: FastifyInstance, skills: SkillService, decisionConfirmation: () => DecisionConfirmation): void {
  app.get('/api/v1/skills', { config: TOKEN_OR_SESSION }, async (): Promise<SkillsList> => skills.list());

  // JERRY's own skills are named "jerry:<name>"; added and personal ones by their folder name.
  app.get('/api/v1/skills/:name', { config: TOKEN_OR_SESSION }, async (request): Promise<SkillDetail> => {
    const raw = (request.params as { name: string }).name;
    if (!/^(jerry:)?[a-z0-9][a-z0-9-]{0,63}$/i.test(raw)) throw new SkillError(400, 'Not a skill name');
    return skills.detail(raw.toLowerCase());
  });

  /** Reads, validates, scans and stages a skill; installs nothing. */
  app.post('/api/v1/skills/preview', { config: TOKEN_OR_SESSION, bodyLimit: PREVIEW_BODY_LIMIT }, async (request): Promise<SkillPreview> => {
    const input = inputOf(parse(skillPreviewRequestSchema, request.body));
    if (input === null) throw new SkillError(400, 'Give a GitHub URL, the full path of a folder or zip file, or upload a zip.');
    return skills.preview(input);
  });

  app.post('/api/v1/skills/install', { config: TOKEN_OR_SESSION }, async (request, reply): Promise<SkillChangeResult> => {
    const body = parse(skillApplyRequestSchema, request.body);
    const preview = skills.previewOf(body.previewId);
    // Installing gives Claude new instructions in every session: always typed in the dashboard.
    if (fromDashboard(request) && !typed(body.confirmation, preview.name)) throw new SkillError(400, `Type the skill name (${preview.name}) to install it`);
    return reply.code(201).send(await skills.install(body.previewId, channelOf(request)));
  });

  for (const [verb, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    // One click, like pause and resume: switching back is always possible.
    app.post(`/api/v1/skills/:name/${verb}`, { config: TOKEN_OR_SESSION }, async (request): Promise<SkillChangeResult> => skills.setEnabled(nameParam(request), enabled, channelOf(request)));
  }

  /** The new version from the recorded source, or from the source given (an uploaded zip). */
  app.post('/api/v1/skills/:name/update/preview', { config: TOKEN_OR_SESSION, bodyLimit: PREVIEW_BODY_LIMIT }, async (request): Promise<SkillPreview> => {
    const name = nameParam(request);
    return skills.previewUpdate(name, inputOf(parse(skillPreviewRequestSchema, request.body ?? {})));
  });

  app.post('/api/v1/skills/:name/update/apply', { config: TOKEN_OR_SESSION }, async (request): Promise<SkillChangeResult> => {
    const name = nameParam(request);
    const body = parse(skillApplyRequestSchema, request.body);
    const preview = skills.previewOf(body.previewId);
    if (preview.name !== name || preview.purpose !== 'update') throw new SkillError(400, `This preview is not an update of ${name}`);
    if (fromDashboard(request)) {
      const given = body.confirmation?.trim() ?? '';
      if ((decisionConfirmation() === 'typed' || given !== '') && !typed(given, name)) throw new SkillError(400, `Type the skill name (${name}) to update it`);
    }
    return skills.applyUpdate(body.previewId, channelOf(request));
  });

  /** The task states JERRY starts the skill in; converts a skill installed before that (with a backup). */
  app.post('/api/v1/skills/:name/states', { config: TOKEN_OR_SESSION }, async (request): Promise<SkillChangeResult> => {
    const name = nameParam(request);
    const body = parse(skillStatesRequestSchema, request.body);
    if (fromDashboard(request)) {
      const given = body.confirmation?.trim() ?? '';
      if ((decisionConfirmation() === 'typed' || given !== '') && !typed(given, name)) throw new SkillError(400, `Type the skill name (${name}) to change when JERRY starts it`);
    }
    return skills.setStates(name, body.states, channelOf(request));
  });

  app.post('/api/v1/skills/:name/remove', { config: TOKEN_OR_SESSION }, async (request): Promise<SkillChangeResult> => {
    const name = nameParam(request);
    const body = parse(skillConfirmRequestSchema, request.body ?? {});
    if (fromDashboard(request) && !typed(body.confirmation, name)) throw new SkillError(400, `Type the skill name (${name}) to remove it`);
    return skills.remove(name, channelOf(request));
  });
}
