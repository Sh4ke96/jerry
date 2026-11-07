import { ref } from 'vue';

/** The colour theme the user chose; "system" follows the operating system, live. */
export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'jerry.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemIsDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

export const theme = ref<ThemeChoice>(readChoice());

/** Puts the `dark` class on <html> when the chosen (or the system's) theme is dark. */
export function applyTheme(): void {
  const dark = theme.value === 'dark' || (theme.value === 'system' && systemIsDark());
  document.documentElement.classList.toggle('dark', dark);
}

export function setTheme(choice: ThemeChoice): void {
  theme.value = choice;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  applyTheme();
}

/** Applies the stored theme and follows the system while the choice is "system". */
export function startTheme(): void {
  theme.value = readChoice();
  applyTheme();
  try {
    window.matchMedia(DARK_QUERY).addEventListener('change', applyTheme);
  } catch {
    // no media queries: the theme stays as applied
  }
}
