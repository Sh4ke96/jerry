import { invalid, SkillError } from './errors.js';

/**
 * Skills from GitHub: a repository, folder (tree/<ref>/<path>) or SKILL.md (blob/<ref>/…) URL is
 * resolved to a commit SHA through the GitHub API, then that commit's archive is downloaded from
 * codeload. HTTPS only, to the allow-listed GitHub hosts, with size and time limits; no
 * credentials are sent. Tests inject local endpoints.
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
  /** Default https://codeload.github.com. */
  codeload: string;
}

export const GITHUB_ENDPOINTS: GitHubEndpoints = { api: 'https://api.github.com', codeload: 'https://codeload.github.com' };
/** Hosts a download may go to (redirects included). */
export const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'api.github.com', 'codeload.github.com']);
/** A repository archive downloaded at most (the skill inside is limited separately). */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
export const MAX_API_BYTES = 256 * 1024;
export const GITHUB_TIMEOUT_MS = 60_000;

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
  const origins = new Set([new URL(endpoints.api).origin, new URL(endpoints.codeload).origin]);
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
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limits.maxBytes) {
      await response.body?.cancel();
      throw new SkillError(413, `The download is ${Math.round(declared / 1024)} KiB; at most ${Math.round(limits.maxBytes / 1024)} KiB are accepted.`);
    }
    return readLimited(response, limits.maxBytes);
  }
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
      throw new SkillError(413, `The download is larger than ${Math.round(maxBytes / 1024)} KiB; JERRY stopped it.`);
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

export interface GitHubFetchOptions {
  endpoints?: GitHubEndpoints;
  maxArchiveBytes?: number;
  timeoutMs?: number;
}

export interface GitHubArchive {
  location: GitHubLocation;
  commit: string;
  /** The ref the commit was resolved from (the default branch when the URL named none). */
  resolvedRef: string;
  archive: Buffer;
}

/** Resolves the URL's ref (or the default branch) to a commit and downloads that commit's archive. */
export async function fetchGitHubArchive(location: GitHubLocation, options: GitHubFetchOptions = {}): Promise<GitHubArchive> {
  const endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
  const timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const repoPath = `${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`;
  let ref = location.ref;
  if (ref === null) {
    const body = await download(`${endpoints.api}/repos/${repoPath}`, endpoints, { maxBytes: MAX_API_BYTES, timeoutMs, accept: 'application/vnd.github+json' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new SkillError(502, 'GitHub sent an unreadable answer about the repository.');
    }
    const branch = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['default_branch'] : undefined;
    if (typeof branch !== 'string' || branch === '') throw new SkillError(502, 'GitHub did not name the default branch.');
    ref = branch;
  }
  const shaText = (await download(`${endpoints.api}/repos/${repoPath}/commits/${encodeURIComponent(ref)}`, endpoints, { maxBytes: 1024, timeoutMs, accept: 'application/vnd.github.sha' })).toString('utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(shaText)) throw new SkillError(502, 'GitHub did not answer with a commit SHA.');
  const archive = await download(`${endpoints.codeload}/${repoPath}/zip/${shaText}`, endpoints, { maxBytes: options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES, timeoutMs, accept: 'application/zip' });
  return { location, commit: shaText, resolvedRef: ref, archive };
}
