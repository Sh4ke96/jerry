import { describe, expect, it } from 'vitest';
import { reviewersFor } from '../src/reviewers.js';

const ALL = ['jerry-correctness-reviewer', 'jerry-security-reviewer', 'jerry-design-reviewer'];
const review = (classification: Parameters<typeof reviewersFor>[0]['classification'], changedFiles = 3, repositories = 1) => reviewersFor({ classification, changedFiles, repositories });

describe('reviewers sized to the change', () => {
  it('a small tests, docs or tooling change gets the correctness reviewer only', () => {
    expect(review(['tests'])).toEqual(['jerry-correctness-reviewer']);
    expect(review(['docs', 'tooling'])).toEqual(['jerry-correctness-reviewer']);
  });

  it('security for sensitive and API work, design for UI and refactoring', () => {
    for (const kind of ['security', 'database', 'infrastructure', 'api-backend'] as const) expect(review([kind])).toEqual(['jerry-correctness-reviewer', 'jerry-security-reviewer']);
    for (const kind of ['ui-ux', 'frontend', 'refactoring'] as const) expect(review([kind])).toEqual(['jerry-correctness-reviewer', 'jerry-design-reviewer']);
    expect(review(['api-backend', 'frontend'])).toEqual(ALL);
  });

  it('a large or multi-repository change, or one without a classification, gets all three', () => {
    expect(review(['tests'], 11)).toEqual(ALL);
    expect(review(['tests'], 10)).toEqual(['jerry-correctness-reviewer']);
    expect(review(['tests'], 2, 2)).toEqual(ALL);
    expect(review(undefined)).toEqual(ALL);
    expect(review([])).toEqual(ALL);
  });
});
