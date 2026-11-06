import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_PROFILE_FORMAT, type ProjectProfile, type WorkspaceGraph } from '@jerry/contracts';
import { buildWorkspaceGraph, fingerprintScan, scanRepository, staleParts, type RepositoryScanResult } from '@jerry/discovery';
import type { StateStore } from './state-store.js';

/**
 * Project profiles (spec §6.4, ADR 0020): the read-only scan of a repository, kept in JERRY's
 * database as a cache. It is refreshed when its sources changed, and never replaces reading the
 * files that matter for a task.
 */

export type ProfileMode = 'cached' | 'auto' | 'force';

/** Whether an executable is on PATH (with PATHEXT on Windows). */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const directories = (env['PATH'] ?? env['Path'] ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => extension.toLowerCase())] : [''];
  return directories.some((directory) => extensions.some((extension) => fs.existsSync(path.join(directory, `${name}${extension}`))));
}

/** Runners that corepack provides when they are not installed globally. */
const COREPACK_RUNNERS = new Set(['pnpm', 'yarn']);

/** How a detected command runs on this machine; which runners are missing. */
export function resolveCommands(scan: RepositoryScanResult, isOnPath: (name: string) => boolean): Pick<ProjectProfile, 'commands' | 'environment'> {
  const missing = new Set<string>();
  const notes: string[] = [];
  const commands = scan.commands.map((command) => {
    const runner = command.command.split(' ')[0] ?? '';
    let run = command.command;
    if (!isOnPath(runner)) {
      if (COREPACK_RUNNERS.has(runner) && isOnPath('corepack')) {
        run = `corepack ${command.command}`;
        const note = `${runner} is not on PATH; run it through corepack`;
        if (!notes.includes(note)) notes.push(note);
      } else {
        missing.add(runner);
      }
    }
    return { kind: command.kind, command: command.command, run, source: command.source };
  });
  return { commands, environment: { missingRunners: [...missing].sort(), notes } };
}

export class ProfileService {
  /** One scan per repository at a time. */
  private readonly inFlight = new Map<string, Promise<ProjectProfile>>();

  constructor(
    private readonly store: StateStore,
    private readonly isOnPath: (name: string) => boolean = (name) => onPath(name),
  ) {}

  /**
   * cached: the stored profile with its staleness, no scan. auto: rescan when missing or stale.
   * force: always rescan. Returns null only in cached mode without a stored profile.
   */
  async get(repoRoot: string, mode: ProfileMode, now: Date = new Date()): Promise<ProjectProfile | null> {
    if (mode !== 'force') {
      const stored = await this.store.storedProfile(repoRoot);
      if (stored !== null) {
        const stale: string[] = staleParts(repoRoot, stored.fingerprints, stored.scannedAt, now);
        // A profile written by an older JERRY lacks newer fields: treat it as stale.
        if (stored.profile.formatVersion < PROJECT_PROFILE_FORMAT) stale.push('format');
        if (mode === 'cached' || stale.length === 0) return { ...stored.profile, checkedAt: now.toISOString(), stale };
      } else if (mode === 'cached') {
        return null;
      }
    }
    return this.refresh(repoRoot, now);
  }

  /** Links between the repositories JERRY has profiles for (ADR 0021); cached profiles only, no scan. */
  async graph(repoRoots: readonly string[]): Promise<WorkspaceGraph> {
    const inputs = [];
    for (const repoRoot of repoRoots) {
      const profile = await this.get(repoRoot, 'cached');
      if (profile === null) continue;
      inputs.push({
        repoRoot,
        names: profile.packages.map((pkg) => pkg.name).filter((name): name is string => name !== null),
        apiSchemas: profile.apiSchemas.map((schema) => schema.path),
        packages: profile.packages,
        contractReferences: profile.contractReferences,
      });
    }
    return buildWorkspaceGraph(inputs);
  }

  private refresh(repoRoot: string, now: Date): Promise<ProjectProfile> {
    const running = this.inFlight.get(repoRoot);
    if (running !== undefined) return running;
    const work = (async () => {
      const scan = scanRepository(repoRoot, now);
      const { root: _root, ...rest } = scan;
      const profile: ProjectProfile = { ...rest, ...resolveCommands(scan, this.isOnPath), formatVersion: PROJECT_PROFILE_FORMAT, repoRoot, checkedAt: now.toISOString(), stale: [] };
      await this.store.saveProfile(repoRoot, profile, fingerprintScan(repoRoot, scan), now);
      return profile;
    })().finally(() => this.inFlight.delete(repoRoot));
    this.inFlight.set(repoRoot, work);
    return work;
  }
}
