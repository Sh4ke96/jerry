import type { CoreUserInfo } from '@jerry/contracts';
import { CORE_TOKEN_PATTERN } from '@jerry/contracts/constants';

/**
 * Dependency-free check of run/core-user.json; accepts exactly what coreUserInfoSchema accepts
 * (a positive integer pid and a 64-character lowercase hex token, nothing else required). No Zod, so
 * the clients that read it start fast.
 */
export function isCoreUserInfo(value: unknown): value is CoreUserInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const pid = record['pid'];
  const token = record['token'];
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid >= 1 && typeof token === 'string' && CORE_TOKEN_PATTERN.test(token);
}
