/**
 * The browsers EZTest supports: the one source of truth for the CLI's --browser choices, the Studio's
 * Run and Debug pages, and request validation. EZTest drives Chromium-family browsers over CDP and
 * Firefox over WebDriver BiDi; Safari/WebKit is not supported (`browser: webkit` fails with a clear message).
 */

/** Browser engines for the `browser:` setting, `--browser` and a Studio run's Browser field. */
export const BROWSER_ENGINES = ['chromium', 'firefox'] as const;
export type BrowserEngineName = (typeof BROWSER_ENGINES)[number];

/** Browsers a cross-browser run can list (`browsers:`, `--browsers`, the Studio's cross-browser boxes); chrome and msedge also take a channel suffix such as msedge-beta. */
export const BROWSER_TARGETS = ['chromium', 'firefox', 'msedge', 'chrome'] as const;

/** A cross-browser target name: one of BROWSER_TARGETS, or chrome / msedge with a beta, dev or canary channel. */
export const BROWSER_TARGET_RE = /^(?:chromium|firefox|chrome|msedge)(?:-(?:beta|dev|canary))?$/;

export function isBrowserEngine(name: unknown): name is BrowserEngineName {
  return typeof name === 'string' && (BROWSER_ENGINES as readonly string[]).includes(name);
}
