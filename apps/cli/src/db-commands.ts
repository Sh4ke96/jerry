import path from 'node:path';
import readline from 'node:readline/promises';
import { databaseBackupResultSchema } from '@jerry/contracts';
import { listBackups, restoreDatabase } from '@jerry/database';
import { CoreUnavailableError, jerryPaths, readCoreRuntimeInfo, requestCore, resolveJerryHome } from '@jerry/platform';

/** Online backup taken by the running Core. */
export async function backupNow(): Promise<void> {
  const info = readCoreRuntimeInfo(resolveJerryHome());
  const result = databaseBackupResultSchema.parse(await requestCore(info, { method: 'POST', path: '/api/v1/database/backups', body: {}, timeoutMs: 30_000 }));
  console.log(`Backup written to ${result.file}`);
}

export function showBackups(): void {
  const backups = listBackups(jerryPaths(resolveJerryHome()).backupsDir);
  if (backups.length === 0) {
    console.log('No backups yet.');
    return;
  }
  for (const backup of backups) {
    console.log(`${backup.modifiedAt}  ${(backup.size / 1024).toFixed(0).padStart(6)} KiB  ${backup.file}`);
  }
}

/**
 * Replaces JERRY's database with a backup. Needs Core stopped (it holds the database open), an
 * interactive terminal and a typed confirmation; the current database is backed up first.
 */
export async function restoreFromBackup(backupFile: string): Promise<void> {
  const home = resolveJerryHome();
  const paths = jerryPaths(home);
  try {
    const info = readCoreRuntimeInfo(home);
    await requestCore(info, { method: 'GET', path: '/api/v1/status', timeoutMs: 1500 });
    throw new Error('JERRY Core is running. Stop it first with "jerry core stop".');
  } catch (error) {
    if (!(error instanceof CoreUnavailableError)) throw error;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Restoring the database requires an interactive terminal (PowerShell or the VS Code terminal).');
  }
  const source = path.resolve(backupFile);
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await prompt.question(`Replace ${paths.databaseFile}\nwith ${source}?\nThe current database is backed up first. Type "restore" to confirm: `)).trim();
  prompt.close();
  if (typed !== 'restore') {
    console.log('Confirmation did not match. Nothing changed.');
    process.exitCode = 1;
    return;
  }
  const { safetyBackup } = await restoreDatabase({ file: paths.databaseFile, backupsDir: paths.backupsDir, backupFile: source });
  console.log(`Restored ${source}.${safetyBackup === null ? '' : ` The previous database was saved as ${safetyBackup}.`}`);
  console.log('Start Core again with "jerry core start".');
}
