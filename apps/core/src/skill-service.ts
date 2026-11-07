import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  SKILL_CHANGE_NOTE,
  SKILL_OVERRIDE_ON,
  WORKFLOW_STATES,
  skillFileSchema,
  skillScanFindingSchema,
  type WorkflowState,
  type AddedSkill,
  type OtherSkill,
  type SkillChangeResult,
  type SkillDetail,
  type SkillDiff,
  type SkillFile,
  type SkillPreview,
  type SkillScanFinding,
  type SkillSource,
  type SkillsList,
} from '@jerry/contracts';
import type { JerrySchema } from '@jerry/database';
import {
  backupSkillCopy,
  backupSkillFolder,
  contentHashOf,
  fieldText,
  folderContentHash,
  jerryTriggeredFiles,
  listSkillFiles,
  sha256,
  withJerryTrigger,
  loadSkill,
  parseFrontmatter,
  placeSkill,
  scanSummary,
  setSkillEnabled,
  SkillError,
  skillDir,
  skillOverride,
  skillsDir,
  skillStagingRoot,
  writeSkillFiles,
  type GitHubFetchOptions,
  type LoadedSkill,
  type SkillInput,
} from '@jerry/skills';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';

/**
 * The skills the user adds through JERRY. A preview reads, validates and scans the skill and stages
 * its files in JERRY_HOME/run/skill-staging (nothing runs); installing copies exactly what was
 * previewed (its hash is checked again) into CLAUDE_CONFIG_DIR/skills/<name>. A folder there that
 * JERRY did not install is never replaced or removed. Every change is recorded in skill_events.
 */

export type SkillChannel = 'cli' | 'dashboard';

export interface SkillServiceOptions {
  db: Kysely<JerrySchema>;
  home: string;
  claudeConfigDir: string;
  /** Folders with JERRY's own plugin skills (the first that exists is listed). */
  pluginSkillDirs: () => readonly string[];
  github?: GitHubFetchOptions;
}

/** How long a preview may be installed. */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;
/** Previews kept at once; the oldest goes first. */
const MAX_PREVIEWS = 20;
/** SKILL.md shown in a preview or on the skill page at most. */
const MAX_SKILL_MD_CHARS = 256 * 1024;

interface StagedPreview {
  preview: SkillPreview;
  stagedDir: string;
  /** Update: the skill it updates. */
  updates: string | null;
  createdAt: number;
}

type SkillRow = Selectable<JerrySchema['skills']>;

const filesOf = (row: SkillRow): SkillFile[] => z.array(skillFileSchema).catch([]).parse(JSON.parse(row.files_json));
/** The assigned states in workflow order; unknown values are dropped. */
const statesOf = (row: Pick<SkillRow, 'states_json'>): WorkflowState[] => {
  const stored = new Set(z.array(z.string()).catch([]).parse(JSON.parse(row.states_json)));
  return WORKFLOW_STATES.filter((state) => stored.has(state));
};
/** What JERRY knows of an added skill for the gate and the next action. */
export interface SkillTrigger {
  description: string;
  /** Switched on and converted: JERRY starts it. */
  active: boolean;
  states: WorkflowState[];
}
const scanOf = (row: SkillRow): SkillScanFinding[] => z.array(skillScanFindingSchema).catch([]).parse(JSON.parse(row.scan_json));
const clip = (text: string): string => (text.length > MAX_SKILL_MD_CHARS ? `${text.slice(0, MAX_SKILL_MD_CHARS)}\n\n… (shortened)` : text);

export function diffFiles(before: readonly SkillFile[], after: readonly SkillFile[]): SkillDiff {
  const old = new Map(before.map((file) => [file.path, file.sha256]));
  const next = new Map(after.map((file) => [file.path, file.sha256]));
  return {
    added: [...next.keys()].filter((file) => !old.has(file)).sort(),
    removed: [...old.keys()].filter((file) => !next.has(file)).sort(),
    changed: [...next].filter(([file, hash]) => old.has(file) && old.get(file) !== hash).map(([file]) => file).sort(),
  };
}

/** Description of a skill folder's SKILL.md; '' when it cannot be read. */
function describeFolder(dir: string): { name: string | null; description: string } {
  try {
    const frontmatter = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    const name = fieldText(frontmatter, 'name');
    return { name: name === '' ? null : name, description: fieldText(frontmatter, 'description') };
  } catch {
    return { name: null, description: '' };
  }
}

export class SkillService {
  private readonly previews = new Map<string, StagedPreview>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SkillServiceOptions) {
    // Previews do not survive a restart: their staged files go.
    fs.rmSync(skillStagingRoot(options.home), { recursive: true, force: true });
  }

  private get locations(): { home: string; claudeConfigDir: string } {
    return { home: this.options.home, claudeConfigDir: this.options.claudeConfigDir };
  }

  /** One change at a time: two installs of the same name never race. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async row(name: string): Promise<SkillRow | undefined> {
    return this.options.db.selectFrom('skills').selectAll().where('name', '=', name).executeTakeFirst();
  }

  private async record(name: string, action: string, channel: SkillChannel, details: Record<string, unknown>, at: Date): Promise<void> {
    await this.options.db.insertInto('skill_events').values({ name, action, channel, details_json: JSON.stringify(details), at: at.toISOString() }).execute();
  }

  // --- Reading --------------------------------------------------------------------------------

  private added(row: SkillRow): AddedSkill {
    const dir = skillDir(this.options.claudeConfigDir, row.name);
    const present = fs.existsSync(dir);
    const files = filesOf(row);
    return {
      kind: 'added',
      name: row.name,
      description: row.description,
      dir,
      source: { kind: row.source_kind as SkillSource['kind'], source: row.source, ref: row.ref, commit: row.commit_sha, path: row.source_kind === 'github' ? sourcePath(row.source) : null },
      contentHash: row.content_hash,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      enabled: skillOverride(this.options.claudeConfigDir, row.name) !== 'off',
      states: statesOf(row),
      jerryTriggered: row.jerry_triggered === 1,
      present,
      modified: present && folderContentHash(dir) !== row.content_hash,
      scan: scanSummary(scanOf(row)),
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    };
  }

  private ownSkills(): OtherSkill[] {
    const dir = this.options.pluginSkillDirs().find((candidate) => fs.existsSync(candidate));
    if (dir === undefined) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
      .map((entry): OtherSkill => {
        const described = describeFolder(path.join(dir, entry.name));
        return { kind: 'jerry', name: `jerry:${described.name ?? entry.name}`, description: described.description, dir: path.join(dir, entry.name) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private personalSkills(managed: ReadonlySet<string>): OtherSkill[] {
    const dir = skillsDir(this.options.claudeConfigDir);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.') && entry.name.toLowerCase() !== 'synced' && !managed.has(entry.name))
      .map((entry): OtherSkill => ({ kind: 'personal', name: entry.name, description: describeFolder(path.join(dir, entry.name)).description, dir: path.join(dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(): Promise<SkillsList> {
    const rows = await this.options.db.selectFrom('skills').selectAll().orderBy('name').execute();
    return {
      skillsDir: skillsDir(this.options.claudeConfigDir),
      own: this.ownSkills(),
      added: rows.map((row) => this.added(row)),
      personal: this.personalSkills(new Set(rows.map((row) => row.name))),
      note: SKILL_CHANGE_NOTE,
    };
  }

  /** Names and content hashes of the added skills (the evals fingerprint). */
  async fingerprints(): Promise<Array<{ name: string; contentHash: string }>> {
    const rows = await this.options.db.selectFrom('skills').select(['name', 'content_hash']).orderBy('name').execute();
    return rows.map((row) => ({ name: row.name, contentHash: row.content_hash }));
  }

  async detail(name: string): Promise<SkillDetail> {
    const row = await this.row(name);
    if (row !== undefined) {
      const skill = this.added(row);
      const skillMdFile = path.join(skill.dir, 'SKILL.md');
      const events = await this.options.db.selectFrom('skill_events').selectAll().where('name', '=', name).orderBy('id', 'desc').limit(100).execute();
      return {
        skill,
        skillMd: fs.existsSync(skillMdFile) ? clip(fs.readFileSync(skillMdFile, 'utf8')) : null,
        files: filesOf(row),
        scan: scanOf(row),
        history: events.map((event) => ({ action: event.action, channel: event.channel, at: event.at, details: z.record(z.string(), z.unknown()).catch({}).parse(JSON.parse(event.details_json)) })),
      };
    }
    const other = [...this.ownSkills(), ...this.personalSkills(new Set())].find((candidate) => candidate.name === name);
    if (other === undefined) throw new SkillError(404, `No skill named ${name} (see "jerry skill list").`);
    const skillMdFile = path.join(other.dir, 'SKILL.md');
    return { skill: other, skillMd: fs.existsSync(skillMdFile) ? clip(fs.readFileSync(skillMdFile, 'utf8')) : null, files: listSkillFiles(other.dir) ?? [], scan: [], history: [] };
  }

  // --- Previews -------------------------------------------------------------------------------

  private sweep(now: number): void {
    for (const [id, staged] of this.previews) {
      if (now - staged.createdAt > PREVIEW_TTL_MS) this.dropPreview(id);
    }
    while (this.previews.size >= MAX_PREVIEWS) this.dropPreview(this.previews.keys().next().value!);
  }

  private dropPreview(id: string): void {
    this.previews.delete(id);
    fs.rmSync(path.join(skillStagingRoot(this.options.home), id), { recursive: true, force: true });
  }

  /** The preview a confirmation is about; 404 when it expired. */
  previewOf(previewId: string): SkillPreview {
    const staged = this.previews.get(previewId);
    if (staged === undefined || Date.now() - staged.createdAt > PREVIEW_TTL_MS) throw new SkillError(404, 'This preview expired or does not exist; preview the skill again.');
    return staged.preview;
  }

  private async load(input: SkillInput): Promise<LoadedSkill> {
    return loadSkill(input, { ...(this.options.github === undefined ? {} : { github: this.options.github }), forbiddenRoots: [this.options.home] });
  }

  private async stage(loaded: LoadedSkill, purpose: 'install' | 'update', updates: SkillRow | null): Promise<SkillPreview> {
    const now = Date.now();
    this.sweep(now);
    const { skill: original } = loaded;
    // What is installed is the skill with JERRY's frontmatter (user-invocable: false): JERRY starts it,
    // Claude uses it. The preview shows, hashes and stages exactly that; the scan reads the original.
    const content = jerryTriggeredFiles(loaded.content.files);
    const installedFiles = content.map((file): SkillFile => ({ path: file.path, size: file.data.length, sha256: sha256(file.data) })).sort((a, b) => (a.path < b.path ? -1 : 1));
    const skill = {
      ...original,
      skillMd: withJerryTrigger(original.skillMd),
      files: installedFiles,
      totalBytes: installedFiles.reduce((sum, file) => sum + file.size, 0),
      contentHash: contentHashOf(installedFiles),
    };
    const previewId = `skp_${randomBytes(12).toString('hex')}`;
    const stagedDir = path.join(skillStagingRoot(this.options.home), previewId, skill.name);
    writeSkillFiles(stagedDir, content);
    const targetDir = skillDir(this.options.claudeConfigDir, skill.name);
    let blocked: string | null = null;
    if (purpose === 'install') {
      const existing = await this.row(skill.name);
      if (existing !== undefined) blocked = `JERRY already installed ${skill.name}; update it instead ("jerry skill update ${skill.name}").`;
      else if (fs.existsSync(targetDir)) blocked = `${targetDir} exists and JERRY did not install it, so JERRY leaves it alone. Remove or rename that folder yourself, or give the new skill another name.`;
    } else if (updates !== null && skill.name !== updates.name) {
      blocked = `This version is named ${skill.name}, not ${updates.name}; add it as a new skill instead.`;
    }
    const diff = updates === null ? null : diffFiles(filesOf(updates), skill.files);
    const preview: SkillPreview = {
      previewId,
      purpose,
      name: skill.name,
      description: skill.description,
      source: loaded.source,
      skillMd: clip(skill.skillMd),
      files: skill.files,
      totalBytes: skill.totalBytes,
      contentHash: skill.contentHash,
      scan: loaded.scan,
      targetDir,
      blocked,
      diff,
      upToDate: updates !== null && updates.content_hash === skill.contentHash,
      expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    };
    this.previews.set(previewId, { preview, stagedDir, updates: updates?.name ?? null, createdAt: now });
    return preview;
  }

  async preview(input: SkillInput): Promise<SkillPreview> {
    return this.stage(await this.load(input), 'install', null);
  }

  /** The new version of an installed skill: from the same source, or from the one given. */
  async previewUpdate(name: string, input: SkillInput | null): Promise<SkillPreview> {
    const row = await this.row(name);
    if (row === undefined) throw new SkillError(404, `JERRY did not install a skill named ${name}; only skills JERRY installed can be updated.`);
    if (input === null && row.source_kind === 'zip' && !path.isAbsolute(row.source)) {
      throw new SkillError(400, `${name} came from an uploaded file (${row.source}); choose the new file to update it.`);
    }
    return this.stage(await this.load(input ?? { source: row.source }), 'update', row);
  }

  // --- Changes --------------------------------------------------------------------------------

  private takePreview(previewId: string, purpose: 'install' | 'update'): StagedPreview {
    const preview = this.previewOf(previewId);
    if (preview.purpose !== purpose) throw new SkillError(400, `This preview is for ${preview.purpose === 'install' ? 'installing' : 'updating'} a skill.`);
    if (preview.blocked !== null) throw new SkillError(409, preview.blocked);
    const staged = this.previews.get(previewId)!;
    // What goes in is exactly what was previewed.
    if (folderContentHash(staged.stagedDir) !== preview.contentHash) {
      this.dropPreview(previewId);
      throw new SkillError(409, 'The staged files changed since the preview; preview the skill again.');
    }
    return staged;
  }

  async install(previewId: string, channel: SkillChannel, now: Date = new Date()): Promise<SkillChangeResult> {
    return this.exclusive(async () => {
      const staged = this.takePreview(previewId, 'install');
      const { preview } = staged;
      // Checked again: the folder may have appeared since the preview.
      if ((await this.row(preview.name)) !== undefined) throw new SkillError(409, `JERRY already installed ${preview.name}; update it instead.`);
      if (fs.existsSync(preview.targetDir)) throw new SkillError(409, `${preview.targetDir} exists and JERRY did not install it, so JERRY leaves it alone.`);
      fs.mkdirSync(skillsDir(this.options.claudeConfigDir), { recursive: true });
      placeSkill(this.locations, staged.stagedDir, preview.name, { replace: false });
      // Claude sees only the name (skillOverrides "name-only"), so it never picks the skill on its own.
      const enabled = skillOverride(this.options.claudeConfigDir, preview.name) !== 'off';
      const settings = enabled ? setSkillEnabled(this.locations, preview.name, true) : null;
      const at = now.toISOString();
      await this.options.db
        .insertInto('skills')
        .values({
          name: preview.name,
          description: preview.description,
          source_kind: preview.source.kind,
          source: preview.source.source,
          ref: preview.source.ref,
          commit_sha: preview.source.commit,
          content_hash: preview.contentHash,
          files_json: JSON.stringify(preview.files),
          scan_json: JSON.stringify(preview.scan),
          enabled: enabled ? 1 : 0,
          states_json: '[]',
          jerry_triggered: 1,
          installed_at: at,
          updated_at: at,
        })
        .execute();
      await this.record(preview.name, 'installed', channel, { source: preview.source, contentHash: preview.contentHash, files: preview.files.length, scan: scanSummary(preview.scan), settingsBackup: settings?.settingsBackup ?? null }, now);
      this.dropPreview(previewId);
      await this.refreshTriggers();
      return this.result(preview.name, 'installed', null, settings?.settingsBackup ?? null);
    });
  }

  async applyUpdate(previewId: string, channel: SkillChannel, now: Date = new Date()): Promise<SkillChangeResult> {
    return this.exclusive(async () => {
      const staged = this.takePreview(previewId, 'update');
      const { preview } = staged;
      const row = await this.row(preview.name);
      if (row === undefined || staged.updates !== preview.name) throw new SkillError(404, `JERRY did not install a skill named ${preview.name}.`);
      if (row.content_hash === preview.contentHash && folderContentHash(preview.targetDir) === preview.contentHash) {
        this.dropPreview(previewId);
        return this.result(preview.name, 'unchanged', null, null);
      }
      const placed = placeSkill(this.locations, staged.stagedDir, preview.name, { replace: true });
      // The new version carries JERRY's frontmatter; an older install switched on moves to "name-only".
      const settings = skillOverride(this.options.claudeConfigDir, preview.name) !== 'off' ? setSkillEnabled(this.locations, preview.name, true) : null;
      await this.options.db
        .updateTable('skills')
        .set({
          description: preview.description,
          source_kind: preview.source.kind,
          source: preview.source.source,
          ref: preview.source.ref,
          commit_sha: preview.source.commit,
          content_hash: preview.contentHash,
          files_json: JSON.stringify(preview.files),
          scan_json: JSON.stringify(preview.scan),
          jerry_triggered: 1,
          updated_at: now.toISOString(),
        })
        .where('name', '=', preview.name)
        .execute();
      await this.record(preview.name, 'updated', channel, { source: preview.source, from: row.content_hash, contentHash: preview.contentHash, diff: preview.diff, backupDir: placed.backupDir, scan: scanSummary(preview.scan), settingsBackup: settings?.settingsBackup ?? null }, now);
      this.dropPreview(previewId);
      await this.refreshTriggers();
      return this.result(preview.name, 'updated', placed.backupDir, settings?.settingsBackup ?? null);
    });
  }

  async setEnabled(name: string, enabled: boolean, channel: SkillChannel, now: Date = new Date()): Promise<SkillChangeResult> {
    return this.exclusive(async () => {
      const row = await this.row(name);
      if (row === undefined) throw new SkillError(404, `JERRY did not install a skill named ${name}; JERRY switches only the skills it installed.`);
      const change = setSkillEnabled(this.locations, name, enabled, row.jerry_triggered === 1 ? SKILL_OVERRIDE_ON : null);
      await this.options.db.updateTable('skills').set({ enabled: enabled ? 1 : 0, updated_at: now.toISOString() }).where('name', '=', name).execute();
      if (change.changed) await this.record(name, enabled ? 'enabled' : 'disabled', channel, { settingsBackup: change.settingsBackup }, now);
      await this.refreshTriggers();
      return this.result(name, change.changed ? (enabled ? 'enabled' : 'disabled') : 'unchanged', null, change.settingsBackup);
    });
  }

  /**
   * The task states JERRY starts a skill in (empty: never). A skill installed before JERRY started
   * skills is converted first: its folder is copied to JERRY's backups, SKILL.md gets
   * "user-invocable: false", and a switched-on skill moves to skillOverrides "name-only".
   */
  async setStates(name: string, states: readonly WorkflowState[], channel: SkillChannel, now: Date = new Date()): Promise<SkillChangeResult> {
    return this.exclusive(async () => {
      const row = await this.row(name);
      if (row === undefined) throw new SkillError(404, `JERRY did not install a skill named ${name}; JERRY starts only the skills it installed.`);
      const ordered = WORKFLOW_STATES.filter((state) => states.includes(state));
      if (row.jerry_triggered === 1 && statesOf(row).join() === ordered.join()) return this.result(name, 'unchanged', null, null);
      let backupDir: string | null = null;
      let settingsBackup: string | null = null;
      const set: { states_json: string; updated_at: string; jerry_triggered?: number; files_json?: string; content_hash?: string } = { states_json: JSON.stringify(ordered), updated_at: now.toISOString() };
      if (row.jerry_triggered !== 1) {
        const converted = this.convert(row);
        backupDir = converted.backupDir;
        Object.assign(set, { jerry_triggered: 1, files_json: JSON.stringify(converted.files), content_hash: contentHashOf(converted.files) });
        if (skillOverride(this.options.claudeConfigDir, name) !== 'off') settingsBackup = setSkillEnabled(this.locations, name, true).settingsBackup;
      }
      await this.options.db.updateTable('skills').set(set).where('name', '=', name).execute();
      await this.record(name, 'states-set', channel, { states: ordered, from: statesOf(row), converted: row.jerry_triggered !== 1, backupDir, settingsBackup }, now);
      await this.refreshTriggers();
      return this.result(name, 'states-set', backupDir, settingsBackup);
    });
  }

  /**
   * Gives an installed skill JERRY's frontmatter in place, after copying its folder to the backups.
   * The recorded files change only for SKILL.md, and only when SKILL.md was as JERRY installed it, so
   * a skill changed by hand still shows as changed.
   */
  private convert(row: SkillRow): { files: SkillFile[]; backupDir: string } {
    const dir = skillDir(this.options.claudeConfigDir, row.name);
    const skillMdFile = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMdFile)) throw new SkillError(409, `${skillMdFile} is missing; update or remove the skill first.`);
    const before = fs.readFileSync(skillMdFile);
    const after = Buffer.from(withJerryTrigger(before.toString('utf8')), 'utf8');
    const backupDir = backupSkillCopy(this.options.home, dir, row.name);
    const temporary = `${skillMdFile}.jerry-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(temporary, after, { flag: 'wx' });
    fs.renameSync(temporary, skillMdFile);
    const files = filesOf(row).map((file) => (file.path === 'SKILL.md' && file.sha256 === sha256(before) ? { path: file.path, size: after.length, sha256: sha256(after) } : file));
    return { files, backupDir };
  }

  // --- JERRY starts the skills ----------------------------------------------------------------

  private triggerMap = new Map<string, SkillTrigger>();

  /** Reloads what the gate and the next action read; called on start and after every change. */
  async refreshTriggers(): Promise<void> {
    const rows = await this.options.db.selectFrom('skills').select(['name', 'description', 'enabled', 'states_json', 'jerry_triggered']).execute();
    this.triggerMap = new Map(
      rows.map((row) => [row.name, { description: row.description, active: row.jerry_triggered === 1 && skillOverride(this.options.claudeConfigDir, row.name) !== 'off', states: statesOf(row) }]),
    );
  }

  /** The states JERRY starts a skill in, or null when JERRY does not start it (synchronous, for the gate). */
  triggerStates(name: string): readonly WorkflowState[] | null {
    const trigger = this.triggerMap.get(name);
    return trigger === undefined || !trigger.active ? null : trigger.states;
  }

  /** The skills JERRY starts, with their states (only those assigned to at least one). */
  triggers(): Array<{ name: string; description: string; states: WorkflowState[] }> {
    return [...this.triggerMap]
      .filter(([, trigger]) => trigger.active && trigger.states.length > 0)
      .map(([name, trigger]) => ({ name, description: trigger.description, states: trigger.states }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string, channel: SkillChannel, now: Date = new Date()): Promise<SkillChangeResult> {
    return this.exclusive(async () => {
      const row = await this.row(name);
      if (row === undefined) throw new SkillError(404, `JERRY did not install a skill named ${name}; JERRY removes only the skills it installed.`);
      const dir = skillDir(this.options.claudeConfigDir, name);
      const backupDir = fs.existsSync(dir) ? backupSkillFolder(this.options.home, dir, name) : null;
      // JERRY's "off" for a skill that is gone would only confuse a later skill of that name.
      const override = skillOverride(this.options.claudeConfigDir, name);
      const settings = override === 'off' || override === SKILL_OVERRIDE_ON ? setSkillEnabled(this.locations, name, true, null) : null;
      await this.options.db.deleteFrom('skills').where('name', '=', name).execute();
      await this.record(name, 'removed', channel, { backupDir, contentHash: row.content_hash, settingsBackup: settings?.settingsBackup ?? null }, now);
      await this.refreshTriggers();
      return { name, action: 'removed', skill: null, backupDir, settingsBackup: settings?.settingsBackup ?? null, note: SKILL_CHANGE_NOTE };
    });
  }

  private async result(name: string, action: SkillChangeResult['action'], backupDir: string | null, settingsBackup: string | null): Promise<SkillChangeResult> {
    const row = await this.row(name);
    return { name, action, skill: row === undefined ? null : this.added(row), backupDir, settingsBackup, note: SKILL_CHANGE_NOTE };
  }
}

/** The folder a GitHub source URL names ('' for the repository root); null when it does not parse. */
function sourcePath(url: string): string | null {
  const match = /^https:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+(?:\/(?:tree|blob)\/[^/]+\/?(.*))?$/i.exec(url.trim());
  if (match === null) return null;
  return (match[1] ?? '').replace(/\/?SKILL\.md$/, '').replace(/\/$/, '');
}
