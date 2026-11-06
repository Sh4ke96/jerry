import fs from 'node:fs';
import path from 'node:path';

/**
 * Serves the built dashboard (dist/core/dashboard) from disk. Only single-level file names from
 * known folders are accepted, and the resolved path must stay inside the dashboard directory.
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

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

export function readDashboardFile(dashboardDir: string | undefined, folder: '' | 'assets' | 'icons', name: string): StaticFile | null {
  if (dashboardDir === undefined || !/^[A-Za-z0-9][\w.-]*$/.test(name)) return null;
  const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()];
  if (contentType === undefined) return null;
  const root = path.resolve(dashboardDir);
  const target = path.resolve(root, folder, name);
  if (!target.startsWith(root + path.sep)) return null;
  try {
    return { body: fs.readFileSync(target), contentType };
  } catch {
    return null;
  }
}
