import { describe, expect, it } from 'vitest';
import { reportedPathPatterns } from '../src/state-store.js';

describe('paths named in a report', () => {
  it('keeps a plain path', () => {
    expect(reportedPathPatterns('apps/core/src/app.ts')).toEqual(['apps/core/src/app.ts']);
  });

  it('expands braces, also several groups', () => {
    expect(reportedPathPatterns('apps/dashboard/src/components/{Review,FinalReport}.tsx')).toEqual([
      'apps/dashboard/src/components/Review.tsx',
      'apps/dashboard/src/components/FinalReport.tsx',
    ]);
    expect(reportedPathPatterns('packages/{a,b}/src/{x,y}.ts')).toEqual(['packages/a/src/x.ts', 'packages/a/src/y.ts', 'packages/b/src/x.ts', 'packages/b/src/y.ts']);
  });

  it('splits comma-separated entries outside braces and drops a trailing note', () => {
    expect(reportedPathPatterns('scripts/{build,e2e-live}.mjs, README.md')).toEqual(['scripts/build.mjs', 'scripts/e2e-live.mjs', 'README.md']);
    expect(reportedPathPatterns('apps/dashboard/src/components/ui/** (alert-dialog, collapsible)')).toEqual(['apps/dashboard/src/components/ui/**']);
  });

  it('keeps globs for matching', () => {
    expect(reportedPathPatterns('apps/cli/src/*.ts')).toEqual(['apps/cli/src/*.ts']);
  });
});
