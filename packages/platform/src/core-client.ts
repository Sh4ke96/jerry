import fs from 'node:fs';
import http from 'node:http';
import type { CoreRuntimeInfo } from '@jerry/contracts';
import { isCoreRuntimeInfo } from '@jerry/contracts/guards';
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

/** Reads and validates JERRY_HOME/run/core.json. Throws CoreUnavailableError when missing or malformed. */
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

export interface CoreRequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs: number;
}

/**
 * Minimal JSON-over-loopback client. Uses node:http instead of fetch because the
 * hook bridge runs on every guarded tool call and must start fast.
 */
export function requestCore(info: CoreRuntimeInfo, options: CoreRequestOptions): Promise<unknown> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
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
