/** The Jerry app's main window marks its user agent ("… JerryDesktop/0.1.0"). */
export const DESKTOP_MARKER = 'JerryDesktop/';

/** Whether the dashboard runs inside the Jerry app's window (read at call time, so tests can change it). */
export function inJerryDesktop(): boolean {
  try {
    return navigator.userAgent.includes(DESKTOP_MARKER);
  } catch {
    return false;
  }
}

/**
 * The address the Jerry app intercepts to open its own settings page. Core answers it with 204
 * in a browser, so following it outside the app changes nothing.
 */
export function desktopSettingsUrl(): string {
  return `${window.location.origin}/desktop/settings`;
}

/** The Jerry app's settings, as its settings commands read and write them (settings.rs, camelCase). */
export interface DesktopSettingsValue {
  launchWithWindows: boolean;
  openWindowOnStart: boolean;
  notificationsEnabled: boolean;
  planWaiting: boolean;
  reportWaiting: boolean;
  fixesWaiting: boolean;
  taskDone: boolean;
  taskBlocked: boolean;
  coreStopped: boolean;
  sound: string;
}

export interface DesktopBridge {
  getSettings(): Promise<DesktopSettingsValue>;
  setSettings(settings: DesktopSettingsValue): Promise<DesktopSettingsValue>;
  sendTestNotification(sound: string): Promise<void>;
}

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * The Jerry app's settings commands, when the dashboard runs inside the app and the app offers them
 * (it grants its Core's dashboard exactly these three); null in a browser or an older Jerry.
 */
export function desktopBridge(): DesktopBridge | null {
  if (!inJerryDesktop()) return null;
  const invoke = (window as unknown as { __TAURI__?: { core?: { invoke?: TauriInvoke } } }).__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') return null;
  return {
    getSettings: async () => (await invoke('get_settings')) as DesktopSettingsValue,
    setSettings: async (settings) => (await invoke('set_settings', { settings })) as DesktopSettingsValue,
    sendTestNotification: async (sound) => {
      await invoke('send_test_notification', { sound });
    },
  };
}
