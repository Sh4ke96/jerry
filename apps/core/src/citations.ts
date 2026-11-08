import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisReport } from '@jerry/contracts';
import { absolutePath, relativeInside } from '@jerry/policy-engine';
import { fingerprintFiles } from './git-reader.js';

/**
 * Checks an analyst's `path:line` citations against the repository: the file must exist
 * inside it and the line must exist in the file. A model can cite what it never read; this makes
 * such citations visible. Files are read only to count lines and hash them, never stored.
 */
export function checkCitations(repoRoot: string, report: AnalysisReport): { checked: number; missingFiles: string[]; outOfRange: string[]; fileHashes: Record<string, string> } {
  const lineCounts = new Map<string, number | null>();
  const linesOf = (relative: string): number | null => {
    if (!lineCounts.has(relative)) {
      try {
        const full = path.join(repoRoot, ...relative.split('/'));
        const stat = fs.statSync(full);
        lineCounts.set(relative, stat.isFile() && stat.size <= 4 * 1024 * 1024 ? fs.readFileSync(full, 'utf8').split(/\r?\n/).length : stat.isFile() ? Number.MAX_SAFE_INTEGER : null);
      } catch {
        lineCounts.set(relative, null);
      }
    }
    return lineCounts.get(relative) ?? null;
  };
  const missing = new Set<string>();
  const outOfRange: string[] = [];
  let checked = 0;
  for (const observation of report.observations) {
    for (const evidence of observation.evidence) {
      const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(evidence.trim());
      if (match === null) continue;
      checked += 1;
      const cited = match[1]!.replace(/^\.\//, '');
      const relative = relativeInside(absolutePath(cited, repoRoot, process.platform), repoRoot, process.platform);
      const lines = relative === null || relative === '' ? null : linesOf(relative);
      if (lines === null) {
        missing.add(cited);
        continue;
      }
      const last = Number(match[3] ?? match[2]);
      if (Number(match[2]) < 1 || last > lines) outOfRange.push(evidence.trim());
    }
  }
  // What the files looked like when the analyst read them, so a later reader knows whether the report
  // still describes the code (hashes only, like Git snapshots; contents are never stored).
  const read = new Set<string>();
  for (const file of [...report.filesRead, ...report.observations.flatMap((observation) => observation.evidence.map((evidence) => evidence.trim().replace(/:\d+(-\d+)?$/, '')))]) {
    const relative = relativeInside(absolutePath(file.replace(/^\.\//, ''), repoRoot, process.platform), repoRoot, process.platform);
    if (relative !== null && relative !== '') read.add(relative);
  }
  const fileHashes = Object.fromEntries(Object.entries(fingerprintFiles(repoRoot, [...read].sort().slice(0, MAX_HASHED_FILES))).filter(([, hash]) => hash !== 'missing'));
  return { checked, missingFiles: [...missing].sort(), outOfRange, fileHashes };
}

/** Files hashed per report: an analyst reads tens, not thousands. */
const MAX_HASHED_FILES = 200;
