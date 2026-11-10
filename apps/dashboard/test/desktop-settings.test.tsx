// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopSettings, SOUND_GROUPS } from '../src/components/DesktopSettings';
import type { DesktopSettingsValue } from '../src/lib/desktop';
import { chooseOption, openSelect } from './select-helper';

const APP_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0 JerryDesktop/0.1.0';
const STORED: DesktopSettingsValue = {
  launchWithWindows: false,
  openWindowOnStart: true,
  notificationsEnabled: true,
  planWaiting: true,
  reportWaiting: true,
  fixesWaiting: true,
  taskDone: true,
  taskBlocked: true,
  coreStopped: true,
  sound: 'Default',
};

/** The Jerry app's settings commands as the app offers them to its Core's dashboard. */
function fakeApp() {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  let stored = { ...STORED };
  const invoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    calls.push([command, args]);
    if (command === 'get_settings') return stored;
    if (command === 'set_settings') {
      stored = { ...(args!['settings'] as DesktopSettingsValue) };
      return stored;
    }
    if (command === 'send_test_notification') return null;
    throw new Error(`not allowed: ${command}`);
  };
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
  return calls;
}

describe('Desktop app settings inline in Settings', () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
    vi.restoreAllMocks();
  });

  it('shows the app settings inline and saves each change at once through the app', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_AGENT);
    const calls = fakeApp();
    const wrapper = mount(DesktopSettings, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.find('[data-desktop-settings]').exists()).toBe(false);
    expect(wrapper.findAll('[data-desktop-option]').map((row) => row.attributes('data-desktop-option'))).toEqual([
      'launchWithWindows',
      'openWindowOnStart',
      'notificationsEnabled',
      'planWaiting',
      'reportWaiting',
      'fixesWaiting',
      'taskDone',
      'taskBlocked',
      'coreStopped',
    ]);
    // Every sound the app knows (settings.rs SOUNDS: 25) and None.
    const sounds = await openSelect(wrapper.get('#desktop-sound'));
    expect(sounds).toHaveLength(26);
    expect(SOUND_GROUPS.flatMap((group) => group.sounds.map(([value]) => value))).toContain('Call10');

    await wrapper.get('[data-desktop-option="launchWithWindows"] [role="switch"]').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toEqual(['set_settings', { settings: { ...STORED, launchWithWindows: true } }]);
    expect(wrapper.get('.desktop-message').text()).toBe('Saved.');

    await chooseOption(await openSelect(wrapper.get('#desktop-sound')), 'Reminder');
    expect(calls.at(-1)).toEqual(['set_settings', { settings: { ...STORED, launchWithWindows: true, sound: 'Reminder' } }]);

    await wrapper.get('[data-desktop-test]').trigger('click');
    await flushPromises();
    expect(calls.at(-1)).toEqual(['send_test_notification', { sound: 'Reminder' }]);
    // Only the three settings commands are used.
    expect(new Set(calls.map(([command]) => command))).toEqual(new Set(['get_settings', 'set_settings', 'send_test_notification']));
    wrapper.unmount();
  });

  it('turns the per-type switches off while notifications are off', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_AGENT);
    fakeApp();
    const wrapper = mount(DesktopSettings, { attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-desktop-option="notificationsEnabled"] [role="switch"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-desktop-option="taskDone"] [role="switch"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('#desktop-sound').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('falls back to the app settings page in an app without the bridge', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_AGENT);
    const wrapper = mount(DesktopSettings, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-desktop-settings]').attributes('href')).toBe(`${window.location.origin}/desktop/settings`);
    wrapper.unmount();
  });
});
