// @vitest-environment happy-dom
import type { AddedSkill, AgentModelEntry, AgentModelsResponse, SkillChangeResult, SkillDetail, SkillPreview, SkillsList } from '@jerry/contracts';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { parseRoute, route } from '../src/router';
import type { WorkflowSettings } from '../src/settings';
import { startDashboard, state } from '../src/state';

const CSRF = 'c'.repeat(64);
const NOW = new Date().toISOString();
const SKILLS_DIR = 'C:\\Users\\u\\.claude\\skills';

const pdf: AddedSkill = {
  kind: 'added',
  name: 'pdf',
  description: 'Turns PDFs into text.',
  dir: `${SKILLS_DIR}\\pdf`,
  source: { kind: 'github', source: 'https://github.com/acme/skills/tree/main/pdf', ref: 'main', commit: 'a'.repeat(40), path: 'pdf' },
  contentHash: 'sha256:1',
  fileCount: 2,
  totalBytes: 2048,
  enabled: true,
  states: [],
  jerryTriggered: true,
  present: true,
  modified: false,
  scan: { warnings: 1, dangers: 0 },
  installedAt: NOW,
  updatedAt: NOW,
};
const preview: SkillPreview = {
  previewId: 'skp_1',
  purpose: 'install',
  name: 'notes',
  description: 'Keeps notes.',
  source: { kind: 'github', source: 'https://github.com/acme/skills/tree/main/notes', ref: 'main', commit: 'b'.repeat(40), path: 'notes' },
  skillMd: '---\nname: notes\ndescription: Keeps notes.\n---\n# Notes',
  files: [{ path: 'SKILL.md', size: 60, sha256: 'x' }],
  totalBytes: 60,
  contentHash: 'sha256:2',
  scan: [
    { level: 'danger', rule: 'injection:override-instructions', file: 'SKILL.md', line: 5, message: 'Text that tries to steer the agent', excerpt: 'Ignore all previous instructions' },
    { level: 'warning', rule: 'network', file: 'run.sh', line: 1, message: 'Reaches the network', excerpt: 'curl …' },
  ],
  targetDir: `${SKILLS_DIR}\\notes`,
  blocked: null,
  diff: null,
  upToDate: false,
  expiresAt: NOW,
};

type Call = { url: string; method: string; body: Record<string, unknown> | null; csrf: string | undefined };

describe('Skills in the dashboard', () => {
  let calls: Call[];
  let list: SkillsList;
  let agentModels: AgentModelEntry[];
  let agentProblems: string[];

  beforeEach(() => {
    calls = [];
    agentProblems = [];
    agentModels = [
      { role: 'jerry-architecture-analyst', phase: 'analysis', model: 'claude-opus-5-5', effort: 'high', defaults: { model: 'claude-opus-5-5', effort: 'high' } },
      { role: 'jerry-risk-analyst', phase: 'analysis', model: 'claude-opus-5-5', effort: 'high', defaults: { model: 'claude-opus-5-5', effort: 'high' } },
      { role: 'jerry-quality-analyst', phase: 'analysis', model: 'claude-sonnet-5-5', effort: 'medium', defaults: { model: 'claude-sonnet-5-5', effort: 'medium' } },
      { role: 'jerry-correctness-reviewer', phase: 'review', model: 'claude-opus-5-5', effort: 'high', defaults: { model: 'claude-opus-5-5', effort: 'high' } },
      { role: 'jerry:commit-message', phase: 'skill', model: 'claude-sonnet-5-5', effort: 'low', defaults: { model: 'claude-sonnet-5-5', effort: 'low' } },
    ];
    list = {
      skillsDir: SKILLS_DIR,
      own: [{ kind: 'jerry', name: 'jerry:plan', description: 'Plan a task.', dir: 'C:\\J\\plugin\\skills\\plan' }],
      added: [pdf],
      personal: [{ kind: 'personal', name: 'mine', description: 'My own.', dir: `${SKILLS_DIR}\\mine` }],
      note: 'Applies to new Claude Code sessions.',
    };
    const settings: WorkflowSettings = { reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: false, decisionConfirmation: 'click' };
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], projects: [], repositories: [], graph: { nodes: [], edges: [] }, settings: null, refreshedAt: null });
    window.location.hash = '';
    route.value = { section: 'overview' };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
      calls.push({ url, method, body, csrf: (init?.headers as Record<string, string> | undefined)?.['x-jerry-csrf'] });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
      const change = (name: string, action: SkillChangeResult['action'], skill: AddedSkill | null): Response => json({ name, action, skill, backupDir: action === 'removed' ? 'C:\\J\\backups\\skills-pdf-1' : null, settingsBackup: null, note: list.note } satisfies SkillChangeResult);
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.1.0', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 0, sessionCount: 0, database: { file: 'db', migration: '0022' } });
      if (url === '/api/v1/tasks' || url.startsWith('/api/v1/events') || url === '/api/v1/repositories' || url === '/api/v1/projects') return json([]);
      if (url === '/api/v1/workspace/graph') return json({ nodes: [], edges: [] });
      if (url === '/api/v1/settings') return json(settings);
      if (url === '/api/v1/usage') return json({ error: 'no usage' }, 404);
      if (url === '/api/v1/skills') return json(list);
      if (url === '/api/v1/skills/pdf') {
        const current = list.added.find((skill) => skill.name === 'pdf') ?? pdf;
        return json({
          skill: current,
          skillMd: '# PDF',
          files: [{ path: 'SKILL.md', size: 10, sha256: 'x' }],
          scan: [{ level: 'warning', rule: 'script', file: 'run.sh', line: null, message: 'A script', excerpt: null }],
          history: [{ action: 'installed', channel: 'cli', at: NOW, details: {} }],
          uses: [
            { at: NOW, sessionId: 's1', taskId: 'JRY-0007', repoRoot: 'D:\\Work\\shop', verdict: 'PASS', ruleId: 'monitor.skill-in-state' },
            { at: NOW, sessionId: 's1', taskId: 'JRY-0007', repoRoot: 'D:\\Work\\shop', verdict: 'WARN', ruleId: 'monitor.skill-out-of-state' },
          ],
        } satisfies SkillDetail);
      }
      if (url === '/api/v1/skills/preview' && body?.['source'] === 'https://github.com/acme/nope') return json({ error: 'GitHub has no such repository, branch, tag or commit (private repositories are not supported).' }, 404);
      if (url === '/api/v1/skills/preview' && body?.['source'] === 'https://github.com/acme/many') {
        return json(
          {
            error: 'There is no SKILL.md in the root of the repository. It holds skills in: …',
            details: { candidates: [{ folder: 'skills/notes', url: 'https://github.com/acme/many/tree/main/skills/notes' }, { folder: 'skills/evil', url: 'javascript:alert(1)' }] },
          },
          400,
        );
      }
      if (url === '/api/v1/skills/preview') return json(preview);
      if (url === '/api/v1/skills/install') {
        const added: AddedSkill = { ...pdf, name: 'notes', description: 'Keeps notes.', scan: { warnings: 1, dangers: 1 } };
        list = { ...list, added: [...list.added, added] };
        return json({ name: 'notes', action: 'installed', skill: added, backupDir: null, settingsBackup: null, note: list.note } satisfies SkillChangeResult, 201);
      }
      if (url === '/api/v1/skills/pdf/disable') {
        list = { ...list, added: [{ ...pdf, enabled: false }] };
        return change('pdf', 'disabled', { ...pdf, enabled: false });
      }
      if (url === '/api/v1/skills/pdf/states') {
        const updated: AddedSkill = { ...pdf, states: (body?.['states'] ?? []) as AddedSkill['states'] };
        list = { ...list, added: [updated] };
        return change('pdf', 'states-set', updated);
      }
      if (url === '/api/v1/skills/jerry%3Aanalyze' || url === '/api/v1/skills/jerry%3Aplan' || url === '/api/v1/skills/jerry%3Acommit-message') {
        const name = decodeURIComponent(url.slice('/api/v1/skills/'.length));
        return json({ skill: { kind: 'jerry', name, description: 'A JERRY skill.', dir: 'C:\\J\\plugin\\skills\\x' }, skillMd: '# x', files: [], scan: [], history: [], uses: [] } satisfies SkillDetail);
      }
      if (url === '/api/v1/agents/models') {
        if (method === 'POST') {
          const change = (body?.['agents'] as AgentModelEntry[])[0]!;
          agentModels = agentModels.map((agent) => (agent.role === change.role ? { ...agent, model: change.model, effort: change.effort } : agent));
          return json({ agents: agentModels, problems: agentProblems } satisfies AgentModelsResponse);
        }
        return json({ agents: agentModels, problems: [] } satisfies AgentModelsResponse);
      }
      if (url === '/api/v1/skills/pdf/update/preview') return json({ ...preview, purpose: 'update', name: 'pdf', upToDate: true, diff: { added: [], removed: [], changed: [] } });
      if (url === '/api/v1/skills/pdf/remove') {
        list = { ...list, added: [] };
        return change('pdf', 'removed', null);
      }
      return json({ error: `unexpected ${method} ${url}` }, 404);
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function mountApp() {
    const wrapper = mount(App, { attachTo: document.body });
    await startDashboard();
    await flushPromises();
    await wrapper.findAll('[data-slot="sidebar-content"] [data-sidebar="menu-button"]').find((item) => item.text() === 'Skills')!.trigger('click');
    await flushPromises();
    return wrapper;
  }
  const body = () => new DOMWrapper(document.body);
  const posts = (url: string) => calls.filter((call) => call.url === url && call.method === 'POST');

  it('has a Skills route and a sidebar item; shows added skills as tiles and the others read-only', async () => {
    expect(parseRoute('#/skills')).toEqual({ section: 'skills' });
    expect(parseRoute('#/skills/pdf')).toEqual({ section: 'skills', name: 'pdf' });
    expect(parseRoute('#/skills/jerry%3Aplan')).toEqual({ section: 'skills', name: 'jerry:plan' });
    expect(parseRoute('#/skills/..%2Fx')).toBeNull();
    const wrapper = await mountApp();
    expect(window.location.hash).toBe('#/skills');
    const tile = wrapper.get('.added-skills [data-skill="pdf"]');
    expect(tile.text()).toContain('Turns PDFs into text.');
    // The scan is on the skill's page, not on its row; every list is one full-width column.
    expect(tile.text()).not.toMatch(/amber|red/);
    for (const listClass of ['.added-skills', '.own-skills', '.personal-skills']) expect(wrapper.get(listClass).classes()).toContain('grid-cols-1');
    expect(wrapper.get('.added-skills').classes().some((name) => name.startsWith('md:grid-cols'))).toBe(false);
    expect(tile.get('a').attributes('href')).toBe('#/skills/pdf');
    expect(tile.get('[data-slot="switch"]').attributes('data-state')).toBe('checked');
    const own = wrapper.get('.own-skills [data-skill="jerry:plan"]');
    expect(own.text()).toContain('read-only');
    expect(own.find('[data-slot="switch"]').exists()).toBe(false);
    expect(own.find('[data-skill-remove]').exists()).toBe(false);
    expect(wrapper.get('.personal-skills').text()).toContain('mine');
    expect(wrapper.text()).toContain('Applies to new Claude Code sessions.');
    wrapper.unmount();
  });

  it('adds a skill from a GitHub URL: preview with the scan, then install only with the typed name when typed confirmations are on', async () => {
    const wrapper = await mountApp();
    state.settings = { ...state.settings!, decisionConfirmation: 'typed' };
    await wrapper.get('[data-add-skill]').trigger('click');
    await flushPromises();
    await body().get('#skill-source').setValue('https://github.com/acme/skills/tree/main/notes');
    await body().get('form.add-skill').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/skills/preview').map((call) => [call.body, call.csrf])).toEqual([[{ source: 'https://github.com/acme/skills/tree/main/notes' }, CSRF]]);

    const shown = body().get('[data-skill-preview="notes"]');
    expect(shown.text()).toContain('Keeps notes.');
    expect(shown.get('.skill-md').text()).toContain('# Notes');
    const findings = shown.findAll('.skill-scan li');
    expect(findings.map((item) => item.attributes('data-level'))).toEqual(['danger', 'warning']);
    expect(findings[0]!.classes()).toContain('text-destructive');
    expect(findings[1]!.classes()).toContain('text-amber-700');
    expect(posts('/api/v1/skills/install')).toEqual([]);

    await body().get('[data-skill-confirm]').trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.attributes('data-confirm-mode')).toBe('typed');
    await dialog.get('#confirm-typed').setValue('note');
    expect(dialog.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await dialog.get('#confirm-typed').setValue('notes');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/skills/install').map((call) => call.body)).toEqual([{ previewId: 'skp_1', confirmation: 'notes' }]);
    expect(state.notice).toBe('notes installed. Applies to new Claude Code sessions.');
    expect(wrapper.find('.added-skills [data-skill="notes"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows a failed preview inside the Add-skill dialog, and offers the skills of a repository that holds several', async () => {
    const wrapper = await mountApp();
    await wrapper.get('[data-add-skill]').trigger('click');
    await flushPromises();
    await body().get('#skill-source').setValue('https://github.com/acme/nope');
    await body().get('form.add-skill').trigger('submit');
    await flushPromises();
    // In the dialog, not behind it.
    expect(body().get('form.add-skill [role="alert"]').text()).toContain('GitHub has no such repository');
    expect(state.notice).toBeNull();

    await body().get('#skill-source').setValue('https://github.com/acme/many');
    await body().get('form.add-skill').trigger('submit');
    await flushPromises();
    const alert = body().get('form.add-skill [role="alert"]');
    expect(alert.text()).toContain('This repository holds several skills. Pick one:');
    // Only GitHub folder links are offered.
    expect(alert.findAll('[data-skill-candidate]').map((button) => button.attributes('data-skill-candidate'))).toEqual(['skills/notes']);
    await alert.get('[data-skill-candidate="skills/notes"]').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/skills/preview').map((call) => call.body)).toEqual([{ source: 'https://github.com/acme/nope' }, { source: 'https://github.com/acme/many' }, { source: 'https://github.com/acme/many/tree/main/skills/notes' }]);
    expect(body().find('[data-skill-preview="notes"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('switches with one click, says when an update is not needed, and removes in one click (one-click decisions)', async () => {
    const wrapper = await mountApp();
    await wrapper.get('.added-skills [data-skill="pdf"] [data-slot="switch"]').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/skills/pdf/disable').map((call) => call.csrf)).toEqual([CSRF]);
    expect(state.notice).toBe('pdf switched off. Applies to new Claude Code sessions.');
    expect(wrapper.get('.added-skills [data-skill="pdf"] [data-slot="switch"]').attributes('data-state')).toBe('unchecked');

    await wrapper.get('.added-skills [data-skill="pdf"] [data-skill-update]').trigger('click');
    await flushPromises();
    expect(state.notice).toBe('pdf is up to date.');

    await wrapper.get('.added-skills [data-skill="pdf"] [data-skill-remove]').trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.get('h2').text()).toBe('Remove pdf?');
    expect(dialog.attributes('data-confirm-mode')).toBe('click');
    expect(dialog.find('#confirm-typed').exists()).toBe(false);
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/skills/pdf/remove').map((call) => call.body)).toEqual([{ confirmation: 'pdf' }]);
    expect(state.notice).toContain('pdf removed (kept in C:\\J\\backups\\skills-pdf-1)');
    expect(wrapper.find('.added-skills').exists()).toBe(false);
    wrapper.unmount();
  });

  it('opens a skill page from a click on its row: scan summary, when JERRY starts it and its recent uses', async () => {
    const wrapper = await mountApp();
    // A click anywhere on the row (not on its controls) opens the page.
    await wrapper.get('.added-skills [data-skill="pdf"] .skill-trigger').trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/skills/pdf');
    const page = wrapper.get('[data-skill-page="pdf"]');
    expect(page.get('.skill-scan-summary').text()).toContain('1 amber');
    const uses = page.findAll('.skill-uses [data-skill-use]');
    expect(uses.map((use) => use.attributes('data-skill-use'))).toEqual(['PASS', 'WARN']);
    expect(uses[0]!.text()).toContain('started by JERRY');
    expect(uses[0]!.get('a').attributes('href')).toBe('#/tasks/JRY-0007');
    expect(uses[1]!.text()).toContain('outside its states (deviation)');
    expect(page.text()).toContain("JERRY's next step for Claude names the skill");
    wrapper.unmount();
  });

  it('shows a skill page with SKILL.md, files and history', async () => {
    const wrapper = await mountApp();
    await wrapper.get('.added-skills [data-skill="pdf"] a').trigger('click');
    await flushPromises();
    expect(window.location.hash).toBe('#/skills/pdf');
    const page = wrapper.get('[data-skill-page="pdf"]');
    expect(page.get('.skill-md').text()).toBe('# PDF');
    expect(page.get('.skill-files').text()).toContain('SKILL.md');
    expect(page.get('.skill-history').text()).toContain('Installed (in a terminal)');
    wrapper.unmount();
  });

  it('says when JERRY starts an added skill, and saves the task states chosen on its page', async () => {
    const wrapper = await mountApp();
    const tile = wrapper.get('.added-skills [data-skill="pdf"] .skill-trigger');
    expect(tile.attributes('data-trigger')).toBe('none');
    expect(tile.text()).toContain('Claude does not use it');

    await wrapper.get('.added-skills [data-skill="pdf"] a').trigger('click');
    await flushPromises();
    const picker = wrapper.get('[data-skill-states="pdf"]');
    const boxes = picker.findAll('input[type="checkbox"]');
    // Only open states in which Claude works; each checkbox has a label.
    expect(boxes.map((box) => box.attributes('data-skill-state'))).not.toContain('DONE');
    expect(boxes.map((box) => box.attributes('data-skill-state'))).not.toContain('PAUSED');
    for (const box of boxes) expect(picker.find(`label[for="${box.attributes('id')}"]`).exists()).toBe(true);
    expect(picker.get('[data-skill-states-save]').attributes('disabled')).toBeDefined();

    // Ticked out of order, saved in workflow order.
    await picker.get('[data-skill-state="REVERIFICATION"]').setValue(true);
    await picker.get('[data-skill-state="CODE_REVIEW"]').setValue(true);
    await picker.get('[data-skill-states-save]').trigger('click');
    await flushPromises();
    const dialog = body().get('[role="alertdialog"]');
    // One-click decisions: no typing.
    expect(dialog.attributes('data-confirm-mode')).toBe('click');
    await dialog.get('form').trigger('submit');
    await flushPromises();
    expect(posts('/api/v1/skills/pdf/states').map((call) => [call.body, call.csrf])).toEqual([[{ states: ['CODE_REVIEW', 'REVERIFICATION'], confirmation: 'pdf' }, CSRF]]);
    expect(state.notice).toContain('Started by JERRY in:');
    wrapper.unmount();
  });

  it("picks the model and effort of the analysts on /jerry:analyze's page, saved at once", async () => {
    const wrapper = await mountApp();
    route.value = { section: 'skills', name: 'jerry:analyze' };
    await flushPromises();
    const card = wrapper.get('[data-skill-page="jerry:analyze"] .agent-models');
    // Only the analysts: the reviewers belong to /jerry:review.
    expect(card.findAll('[data-agent-model]').map((row) => row.attributes('data-agent-model'))).toEqual(['jerry-architecture-analyst', 'jerry-risk-analyst', 'jerry-quality-analyst']);
    const quality = card.get('[data-agent-model="jerry-quality-analyst"]');
    expect(quality.text()).toContain('default');
    expect((quality.get('[data-agent-field="model"]').element as HTMLSelectElement).value).toBe('claude-sonnet-5-5');
    // Every select has a label.
    for (const select of card.findAll('select')) expect(card.find(`label[for="${select.attributes('id')}"]`).exists()).toBe(true);

    await quality.get('[data-agent-field="model"]').setValue('claude-haiku-5-5');
    await flushPromises();
    expect(posts('/api/v1/agents/models').map((call) => [call.body, call.csrf])).toEqual([[{ agents: [{ role: 'jerry-quality-analyst', model: 'claude-haiku-5-5', effort: 'medium' }] }, CSRF]]);
    const saved = wrapper.get('[data-agent-model="jerry-quality-analyst"]');
    expect(saved.text()).toContain('your choice');
    expect(wrapper.get('[data-agent-models-message]').text()).toContain('/reload-plugins');

    // A problem writing the agent files is shown, not hidden.
    agentProblems = ['JERRY\'s plugin is not installed at C:\\J; run "jerry install".'];
    await wrapper.get('[data-agent-model="jerry-risk-analyst"] [data-agent-field="effort"]').setValue('low');
    await flushPromises();
    expect(wrapper.get('[data-agent-models-message]').text()).toContain('jerry install');
    wrapper.unmount();
  });

  it("picks the model of a routine skill on its own page, and says it lasts for the rest of the turn", async () => {
    const wrapper = await mountApp();
    route.value = { section: 'skills', name: 'jerry:commit-message' };
    await flushPromises();
    const card = wrapper.get('[data-skill-page="jerry:commit-message"] [data-model-card="jerry:commit-message"]');
    expect(card.text()).toContain('Model');
    expect(card.text()).toContain('until the end of that turn');
    expect(card.findAll('[data-agent-model]').map((row) => row.attributes('data-agent-model'))).toEqual(['jerry:commit-message']);
    await card.get('[data-agent-field="model"]').setValue('claude-haiku-5-5');
    await flushPromises();
    expect(posts('/api/v1/agents/models').map((call) => call.body)).toEqual([{ agents: [{ role: 'jerry:commit-message', model: 'claude-haiku-5-5', effort: 'low' }] }]);
    wrapper.unmount();
  });

  it('shows no model choice on other skill pages', async () => {
    const wrapper = await mountApp();
    route.value = { section: 'skills', name: 'jerry:plan' };
    await flushPromises();
    expect(wrapper.get('[data-skill-page="jerry:plan"]').find('.agent-models').exists()).toBe(false);
    route.value = { section: 'skills', name: 'pdf' };
    await flushPromises();
    expect(wrapper.get('[data-skill-page="pdf"]').find('.agent-models').exists()).toBe(false);
    wrapper.unmount();
  });

  it('warns about a skill installed before JERRY started skills', async () => {
    list = { ...list, added: [{ ...pdf, jerryTriggered: false }] };
    const wrapper = await mountApp();
    const line = wrapper.get('.added-skills [data-skill="pdf"] .skill-trigger');
    expect(line.attributes('data-trigger')).toBe('claude');
    expect(line.text()).toContain('Claude may still pick it on its own');
    wrapper.unmount();
  });
});
