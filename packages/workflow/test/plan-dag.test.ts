import { describe, expect, it } from 'vitest';
import { globsOverlap, planLayers } from '../src/index.js';

const step = (dependsOn: number[] = []) => ({ step: 's', files: [], dependsOn });

describe('implementation task DAG (ADR 0031)', () => {
  it('orders steps into layers that may run in parallel', () => {
    expect(planLayers([step(), step(), step([1]), step([1, 2]), step([4])])).toEqual({ layers: [[1, 2], [3, 4], [5]], blocked: [] });
  });

  it('reports cycles and missing dependencies as blocked', () => {
    expect(planLayers([step(), step([3]), step([2]), step([9]), step([5])])).toEqual({ layers: [[1]], blocked: [2, 3, 4, 5] });
  });

  it('tells overlapping file globs apart conservatively', () => {
    expect(globsOverlap('src/auth/**', 'src/auth/login.ts', false)).toBe(true);
    expect(globsOverlap('src/auth/**', 'src/**', false)).toBe(true);
    expect(globsOverlap('src/auth/**', 'src/billing/**', false)).toBe(false);
    expect(globsOverlap('src/a.ts', 'src/b.ts', false)).toBe(false);
    expect(globsOverlap('src/A.ts', 'src/a.ts', true)).toBe(true);
    expect(globsOverlap('src/A.ts', 'src/a.ts', false)).toBe(false);
    expect(globsOverlap('tests/**', 'src/**', false)).toBe(false);
    expect(globsOverlap('**/*.ts', 'src/a.ts', false)).toBe(true);
  });
});
