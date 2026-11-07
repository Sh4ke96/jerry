import { MAX_SKILL_BYTES, MAX_SKILL_FILES } from '@jerry/contracts';
import { isSkippedPath, type SkillContentFile } from './content.js';
import { invalid, SkillError } from './errors.js';
import { isSafeEntryName } from './zip.js';

/**
 * Skills from GitHub: a repository, folder (tree/<ref>/<path>) or SKILL.md (blob/<ref>/…) URL is
 * resolved to a commit SHA through the GitHub API; only the skill's folder at that commit is listed
 * (Git Trees API) and downloaded file by file (raw.githubusercontent.com), so the size of the rest
 * of the repository does not matter. HTTPS only, to the allow-listed GitHub hosts, with size and
 * time limits; no credentials are sent. Tests inject local endpoints.
 */

export interface GitHubLocation {
  owner: string;
  repo: string;
  /** Branch, tag or commit; null: the default branch. */
  ref: string | null;
  /** Folder in the repository ('' for its root). */
  path: string;
}

export interface GitHubEndpoints {
  /** Default https://api.github.com. */
  api: string;
  /** Default https://raw.githubusercontent.com: the skill's files at a commit. */
  raw: string;
}

export const GITHUB_ENDPOINTS: GitHubEndpoints = { api: 'https://api.github.com', raw: 'https://raw.githubusercontent.com' };
/** Hosts a download may go to (redirects included). */
export const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'api.github.com', 'raw.githubusercontent.com']);
export const MAX_API_BYTES = 256 * 1024;
/** A recursive folder listing read at most (GitHub itself stops at about 7 MB). */
export const MAX_TREE_BYTES = 16 * 1024 * 1024;
export const GITHUB_TIMEOUT_MS = 60_000;
/** Files downloaded at once. */
export const DOWNLOAD_CONCURRENCY = 8;
/** Skill folders offered when a URL holds several. */
export const MAX_CANDIDATES = 20;

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** True for text that looks like a URL (the CLI and dashboard tell URLs from paths with it). */
export function looksLikeUrl(source: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source.trim());
}

export function parseGitHubUrl(input: string): GitHubLocation {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw invalid(`"${input.slice(0, 200)}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:') throw invalid('Only https:// GitHub URLs are accepted.');
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') throw invalid(`Only GitHub URLs (https://github.com/…) are accepted, not ${host}.`);
  if (url.username !== '' || url.password !== '' || url.port !== '') throw invalid('The GitHub URL may not carry credentials or a port.');
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
  const [owner, rawRepo, kind, ref, ...rest] = segments;
  if (owner === undefined || rawRepo === undefined) throw invalid('Give a GitHub repository URL: https://github.com/<owner>/<repo>[/tree/<ref>/<folder>].');
  const repo = rawRepo.replace(/\.git$/, '');
  if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith('.') || repo.startsWith('.')) throw invalid('The GitHub owner or repository name is not valid.');
  if (kind === undefined) return { owner, repo, ref: null, path: '' };
  if ((kind !== 'tree' && kind !== 'blob') || ref === undefined || ref === '') throw invalid('Use a repository, folder (…/tree/<ref>/<folder>) or SKILL.md (…/blob/<ref>/<folder>/SKILL.md) URL.');
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes('..')) throw invalid('The branch, tag or commit in the URL is not valid.');
  let parts = rest;
  if (kind === 'blob') {
    if (parts.at(-1) !== 'SKILL.md') throw invalid('A file URL must point to a SKILL.md; or give the folder URL (…/tree/<ref>/<folder>).');
    parts = parts.slice(0, -1);
  }
  if (parts.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) throw invalid('The folder in the URL is not valid.');
  return { owner, repo, ref, path: parts.join('/') };
}

/** The canonical URL of a folder in a repository at a ref. */
export function gitHubFolderUrl(location: GitHubLocation, folder: string, ref: string): string {
  return `https://github.com/${location.owner}/${location.repo}/tree/${ref}/${folder}`.replace(/\/$/, '');
}

export interface DownloadLimits {
  maxBytes: number;
  timeoutMs: number;
  accept?: string;
}

/** Hosts of the endpoints in use plus GitHub's own; only these are fetched, also after a redirect. */
function allowed(endpoints: GitHubEndpoints): (url: URL) => boolean {
  const origins = new Set([new URL(endpoints.api).origin, new URL(endpoints.raw).origin]);
  return (url) => origins.has(url.origin) || (url.protocol === 'https:' && GITHUB_HOSTS.has(url.hostname.toLowerCase()) && url.port === '');
}

async function download(start: string, endpoints: GitHubEndpoints, limits: DownloadLimits): Promise<Buffer> {
  const isAllowed = allowed(endpoints);
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let url = new URL(start);
  for (let redirects = 0; ; redirects += 1) {
    if (!isAllowed(url)) throw new SkillError(502, `JERRY does not download from ${url.origin}; only GitHub over HTTPS.`);
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal, headers: { accept: limits.accept ?? '*/*', 'user-agent': 'JERRY-skills' } });
    } catch (error) {
      const reason = (error as Error).name === 'TimeoutError' ? `no answer within ${Math.round(limits.timeoutMs / 1000)} s` : (error as Error).message;
      throw new SkillError(502, `GitHub could not be reached (${reason}).`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (location === null || redirects >= 3) throw new SkillError(502, 'GitHub sent too many or empty redirects.');
      url = new URL(location, url);
      continue;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new SkillError(404, 'GitHub has no such repository, branch, tag or commit (private repositories are not supported).');
    }
    if (response.status === 403 || response.status === 429) {
      await response.body?.cancel();
      throw new SkillError(503, "GitHub refused the request (rate limit for requests without an account); try again later, or download the folder and add it as a zip or folder.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SkillError(502, `GitHub answered ${response.status}.`);
    }
    // Content-Length is the size on the wire: with gzip a tiny file can be larger compressed, so it is
    // only checked for an uncompressed answer; readLimited counts the unpacked bytes either way.
    const encoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
    const declared = encoding === 'identity' ? Number(response.headers.get('content-length') ?? '0') : 0;
    if (declared > limits.maxBytes) {
      await response.body?.cancel();
      throw new SkillError(413, `The download is ${sizeText(declared)}; at most ${sizeText(limits.maxBytes)} are accepted.`);
    }
    return readLimited(response, limits.maxBytes);
  }
}

/** Bytes below 10 KiB, then KiB, then MB: "0 KiB" never hides a small size. */
function sizeText(bytes: number): string {
  if (bytes < 10 * 1024) return `${bytes} bytes`;
  if (bytes < 10 * 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch (error) {
      throw new SkillError(502, `The download from GitHub broke off (${(error as Error).message}).`);
    }
    if (next.done) break;
    total += next.value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SkillError(413, `The download is larger than ${sizeText(maxBytes)}; JERRY stopped it.`);
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

export interface GitHubFetchOptions {
  endpoints?: GitHubEndpoints;
  timeoutMs?: number;
  /** Files downloaded at once. */
  concurrency?: number;
}

export interface GitHubFolder {
  location: GitHubLocation;
  commit: string;
  /** The ref the commit was resolved from (the default branch when the URL named none). */
  resolvedRef: string;
  /** The skill folder's files, relative to it. */
  files: SkillContentFile[];
  /** The folder's name, or the repository's for a skill at its root. */
  nameHint: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

const TREE_ENTRY_TYPES = new Set(['blob', 'tree', 'commit']);

async function getJson(url: string, endpoints: GitHubEndpoints, timeoutMs: number, maxBytes: number): Promise<unknown> {
  const body = await download(url, endpoints, { maxBytes, timeoutMs, accept: 'application/vnd.github+json' });
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new SkillError(502, 'GitHub sent an unreadable answer.');
  }
}

/** One Git tree: its entries and whether GitHub cut the listing short. */
async function getTree(endpoints: GitHubEndpoints, repoPath: string, sha: string, recursive: boolean, timeoutMs: number): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const parsed = await getJson(`${endpoints.api}/repos/${repoPath}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`, endpoints, timeoutMs, MAX_TREE_BYTES);
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const tree = record['tree'];
  if (!Array.isArray(tree)) throw new SkillError(502, 'GitHub sent an unreadable folder listing.');
  const entries = tree.filter(
    (entry): entry is TreeEntry =>
      typeof entry === 'object' && entry !== null && typeof (entry as TreeEntry).path === 'string' && typeof (entry as TreeEntry).sha === 'string' && typeof (entry as TreeEntry).mode === 'string' && TREE_ENTRY_TYPES.has((entry as TreeEntry).type),
  );
  return { entries, truncated: record['truncated'] === true };
}

/** The commit the URL's ref (or the default branch) points to. */
async function resolveCommit(location: GitHubLocation, endpoints: GitHubEndpoints, repoPath: string, timeoutMs: number): Promise<{ ref: string; commit: string }> {
  let ref = location.ref;
  if (ref === null) {
    const parsed = await getJson(`${endpoints.api}/repos/${repoPath}`, endpoints, timeoutMs, MAX_API_BYTES);
    const branch = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['default_branch'] : undefined;
    if (typeof branch !== 'string' || branch === '') throw new SkillError(502, 'GitHub did not name the default branch.');
    ref = branch;
  }
  const commit = (await download(`${endpoints.api}/repos/${repoPath}/commits/${encodeURIComponent(ref)}`, endpoints, { maxBytes: 1024, timeoutMs, accept: 'application/vnd.github.sha' })).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new SkillError(502, 'GitHub did not answer with a commit SHA.');
  return { ref, commit };
}

const encodePath = (value: string): string => value.split('/').map(encodeURIComponent).join('/');
const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Downloads only the skill's folder at a commit, never the whole repository: the folder is found
 * with one non-recursive tree listing per path segment, listed recursively, checked against the
 * skill limits (file count, size, links, submodules, names) BEFORE anything is downloaded, and its
 * files are then fetched one by one from raw.githubusercontent.com at that commit, each at most the
 * size the listing gave. A folder without SKILL.md answers with the folders below it that have one.
 */
export async function fetchGitHubFolder(location: GitHubLocation, options: GitHubFetchOptions = {}): Promise<GitHubFolder> {
  const endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const repoPath = `${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`;
  const { ref, commit } = await resolveCommit(location, endpoints, repoPath, timeoutMs);

  // Walk down to the folder: one small listing per segment.
  let folderSha = commit;
  const segments = location.path === '' ? [] : location.path.split('/');
  for (const [index, segment] of segments.entries()) {
    const { entries } = await getTree(endpoints, repoPath, folderSha, false, timeoutMs);
    const next = entries.find((entry) => entry.path === segment && entry.type === 'tree');
    if (next === undefined) throw new SkillError(404, `The repository has no folder "${segments.slice(0, index + 1).join('/')}" at ${ref}.`);
    folderSha = next.sha;
  }

  const listing = await getTree(endpoints, repoPath, folderSha, true, timeoutMs);
  const where = location.path === '' ? 'the root of the repository' : `"${location.path}"`;
  if (!listing.entries.some((entry) => entry.path === 'SKILL.md' && entry.type === 'blob')) {
    const candidates = listing.entries
      .filter((entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md') && !isSkippedPath(entry.path))
      .map((entry) => entry.path.slice(0, -'/SKILL.md'.length))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
      .slice(0, MAX_CANDIDATES)
      .map((folder) => {
        const full = location.path === '' ? folder : `${location.path}/${folder}`;
        return { folder: full, url: gitHubFolderUrl(location, full, ref) };
      });
    const hint = candidates.length === 0 ? (listing.truncated ? ' The repository is too big to list completely; give the URL of the skill folder (…/tree/<branch>/<folder>).' : '') : ` It holds skills in: ${candidates.map((candidate) => candidate.url).join(', ')}. Add one of them by its folder URL.`;
    throw new SkillError(400, `There is no SKILL.md in ${where}.${hint}`, { candidates });
  }
  if (listing.truncated) throw invalid(`The skill folder ${where} has more files than GitHub lists at once; a skill may have at most ${MAX_SKILL_FILES} files.`);

  // Everything is checked before the first download.
  const blobs: TreeEntry[] = [];
  for (const entry of listing.entries) {
    if (isSkippedPath(entry.path)) continue;
    if (entry.type === 'commit') throw invalid(`${entry.path} is a Git submodule; JERRY installs only files that are in the skill's folder.`);
    if (entry.type !== 'blob') continue;
    if (entry.mode === '120000') throw invalid(`${entry.path} is a symbolic link; skills may not contain links.`);
    if (!isSafeEntryName(entry.path)) throw invalid(`${entry.path} has a name that cannot be installed safely.`);
    blobs.push(entry);
  }
  const total = blobs.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (blobs.length > MAX_SKILL_FILES) throw invalid(`The skill folder has ${blobs.length} files; a skill may have at most ${MAX_SKILL_FILES} files.`);
  if (total > MAX_SKILL_BYTES) throw invalid(`The skill folder is ${megabytes(total)}; a skill may be at most ${MAX_SKILL_BYTES / (1024 * 1024)} MB.`);

  const files: SkillContentFile[] = new Array(blobs.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < blobs.length && !failed; index = next++) {
      const entry = blobs[index]!;
      const size = entry.size ?? 0;
      const full = location.path === '' ? entry.path : `${location.path}/${entry.path}`;
      try {
        const fileBytes = await download(`${endpoints.raw}/${repoPath}/${commit}/${encodePath(full)}`, endpoints, { maxBytes: size, timeoutMs });
        if (fileBytes.length !== size) throw new SkillError(502, `GitHub sent ${fileBytes.length} bytes for ${entry.path} instead of ${size}; try again.`);
        files[index] = { path: entry.path, data: fileBytes };
      } catch (error) {
        // The other downloads stop at their next file.
        failed = true;
        throw error instanceof SkillError && error.statusCode === 413 ? new SkillError(502, `${entry.path}: ${error.message} GitHub sent another size than it listed; try again.`) : error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? DOWNLOAD_CONCURRENCY, Math.max(blobs.length, 1)) }, worker));
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const nameHint = segments.at(-1) ?? location.repo;
  return { location, commit, resolvedRef: ref, files, nameHint };
}
