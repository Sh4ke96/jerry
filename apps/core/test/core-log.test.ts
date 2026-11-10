import { describeUncleanEnd, readCoreHeartbeat } from '@jerry/platform';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeError, formatLogLine } from '../src/core-log.js';

describe('core.log lines', () => {
  const at = new Date('2026-11-10T11:30:00.000Z');

  it('prefixes a line with its ISO time and ends it with a newline', () => {
    expect(formatLogLine('JERRY Core stopping: SIGTERM', at)).toBe('2026-11-10T11:30:00.000Z JERRY Core stopping: SIGTERM\n');
    // A trailing newline in the message is not doubled.
    expect(formatLogLine('done\n', at)).toBe('2026-11-10T11:30:00.000Z done\n');
  });

  it('indents further lines (a stack) under the first one', () => {
    expect(formatLogLine('Error: boom\n    at a (x.js:1)\r\n    at b (y.js:2)', at)).toBe('2026-11-10T11:30:00.000Z Error: boom\n        at a (x.js:1)\n        at b (y.js:2)\n');
  });

  it('describes errors with their stack and anything else as text', () => {
    const error = new Error('boom');
    expect(describeError(error)).toBe(error.stack);
    expect(describeError('plain reason')).toBe('plain reason');
    expect(describeError(undefined)).toBe('undefined');
  });
});

describe('unclean ends of a previous Core', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerry-heartbeat-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const heartbeat = { pid: 4242, version: '0.1.0', startedAt: '2026-11-10T08:00:00.000Z', aliveAt: '2026-11-10T09:58:00.000Z' };

  it('reads a heartbeat, and nothing from a missing or corrupt file', () => {
    const file = path.join(dir, 'core-alive.json');
    expect(readCoreHeartbeat(file)).toBeNull();
    fs.writeFileSync(file, '{ not json');
    expect(readCoreHeartbeat(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ pid: 'x', startedAt: 1 }));
    expect(readCoreHeartbeat(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify(heartbeat));
    expect(readCoreHeartbeat(file)).toEqual(heartbeat);
  });

  it('reports a heartbeat of a dead pid with when it was last seen, never our own or a live one', () => {
    const dead = () => false;
    expect(describeUncleanEnd(heartbeat, 1, dead)).toContain('the previous JERRY Core (pid 4242, 0.1.0, started 2026-11-10T08:00:00.000Z, last seen alive 2026-11-10T09:58:00.000Z) ended without a clean stop');
    expect(describeUncleanEnd(heartbeat, 1, dead)).toContain('Windows Event Viewer');
    expect(describeUncleanEnd(heartbeat, 4242, dead)).toBeNull();
    expect(describeUncleanEnd(heartbeat, 1, () => true)).toBeNull();
    expect(describeUncleanEnd(null, 1, dead)).toBeNull();
  });
});
