import fs from 'node:fs';
import path from 'node:path';

/**
 * Serves the built dashboard (dist/core/dashboard). The files are read once when Core starts, so a
 * running Core always serves the dashboard of its own version: replacing the files on disk (a new
 * build or install) takes effect after a restart, never half-way with an older Core behind it.
 * Only single-level file names from known folders are accepted.
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const FOLDERS = ['', 'assets', 'icons'] as const;
type Folder = (typeof FOLDERS)[number];

/** The built dashboard is well below this; anything larger is not loaded into memory. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

export interface DashboardFiles {
  read(folder: Folder, name: string): StaticFile | null;
}

const SAFE_NAME = /^[A-Za-z0-9][\w.-]*$/;

/** Reads the dashboard into memory; an absent directory gives an empty set (Core shows a placeholder). */
export function loadDashboard(dashboardDir: string | undefined): DashboardFiles {
  const files = new Map<string, StaticFile>();
  if (dashboardDir !== undefined) {
    const root = path.resolve(dashboardDir);
    let total = 0;
    for (const folder of FOLDERS) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(root, folder));
      } catch {
        continue;
      }
      for (const name of names) {
        const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()];
        if (contentType === undefined || !SAFE_NAME.test(name)) continue;
        try {
          const body = fs.readFileSync(path.join(root, folder, name));
          total += body.length;
          if (total > MAX_TOTAL_BYTES) break;
          files.set(`${folder}/${name}`, { body, contentType });
        } catch {
          // a directory or an unreadable file: not served
        }
      }
    }
  }
  return { read: (folder, name) => (SAFE_NAME.test(name) ? (files.get(`${folder}/${name}`) ?? null) : null) };
}
