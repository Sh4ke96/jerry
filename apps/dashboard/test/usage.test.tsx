// @vitest-environment happy-dom
import type { UsageSummary } from '@jerry/contracts';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { route } from '../src/router';
import type { WorkflowSettings } from '../src/settings';
import { loadUsage, startDashboard, state } from '../src/state';
import { clockTime, formatCost, formatTokens, limitStale, limitTone, readUsage, REFRESH_HINT, resetText, staleText } from '../src/usage';
import { emptyUsage, minutesFromNow, sampleUsage } from './usage-fixture';

const CSRF = 'c'.repeat(64);
const NOW = new Date().toISOString();

type Call = { url: string; method: string; body: unknown; csrf: string | null };

describe('Claude usage in the dashboard', () => {
  let calls: Call[];
  let settings: WorkflowSettings;
  /** What GET /api/v1/usage answers; null: the route does not exist (an older Core). */
  let usage: UsageSummary | null;

  beforeEach(() => {
    calls = [];
    settings = { reviewMode: 'optional', qaLanguage: 'pl', usageShowBar: true };
    usage = sampleUsage();
    Object.assign(state, { phase: 'loading', error: null, notice: null, status: null, tasks: [], events: [], projects: [], repositories: [], graph: { nodes: [], edges: [] }, settings: null, refreshedAt: null, usage: null, usageState: 'unknown', usageError: null, usageLoadedAt: 0 });
    window.location.hash = '';
    route.value = { section: 'overview' };
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), csrf: headers['x-jerry-csrf'] ?? null });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/v1/ui/session') return json({ csrfToken: CSRF, expiresAt: NOW });
      if (url === '/api/v1/status') return json({ status: 'ok', version: '0.0.1', pid: 1, startedAt: NOW, jerryHome: 'C:/J', taskCount: 0, sessionCount: 0, database: { file: 'db', migration: '0020' } });
      if (url === '/api/v1/tasks' || url.startsWith('/api/v1/events') || url === '/api/v1/projects' || url === '/api/v1/repositories') return json([]);
      if (url === '/api/v1/workspace/graph') return json({ nodes: [], edges: [] });
      if (url === '/api/v1/settings' && method === 'GET') return json(settings);
      if (url === '/api/v1/settings' && method === 'POST') {
        settings = { ...settings, ...(JSON.parse(String(init?.body)) as Partial<WorkflowSettings>) };
        return json(settings);
      }
      if (url === '/api/v1/usage') return usage === null ? json({ error: 'Not found' }, 404) : json(usage);
      if (url === '/api/v1/usage/collection' && method === 'POST') {
        const enabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
        const collection = { statusline: enabled ? 'on' : 'off', telemetry: enabled ? 'on' : 'off', showBar: settings.usageShowBar } as const;
        if (usage !== null) usage = { ...usage, collection };
        return json({ ...collection, problems: [] });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  async function mountApp(hash = '') {
    window.location.hash = hash;
    const wrapper = mount(App, { attachTo: document.body });
    await startDashboard();
    await flushPromises();
    return wrapper;
  }
  const body = () => new DOMWrapper(document.body);
  const posts = (url: string) => calls.filter((call) => call.url === url && call.method === 'POST');
  const meter = (wrapper: Awaited<ReturnType<typeof mountApp>>, name: string) => wrapper.get(`[data-usage-bar] [data-limit="${name}"]`);

  it('reads usage defensively: anything missing gets an empty default', () => {
    const partial = readUsage({ collection: { statusline: 'on' }, limits: { fiveHour: { pct: 130, readAt: NOW } }, daily: [{ date: '2026-11-07', tokens: 5 }, { tokens: 1 }] });
    expect(partial.collection).toEqual({ statusline: 'on', telemetry: 'off', showBar: true });
    expect(partial.limits).toEqual({ fiveHour: { pct: 100, resetsAt: null, readAt: NOW, entrypoint: null }, sevenDay: null });
    expect(partial.daily).toEqual([{ date: '2026-11-07', tokens: 5, costUsd: 0 }]);
    expect(partial.totals.last30d.tokens).toBe(0);
    expect(readUsage('nonsense').byModel).toEqual([]);
  });

  it('words limits, tokens and cost like Claude does', () => {
    expect([limitTone(79), limitTone(80), limitTone(94.9), limitTone(95), limitTone(100)]).toEqual(['normal', 'warn', 'warn', 'critical', 'critical']);
    const now = new Date();
    expect(resetText(new Date(now.getTime() + 134 * 60_000 - 20_000).toISOString(), now)).toBe('resets in 2 h 14 min');
    expect(resetText(new Date(now.getTime() + 5 * 60_000).toISOString(), now)).toBe('resets in 5 min');
    expect(resetText(new Date(now.getTime() + 3 * 24 * 3600_000).toISOString(), now)).toMatch(/^resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
    expect(resetText(new Date(now.getTime() - 60_000).toISOString(), now)).toMatch(/^reset at .*, after it was read$/);
    expect(resetText(null, now)).toBe('reset time unknown');
    expect([formatTokens(950), formatTokens(12_345), formatTokens(4_500_000), formatTokens(120_000_000)]).toEqual(['950', '12.3k', '4.5M', '120M']);
    expect([formatCost(0), formatCost(0.004), formatCost(1.5), formatCost(1234.4)]).toEqual(['$0', '<$0.01', '$1.50', '$1,234']);
  });

  it('shows the usage bar in the top bar of every view by default, with when and where the limits were read', async () => {
    const wrapper = await mountApp();
    expect(meter(wrapper, '5h').text()).toBe('23%5h session');
    expect(meter(wrapper, 'week').text()).toBe('41%Week session');
    // The percent left of the bar, the name under the bar.
    const [value, column] = meter(wrapper, '5h').element.children;
    expect(value!.matches('[data-limit-value]')).toBe(true);
    const below = [...column!.children];
    expect(below).toHaveLength(2);
    expect(below[0]!.matches('[role="progressbar"]') || below[0]!.querySelector('[role="progressbar"]') !== null).toBe(true);
    expect(below[1]!.matches('[data-limit-label]')).toBe(true);
    expect(meter(wrapper, '5h').attributes('data-tone')).toBe('normal');
    expect(meter(wrapper, '5h').find('[data-limit-stale]').exists()).toBe(false);
    expect(meter(wrapper, '5h').get('[role="progressbar"]').attributes('aria-valuenow')).toBe('23');
    expect(meter(wrapper, '5h').get('rect').attributes('width')).toBe('23');
    expect(wrapper.get('[data-usage-bar]').attributes('href')).toBe('#/overview');

    // Its tooltip says when the windows reset, when and where they were read, and why VS Code adds nothing.
    await wrapper.get('[data-usage-bar]').trigger('focus');
    await flushPromises();
    const tooltip = body().get('[data-usage-tooltip]').text();
    expect(tooltip).toContain('5-hour window: 23% used, resets in 2 h 14 min');
    expect(tooltip).toContain('Week: 41% used, resets ');
    expect(tooltip).toContain(`read ${clockTime(usage!.limits.fiveHour!.readAt)} from a terminal session`);
    expect(tooltip).toContain('Plan limits come from terminal sessions; the VS Code extension does not pass them.');
    // A fresh reading needs no refresh hint.
    expect(body().find('[data-usage-tooltip] [data-usage-refresh]').exists()).toBe(false);

    // Every view keeps it.
    for (const address of ['#/tasks', '#/projects', '#/settings']) {
      window.location.hash = address;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await flushPromises();
      expect(wrapper.find('[data-usage-bar]').exists(), address).toBe(true);
    }
    wrapper.unmount();
  });

  it('hides the usage bar when the user turned it off, and without usage on an older Core', async () => {
    settings = { ...settings, usageShowBar: false };
    const off = await mountApp();
    expect(off.find('[data-usage-bar]').exists()).toBe(false);
    off.unmount();

    settings = { ...settings, usageShowBar: true };
    usage = null;
    const older = await mountApp();
    expect(older.find('[data-usage-bar]').exists()).toBe(false);
    expect(older.get('.usage-card .usage-unavailable').text()).toContain('Usage is not available on this Core');
    older.unmount();
  });

  it("says 'no data' for a window without a reading, and turns amber from 80 % and red from 95 %", async () => {
    const base = sampleUsage();
    usage = { ...base, limits: { fiveHour: null, sevenDay: { ...base.limits.sevenDay!, pct: 85 } } };
    const wrapper = await mountApp();
    expect(meter(wrapper, '5h').text()).toBe('no data5h session');
    expect(meter(wrapper, '5h').attributes('data-tone')).toBe('none');
    expect(meter(wrapper, '5h').get('span').classes()).toContain('text-muted-foreground');
    expect(meter(wrapper, 'week').attributes('data-tone')).toBe('warn');
    expect(meter(wrapper, 'week').get('rect').classes()).toContain('fill-amber-500');
    expect(wrapper.get('[data-usage-limit="fiveHour"]').text()).toContain('no data');
    wrapper.unmount();

    usage = { ...base, limits: { fiveHour: { ...base.limits.fiveHour!, pct: 96 }, sevenDay: { ...base.limits.sevenDay!, pct: 79 } } };
    const critical = await mountApp();
    expect(meter(critical, '5h').attributes('data-tone')).toBe('critical');
    expect(meter(critical, '5h').get('rect').classes()).toContain('fill-destructive');
    expect(meter(critical, 'week').attributes('data-tone')).toBe('normal');
    expect(critical.get('[data-usage-limit="fiveHour"]').attributes('data-tone')).toBe('critical');
    critical.unmount();
  });

  it('mutes readings older than 30 minutes as stale and says how to refresh them', async () => {
    const base = sampleUsage();
    const readAt = minutesFromNow(-43);
    usage = { ...base, limits: { fiveHour: { ...base.limits.fiveHour!, readAt }, sevenDay: { ...base.limits.sevenDay!, readAt } } };
    const wrapper = await mountApp();
    const fiveHour = meter(wrapper, '5h');
    expect(fiveHour.attributes('data-tone')).toBe('stale');
    expect(fiveHour.get('[data-limit-label]').text()).toBe('5h session · stale · 43 min');
    expect(fiveHour.get('[data-limit-value]').classes()).toContain('text-muted-foreground');
    expect(fiveHour.get('rect').classes()).toContain('fill-muted-foreground/60');
    expect(meter(wrapper, 'week').get('[data-limit-label]').text()).toBe('Week session · stale · 43 min');
    expect(wrapper.get('[data-usage-bar]').attributes('aria-label')).toContain('(stale)');

    await wrapper.get('[data-usage-bar]').trigger('focus');
    await flushPromises();
    expect(body().get('[data-usage-tooltip] [data-usage-refresh]').text()).toBe(REFRESH_HINT);
    expect(REFRESH_HINT).toContain('claudeCode.useTerminal');

    const row = wrapper.get('.usage-card [data-usage-limit="fiveHour"]');
    expect(row.attributes('data-tone')).toBe('stale');
    expect(row.get('[data-limit-label]').text()).toBe('5h session · stale · 43 min');
    expect(row.get('[data-usage-refresh]').text()).toBe(REFRESH_HINT);
    expect(row.attributes('title')).toBe(REFRESH_HINT);
    wrapper.unmount();

    // 30 minutes is not stale yet; longer times read in hours and days.
    const limit = { pct: 10, resetsAt: null, readAt: minutesFromNow(-30), entrypoint: 'cli' };
    expect(limitStale(limit)).toBe(false);
    expect(limitStale({ ...limit, readAt: minutesFromNow(-31) })).toBe(true);
    expect(staleText({ ...limit, readAt: minutesFromNow(-125) })).toBe('stale · 2 h 5 min');
    expect(staleText({ ...limit, readAt: minutesFromNow(-3 * 24 * 60 - 5) })).toBe('stale · 3 d');
  });

  it('shows the Usage card on the Overview: limits with read-at and source, periods, the daily chart and the tables', async () => {
    const wrapper = await mountApp();
    const card = wrapper.get('.usage-card');
    const session = card.get('[data-usage-limit="fiveHour"]').text();
    expect(session).toContain('23%');
    expect(card.get('[data-usage-limit="fiveHour"] [data-limit-label]').text()).toBe('5h session');
    expect(session).toContain('Resets in 2 h 14 min');
    expect(session).toContain(`last known · read at ${clockTime(usage!.limits.fiveHour!.readAt)} from a terminal session`);
    expect(card.get('[data-usage-limit="sevenDay"]').text()).toContain('41%Week session');
    expect(card.find('[data-usage-refresh]').exists()).toBe(false);
    expect(card.text()).toContain('Per-model weekly limits: not available from Claude Code');

    // Today first; the tabs switch to 7 and 30 days. Cost is labelled as an estimate.
    expect(card.get('[data-usage-period="today"]').text()).toContain('Tokens120k');
    expect(card.get('[data-usage-period="today"]').text()).toContain('Cost$0.42estimate at list price');
    await card.get('[data-tab="usage-last30d"]').trigger('mousedown');
    await flushPromises();
    const month = wrapper.get('[data-usage-period="last30d"]').text();
    expect(month).toContain('Tokens9.8M');
    expect(month).toContain('Cache read7.8M');
    expect(month).toContain('Cost$31.25');

    // 30 days of bars, each with its own tooltip.
    const days = card.findAll('[data-usage-chart] [data-day]');
    expect(days).toHaveLength(30);
    expect(days[29]!.get('title').text()).toMatch(/^\d{4}-\d\d-\d\d: 300,000 tokens · \$2\.90 \(estimate\)$/);

    const rows = (id: string) => card.findAll(`[data-usage-table="${id}"] tbody tr`).map((row) => row.findAll('td').map((cell) => cell.text()));
    expect(rows('model')).toEqual([
      ['claude-opus-4-5', '7M', '$25.00'],
      ['claude-haiku-4-5', '2.8M', '$6.25'],
    ]);
    expect(rows('project')).toEqual([['shop', '9.8M', '$31.25']]);
    expect(rows('entrypoint')).toEqual([
      ['VS Code', '6M', '$20.00'],
      ['Terminal', '3.8M', '$11.25'],
    ]);
    expect(card.get('[data-usage-jerry]').text()).toContain("JERRY's share: ~12.3k tokens in 30 days (estimate)");
    wrapper.unmount();
  });

  it('explains the empty states: collection off, a telemetry clash and no data yet', async () => {
    usage = emptyUsage({ collection: { statusline: 'off', telemetry: 'off', showBar: true } });
    const off = await mountApp();
    expect(off.get('.usage-card .usage-off').text()).toContain('Usage collection is off');
    expect(off.get('.usage-card .usage-off').text()).toContain('jerry usage enable');
    expect(off.get('.usage-card .usage-off a').attributes('href')).toBe('#/settings');
    expect(off.find('.usage-card .usage-empty').exists()).toBe(false);
    off.unmount();

    usage = sampleUsage({ collection: { statusline: 'on', telemetry: 'clash', showBar: true } });
    const clash = await mountApp();
    expect(clash.get('.usage-card .usage-clash').text()).toContain('Your own OpenTelemetry settings are kept');
    clash.unmount();

    usage = emptyUsage();
    const empty = await mountApp();
    expect(empty.get('.usage-card .usage-empty').text()).toContain('Use Claude Code for a few minutes; tokens appear within ~1 minute, plan limits after a terminal session.');
    expect(empty.find('.usage-card [data-usage-chart]').exists()).toBe(false);
    expect(empty.get('[data-usage-bar]').text()).toBe('no data5h sessionno dataWeek session');
    empty.unmount();
  });

  it('turns collection off only after the confirmation, and shows each source with its last data', async () => {
    const wrapper = await mountApp('#/settings');
    const card = wrapper.get('.settings-usage');
    expect(card.get('[data-source="statusline"]').text()).toContain('On');
    expect(card.get('[data-source="statusline"]').text()).toContain(`Terminal ${clockTime(usage!.sources.statusline.byEntrypoint['cli']!)}`);
    expect(card.get('[data-source="telemetry"]').text()).toMatch(/VS Code .* · Terminal /);

    const collect = () => wrapper.get('.settings-usage .usage-collect');
    expect(collect().attributes('data-state')).toBe('checked');
    await collect().trigger('click');
    await flushPromises();
    expect(posts('/api/v1/usage/collection')).toEqual([]);
    const dialog = body().get('[role="alertdialog"]');
    expect(dialog.text()).toContain('Stop collecting usage?');
    expect(dialog.text()).toContain('~/.claude/settings.json');

    // Cancel changes nothing.
    await dialog.findAll('button').find((button) => button.text() === 'Cancel')!.trigger('click');
    await flushPromises();
    expect(body().find('[role="alertdialog"]').exists()).toBe(false);
    expect(posts('/api/v1/usage/collection')).toEqual([]);
    expect(collect().attributes('data-state')).toBe('checked');

    // Confirmed: Core turns it off, with the session's CSRF token.
    await collect().trigger('click');
    await flushPromises();
    await body().get('[data-confirm-collection]').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/usage/collection').map((call) => [call.body, call.csrf])).toEqual([[{ enabled: false }, CSRF]]);
    expect(state.notice).toBe('Usage collection is off. Your previous Claude Code settings are restored.');
    expect(collect().attributes('data-state')).toBe('unchecked');
    expect(body().find('[role="alertdialog"]').exists()).toBe(false);

    // And on again, explaining what JERRY edits.
    await collect().trigger('click');
    await flushPromises();
    expect(body().get('[role="alertdialog"]').text()).toContain('A backup of the file is taken first.');
    await body().get('[data-confirm-collection]').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/usage/collection').map((call) => call.body)).toEqual([{ enabled: false }, { enabled: true }]);
    expect(collect().attributes('data-state')).toBe('checked');
    wrapper.unmount();
  });

  it('saves whether the usage bar shows', async () => {
    const wrapper = await mountApp('#/settings');
    expect(wrapper.find('[data-usage-bar]').exists()).toBe(true);
    await wrapper.get('.settings-usage .usage-show-bar').trigger('click');
    await flushPromises();
    expect(posts('/api/v1/settings').map((call) => [call.body, call.csrf])).toEqual([[{ usageShowBar: false }, CSRF]]);
    expect(wrapper.find('[data-usage-bar]').exists()).toBe(false);
    expect(wrapper.get('.settings-usage .usage-show-bar').attributes('data-state')).toBe('unchecked');
    wrapper.unmount();
  });

  it('offers the desktop app settings only inside the Jerry app', async () => {
    const browser = await mountApp('#/settings');
    expect(browser.find('.settings-desktop').exists()).toBe(false);
    browser.unmount();

    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0 JerryDesktop/0.1.0');
    const desktop = await mountApp('#/settings');
    const link = desktop.get('.settings-desktop [data-desktop-settings]');
    expect(link.element.tagName).toBe('A');
    expect(link.text()).toBe('Desktop app settings…');
    expect(link.attributes('href')).toBe(`${window.location.origin}/desktop/settings`);
    desktop.unmount();
  });

  it('keeps the last summary when a refresh fails, and says so', async () => {
    const wrapper = await mountApp();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'database is locked' }), { status: 500, headers: { 'content-type': 'application/json' } }));
    await loadUsage(true);
    await flushPromises();
    expect(state.usageState).toBe('error');
    expect(wrapper.get('.usage-card').text()).toContain('Not refreshed: database is locked');
    expect(meter(wrapper, '5h').text()).toBe('23%5h session');
    wrapper.unmount();
  });
});
