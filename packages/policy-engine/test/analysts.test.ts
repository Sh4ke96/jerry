import { describe, expect, it } from 'vitest';
import { analystsFor } from '../src/analysts.js';

const ALL = ['jerry-architecture-analyst', 'jerry-risk-analyst', 'jerry-quality-analyst'];
const roles = (input: Partial<Parameters<typeof analystsFor>[0]>) => analystsFor({ focus: ['src/**'], caseInsensitive: false, ...input }).roles;

describe('analysts sized to the change', () => {
  it('needs none for a docs-only change and says to plan directly', () => {
    const suggestion = analystsFor({ classification: ['docs'], focus: ['docs/**'], caseInsensitive: false });
    expect(suggestion.roles).toEqual([]);
    expect(suggestion.reasons[0]).toContain('plan directly');
  });

  it('runs only the perspectives a small change touches', () => {
    expect(roles({ classification: ['tests'] })).toEqual(['jerry-quality-analyst']);
    expect(roles({ classification: ['tooling'] })).toEqual(['jerry-quality-analyst']);
    expect(roles({ classification: ['frontend', 'ui-ux'] })).toEqual(['jerry-quality-analyst']);
    expect(roles({ classification: ['api-backend'] })).toEqual(['jerry-architecture-analyst', 'jerry-quality-analyst']);
    expect(roles({ classification: ['docs', 'refactoring'] })).toEqual(['jerry-architecture-analyst', 'jerry-quality-analyst']);
  });

  it('runs all three for security, database and infrastructure changes', () => {
    for (const kind of ['security', 'database', 'infrastructure'] as const) expect(roles({ classification: ['tests', kind] })).toEqual(ALL);
  });

  it('runs all three across repositories, and when the focus covers API schemas or migrations', () => {
    expect(roles({ classification: ['tests'], repositoryCount: 2 })).toEqual(ALL);
    const touching = analystsFor({ classification: ['api-backend'], focus: ['db/**'], sensitivePaths: ['db\\migrations\\001.sql', 'openapi.yaml'], caseInsensitive: true });
    expect(touching.roles).toEqual(ALL);
    expect(touching.reasons[0]).toContain('db/migrations/001.sql');
    expect(roles({ classification: ['api-backend'], focus: ['src/**'], sensitivePaths: ['openapi.yaml'] })).toEqual(['jerry-architecture-analyst', 'jerry-quality-analyst']);
  });

  it('runs all three when the user asks, or when the kind of change is not given', () => {
    expect(roles({ classification: ['docs'], depth: 'full' })).toEqual(ALL);
    expect(roles({})).toEqual(ALL);
  });
});
