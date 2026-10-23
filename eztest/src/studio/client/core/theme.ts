/**
 * Light and dark themes. "system" follows prefers-color-scheme; an explicit
 * choice sets `data-theme` on <html>, which the colour tokens in tokens.css read.
 */
import { store } from './store.js';

export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'eztest-studio-theme';

function saved(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const theme = store<ThemeChoice>(saved());

const media = window.matchMedia('(prefers-color-scheme: dark)');

/** The theme actually shown. */
export const effectiveTheme = store<'light' | 'dark'>('light');

function apply(): void {
  const choice = theme.get();
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  effectiveTheme.set(choice === 'system' ? (media.matches ? 'dark' : 'light') : choice);
}

theme.subscribe((v) => {
  try {
    if (v === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    // storage unavailable
  }
  apply();
});
media.addEventListener('change', apply);

/** Switch between light and dark (from system, to the opposite of what is shown). */
export function toggleTheme(): void {
  theme.set(effectiveTheme.get() === 'dark' ? 'light' : 'dark');
}
