import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

/**
 * A fake GitHub on 127.0.0.1 for the skills tests (no real network): the repository API (default
 * branch, commit), the Git Trees API (plain and recursive) and raw file downloads at a commit,
 * built from an in-memory map of files. Every request is recorded, so a test can check that only
 * the skill's folder was downloaded.
 */

export type FakeEntry = string | Buffer | { symlink: string } | { submodule: true };

export interface FakeGitHubOptions {
  owner?: string;
  repo?: string;
  branch?: string;
  files: Record<string, FakeEntry>;
  /** The Trees API answers "truncated" for recursive listings. */
  truncated?: boolean;
  /** API requests answer 403 (rate limit). */
  rateLimited?: boolean;
  /** Raw downloads redirect here. */
  rawRedirectTo?: string;
  /** Raw downloads send this many bytes too few or too many. */
  rawSizeSkew?: number;
  /** Raw downloads are gzip-compressed (as GitHub does): tiny files are larger on the wire. */
  gzip?: boolean;
}

export interface FakeGitHub {
  endpoints: { api: string; raw: string };
  commit: string;
  requests: string[];
  close(): Promise<void>;
}

const hash = (text: string): string => createHash('sha1').update(text).digest('hex');

export async function fakeGitHub(options: FakeGitHubOptions): Promise<FakeGitHub> {
  const owner = options.owner ?? 'acme';
  const repo = options.repo ?? 'skills';
  const branch = options.branch ?? 'main';
  const commit = hash(`${owner}/${repo}@${branch}`);
  const requests: string[] = [];
  const treeSha = (dir: string): string => (dir === '' ? commit : hash(`tree:${dir}`));
  const dataOf = (entry: FakeEntry): Buffer | null => (typeof entry === 'string' ? Buffer.from(entry) : Buffer.isBuffer(entry) ? entry : null);

  /** The direct children of a folder, or everything below it with recursive. */
  const listTree = (dir: string, recursive: boolean): object[] => {
    const prefix = dir === '' ? '' : `${dir}/`;
    const entries = new Map<string, object>();
    for (const [file, entry] of Object.entries(options.files)) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      const parts = relative.split('/');
      // Folders on the way.
      for (let depth = 1; depth < parts.length; depth += 1) {
        if (!recursive && depth > 1) break;
        const folder = parts.slice(0, depth).join('/');
        entries.set(folder, { path: folder, mode: '040000', type: 'tree', sha: treeSha(`${prefix}${folder}`) });
      }
      if (!recursive && parts.length > 1) continue;
      if (typeof entry === 'object' && !Buffer.isBuffer(entry) && 'submodule' in entry) entries.set(relative, { path: relative, mode: '160000', type: 'commit', sha: hash(file) });
      else if (typeof entry === 'object' && !Buffer.isBuffer(entry) && 'symlink' in entry) entries.set(relative, { path: relative, mode: '120000', type: 'blob', sha: hash(file), size: entry.symlink.length });
      else entries.set(relative, { path: relative, mode: '100644', type: 'blob', sha: hash(file), size: dataOf(entry)!.length });
    }
    return [...entries.values()];
  };
  const dirOfSha = (sha: string): string | null => {
    if (sha === commit) return '';
    for (const file of Object.keys(options.files)) {
      const parts = file.split('/');
      for (let depth = 1; depth < parts.length; depth += 1) {
        const dir = parts.slice(0, depth).join('/');
        if (treeSha(dir) === sha) return dir;
      }
    }
    return null;
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname + url.search);
    const json = (value: unknown): void => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(value));
    };
    const api = `/api/repos/${owner}/${repo}`;
    if (url.pathname.startsWith('/api/') && options.rateLimited === true) {
      response.writeHead(403);
      return response.end('rate limit');
    }
    if (url.pathname === api) return json({ default_branch: branch });
    if (url.pathname === `${api}/commits/${branch}`) return response.end(commit);
    if (url.pathname.startsWith(`${api}/git/trees/`)) {
      const dir = dirOfSha(url.pathname.slice(`${api}/git/trees/`.length));
      if (dir === null) {
        response.writeHead(404);
        return response.end();
      }
      const recursive = url.searchParams.get('recursive') === '1';
      return json({ sha: treeSha(dir), tree: listTree(dir, recursive), truncated: recursive && options.truncated === true });
    }
    const rawPrefix = `/raw/${owner}/${repo}/${commit}/`;
    if (url.pathname.startsWith(rawPrefix)) {
      if (options.rawRedirectTo !== undefined) {
        response.writeHead(302, { location: options.rawRedirectTo });
        return response.end();
      }
      const entry = options.files[decodeURIComponent(url.pathname.slice(rawPrefix.length))];
      const fileBytes = entry === undefined ? null : dataOf(entry);
      if (fileBytes === null) {
        response.writeHead(404);
        return response.end();
      }
      const skew = options.rawSizeSkew ?? 0;
      if (options.gzip === true) {
        const packed = gzipSync(fileBytes);
        response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(packed.length) });
        return response.end(packed);
      }
      return response.end(skew === 0 ? fileBytes : skew > 0 ? Buffer.concat([fileBytes, Buffer.alloc(skew)]) : fileBytes.subarray(0, fileBytes.length + skew));
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoints: { api: `http://127.0.0.1:${port}/api`, raw: `http://127.0.0.1:${port}/raw` },
    commit,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
