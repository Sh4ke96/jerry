import { scanFiles, type RepositoryScan } from './detectors.js';
import { readSmallFile, walkRepository, type WalkResult } from './walker.js';

export * from './detectors.js';
export * from './walker.js';

export interface RepositoryScanResult extends RepositoryScan {
  root: string;
  scannedAt: string;
  files: number;
  truncated: boolean;
  skippedDirectories: string[];
}

/**
 * Read-only scan of one repository (ADR 0018): a bounded file walk plus the detectors. Nothing is
 * executed and nothing is written; the repository is only read.
 */
export function scanRepository(root: string, now: Date = new Date(), walk: WalkResult = walkRepository(root)): RepositoryScanResult {
  const paths = walk.files.map((file) => file.path);
  return {
    root,
    scannedAt: now.toISOString(),
    files: paths.length,
    truncated: walk.truncated,
    skippedDirectories: walk.skipped,
    ...scanFiles(paths, (relative) => readSmallFile(root, relative)),
  };
}
