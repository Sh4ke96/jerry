import fs from 'node:fs';
import http from 'node:http';
import type { CoreRuntimeInfo, CoreUserInfo } from '@jerry/contracts';
import { isCoreRuntimeInfo } from '@jerry/contracts/guards';
import { isCoreUserInfo } from './guards.js';
import { jerryPaths } from './jerry-home.js';

export class CoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CoreUnavailableError';
  }
}

export class CoreHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(`JERRY Core responded with HTTP ${statusCode}: ${JSON.stringify(body)}`);
    this.name = 'CoreHttpError';
  }
}

/**
 * Reads and validates JERRY_HOME/run/core.json. Throws CoreUnavailableError when missing or malformed.
 * Its token is the agent token (hooks, MCP server, status line); the jerry CLI uses
 * readCoreRuntimeInfoForUser instead.
 */
export function readCoreRuntimeInfo(jerryHome: string): CoreRuntimeInfo {
  const { coreInfoFile } = jerryPaths(jerryHome);
  let raw: string;
  try {
    raw = fs.readFileSync(coreInfoFile, 'utf8');
  } catch (error) {
    throw new CoreUnavailableError(`Core runtime file not found at ${coreInfoFile} (is Core running?)`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CoreUnavailableError(`Core runtime file ${coreInfoFile} is not valid JSON`, { cause: error });
  }
  if (!isCoreRuntimeInfo(parsed)) {
    throw new CoreUnavailableError(`Core runtime file ${coreInfoFile} has an invalid shape`);
  }
  return parsed;
}

/**
 * Reads and validates JERRY_HOME/run/core-user.json, the user's token. Null when the file is missing,
 * unreadable or malformed, or stale: written by another process than the Core that core.json names
 * (`runtime`, read from core.json when not given). Never throws.
 */
export function readCoreUserInfo(jerryHome: string, runtime?: CoreRuntimeInfo): CoreUserInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(jerryPaths(jerryHome).coreUserFile, 'utf8'));
  } catch {
    return null;
  }
  if (!isCoreUserInfo(parsed)) return null;
  let current: CoreRuntimeInfo;
  try {
    current = runtime ?? readCoreRuntimeInfo(jerryHome);
  } catch {
    return null;
  }
  return parsed.pid === current.pid ? parsed : null;
}

/**
 * Core's runtime info for the user's clients (the jerry CLI): core.json with the user's token from
 * core-user.json, so requestCore sends it. Without a valid core-user.json (an older Core that does not
 * write one) the core.json token is kept; such a Core accepts it for everything. Throws
 * CoreUnavailableError like readCoreRuntimeInfo when core.json is missing or malformed.
 */
export function readCoreRuntimeInfoForUser(jerryHome: string): CoreRuntimeInfo {
  const runtime = readCoreRuntimeInfo(jerryHome);
  const user = readCoreUserInfo(jerryHome, runtime);
  return user === null ? runtime : { ...runtime, token: user.token };
}

export interface CoreRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs: number;
}

/**
 * Minimal JSON-over-loopback client. Uses node:http instead of fetch because the
 * hook bridge runs on every guarded tool call and must start fast.
 *
 * Every request opens its own connection (`agent: false`). Node's global agent keeps connections
 * alive, and a long-lived caller (the MCP server, the dashboard's Core) could reuse a socket that
 * Core closed after its keep-alive timeout: the request then fails with ECONNRESET. On loopback a
 * fresh connection costs next to nothing.
 */
export function requestCore(info: CoreRuntimeInfo, options: CoreRequestOptions): Promise<unknown> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        agent: false,
        method: options.method,
        path: options.path,
        headers: {
          authorization: `Bearer ${info.token}`,
          accept: 'application/json',
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        },
        timeout: options.timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = text === '' ? null : JSON.parse(text);
          } catch (error) {
            reject(new CoreUnavailableError('Core returned a non-JSON response', { cause: error }));
            return;
          }
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new CoreHttpError(statusCode, body));
            return;
          }
          resolve(body);
        });
        response.on('error', (error) => reject(new CoreUnavailableError('Core response stream failed', { cause: error })));
      },
    );
    request.on('timeout', () => {
      request.destroy(new CoreUnavailableError(`Core did not respond within ${options.timeoutMs} ms`));
    });
    request.on('error', (error) => {
      reject(error instanceof CoreUnavailableError ? error : new CoreUnavailableError(`Cannot reach Core: ${error.message}`, { cause: error }));
    });
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}
