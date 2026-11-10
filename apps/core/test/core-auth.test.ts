import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accessDeniedMessage, ACCESS_CLASSES, allowsClient, bearerClientKind, isAccessClass, ROUTE_ACCESS } from '../src/auth.js';

describe('route access classes', () => {
  const user = randomBytes(32).toString('hex');
  const agent = randomBytes(32).toString('hex');

  it('tells the user token from the agent token, and neither from anything else', () => {
    expect(bearerClientKind(user, { user, agent })).toBe('user');
    expect(bearerClientKind(agent, { user, agent })).toBe('agent');
    expect(bearerClientKind(randomBytes(32).toString('hex'), { user, agent })).toBeNull();
    expect(bearerClientKind('', { user, agent })).toBeNull();
    // Without an agent token nothing is an agent.
    expect(bearerClientKind(agent, { user, agent: undefined })).toBeNull();
  });

  it('keeps the agent away from every user decision, login code and shutdown', () => {
    expect(allowsClient('AGENT', 'agent')).toBe(true);
    expect(allowsClient('READ', 'agent')).toBe(true);
    expect(allowsClient('USER_DECISION', 'agent')).toBe(false);
    expect(allowsClient('USER_ONLY', 'agent')).toBe(false);
    expect(allowsClient('SESSION_ONLY', 'agent')).toBe(false);
    expect(allowsClient('USER_DECISION', 'user')).toBe(true);
    expect(allowsClient('USER_DECISION', 'session')).toBe(true);
    expect(allowsClient('USER_ONLY', 'user')).toBe(true);
    expect(allowsClient('USER_ONLY', 'session')).toBe(false);
    expect(allowsClient('AGENT', 'session')).toBe(false);
    // The user's token reaches every bearer route.
    for (const access of ACCESS_CLASSES) if (access !== 'PUBLIC' && access !== 'SESSION_ONLY') expect(allowsClient(access, 'user'), access).toBe(true);
    expect(ROUTE_ACCESS.PUBLIC).toEqual([]);
  });

  it('names the way forward when the agent token is refused', () => {
    for (const access of ['USER_DECISION', 'USER_ONLY', 'SESSION_ONLY'] as const) {
      expect(accessDeniedMessage(access, 'agent')).toContain('run/core-user.json');
      expect(accessDeniedMessage(access, 'agent')).toContain('cannot make user decisions');
    }
    expect(accessDeniedMessage('SESSION_ONLY', 'user')).toBe('This endpoint is for the dashboard only');
    expect(accessDeniedMessage('AGENT', 'session')).toBe('This endpoint is for the JERRY CLI and hooks only');
  });

  it('knows only its own classes', () => {
    expect(isAccessClass('USER_DECISION')).toBe(true);
    expect(isAccessClass('toString')).toBe(false);
    expect(isAccessClass(undefined)).toBe(false);
  });
});
