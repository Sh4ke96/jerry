import type { PlanDocument } from '@jerry/contracts';
import { describe, expect, it } from 'vitest';
import { diffPlans, isEmptyDiff } from '../src/index.js';

const doc = (overrides: Partial<PlanDocument> = {}): PlanDocument => ({
  goal: 'Add a greeting helper.',
  classification: ['api-backend'],
  repositories: ['/repo'],
  currentState: 'No greeting module.',
  changes: [{ kind: 'add', target: 'src/greet.ts', description: 'greet(name)' }],
  architectureImpact: 'Leaf module.',
  crossRepoDependencies: '',
  risks: [{ risk: 'Blank names', severity: 'low', mitigation: 'Fallback' }],
  rollback: 'Delete it.',
  scope: { include: ['src/**'], exclude: [] },
  steps: [{ step: 'Write greet', files: ['src/greet.ts'], dependsOn: [] }],
  tests: [{ kind: 'unit', description: 'greet' }],
  regression: '',
  commitSubjects: ['feat: greet'],
  qaScenarios: [],
  artifact: '',
  definitionOfDone: ['tests pass'],
  openQuestions: ['Localise?'],
  ...overrides,
});

const version = (number: number, scope: string[], document?: PlanDocument) => ({ version: number, scope, ...(document === undefined ? {} : { document }) });

describe('plan version diff', () => {
  it('finds no difference between identical versions', () => {
    const diff = diffPlans(version(1, ['src/**'], doc()), version(2, ['src/**'], doc()));
    expect(diff).toMatchObject({ from: 1, to: 2, document: 'unchanged', sections: [], scope: { added: [], removed: [] } });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it('lists scope, text and list changes section by section', () => {
    const newer = doc({
      goal: 'Add a greeting helper with localisation.',
      risks: [
        { risk: 'Blank names', severity: 'medium', mitigation: 'Fallback' },
        { risk: 'Missing locale', severity: 'low', mitigation: 'Default to English' },
      ],
      steps: [
        { step: 'Write greet', files: ['src/greet.ts'], dependsOn: [] },
        { step: 'Add locales', files: ['src/locales.ts'], dependsOn: [1] },
      ],
      openQuestions: [],
    });
    const diff = diffPlans(version(1, ['src/**'], doc()), version(2, ['src/**', 'locales/**'], newer));
    expect(diff.scope).toEqual({ added: ['locales/**'], removed: [] });
    expect(diff.sections).toEqual([
      { section: 'Goal', before: 'Add a greeting helper.', after: 'Add a greeting helper with localisation.', added: [], removed: [] },
      { section: 'Risks', added: ['[medium] Blank names → Fallback', '[low] Missing locale → Default to English'], removed: ['[low] Blank names → Fallback'] },
      { section: 'Steps', added: ['Add locales (files: src/locales.ts; after step 1)'], removed: [] },
      { section: 'Open questions', added: [], removed: ['Localise?'] },
    ]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it('shows an intake turning into a full plan, and the analysis it cites', () => {
    const diff = diffPlans(version(1, ['src/**']), version(2, ['src/greet/**'], doc({ analysis: { reports: [3, 4], gaps: ['no quality report'] } })));
    expect(diff.document).toBe('added');
    expect(diff.scope).toEqual({ added: ['src/greet/**'], removed: ['src/**'] });
    expect(diff.sections.find((section) => section.section === 'Analysis reports')).toEqual({ section: 'Analysis reports', added: ['#3', '#4'], removed: [] });
    expect(diff.sections.find((section) => section.section === 'Goal')).toMatchObject({ before: '', after: 'Add a greeting helper.' });
  });

  it('counts duplicates and compares scope-only versions', () => {
    const diff = diffPlans(version(1, ['src/**']), version(2, ['src/**', 'src/**']));
    expect(diff).toMatchObject({ document: 'none', scope: { added: ['src/**'], removed: [] }, sections: [] });
  });
});
