import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestCore } from '@jerry/platform';
import { describe, expect, it } from 'vitest';

/**
 * Regression: a long-lived caller (the MCP server) reused a keep-alive socket that Core had just
 * closed and got ECONNRESET. requestCore opens a fresh connection for every request.
 */
describe('requestCore connections', () => {
  it('uses a new connection per request, so an idle gap longer than the server keep-alive never fails', async () => {
    let connections = 0;
    const server = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
    server.keepAliveTimeout = 50;
    server.on('connection', () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const info = { pid: 1, port: (server.address() as AddressInfo).port, token: 'a'.repeat(64), startedAt: new Date().toISOString(), version: 'test' };
    try {
      expect(await requestCore(info, { method: 'GET', path: '/one', timeoutMs: 2000 })).toEqual({ ok: true });
      // Longer than the server's keep-alive: a reused socket would be closed by now.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(await requestCore(info, { method: 'POST', path: '/two', body: { a: 1 }, timeoutMs: 2000 })).toEqual({ ok: true });
      expect(connections).toBe(2);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
