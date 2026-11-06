import { scanFiles, type RepositoryScan } from './detectors.js';
import { indexDocs, inventoryInstructions, scanForInjection, type DocEntry, type InjectionFinding, type InstructionEntry } from './knowledge.js';
import { readSmallFile, walkRepository, type WalkResult } from './walker.js';

export * from './detectors.js';
export * from './knowledge.js';
export * from './profile.js';
export * from './walker.js';

export interface RepositoryScanResult extends RepositoryScan {
  root: string;
  scannedAt: string;
  files: number;
  truncated: boolean;
  skippedDirectories: string[];
  docs: DocEntry[];
  instructions: InstructionEntry[];
  injection: { findings: InjectionFinding[]; scannedFiles: number; complete: boolean };
}

/**
 * Read-only scan of one repository (ADR 0018, ADR 0019): a bounded file walk, the detectors, the
 * documentation index, the project-instruction inventory and the prompt-injection scan. Nothing
 * is executed and nothing is written; the repository is only read.
 */
export function scanRepository(root: string, now: Date = new Date(), walk: WalkResult = walkRepository(root)): RepositoryScanResult {
  const paths = walk.files.map((file) => file.path);
  const read = (relative: string) => readSmallFile(root, relative);
  return {
    root,
    scannedAt: now.toISOString(),
    files: paths.length,
    truncated: walk.truncated,
    skippedDirectories: walk.skipped,
    ...scanFiles(paths, read),
    docs: indexDocs(walk.files, read),
    instructions: inventoryInstructions(walk.files, read),
    injection: scanForInjection(walk.files, read),
  };
}
