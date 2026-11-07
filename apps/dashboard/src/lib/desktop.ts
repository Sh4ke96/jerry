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
 * The address the Jerry app intercepts to open its own settings window. Core answers it with 204
 * in a browser, so following it outside the app changes nothing.
 */
export function desktopSettingsUrl(): string {
  return `${window.location.origin}/desktop/settings`;
}
