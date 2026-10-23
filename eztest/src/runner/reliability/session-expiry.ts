/**
 * "Session expired mid-journey": long journeys and shared test accounts get
 * logged out half way (idle timeouts, another worker signing in as the same
 * user, password rotation). When a step fails and the page shows the login
 * page, a "session expired" message or the step's calls got 401/440, the
 * runner signs the journey's role in again once, returns to where the step
 * started and re-runs the step. The re-login is recorded in evidence; a
 * second expiry in the same journey is a real failure.
 */
import type { Page } from '../../browser/index.js';
import { urlMatches } from '../pages.js';
import type { RequestRecord } from '../session.js';

export interface SessionExpiryOptions {
  /** URL patterns of the login / "signed out" pages (globs or /regex/). The roles' login URLs are added by the engine. */
  urls?: string[];
  /** Texts that mean the session ended, e.g. "Your session has expired". Case-insensitive. */
  text?: string[];
  /** Response statuses that mean the session ended. Default [401, 440]. */
  statuses?: number[];
  /** Re-login once and retry the step. Default true. */
  relogin?: boolean;
}

export const DEFAULT_EXPIRY_TEXT = ['session has expired', 'session expired', 'your session timed out', 'please sign in again', 'please log in again', 'you have been logged out', 'you have been signed out'];

/** Why the session looks expired, or undefined. Read-only. */
export async function detectSessionExpiry(page: Page, o: SessionExpiryOptions, requests: RequestRecord[] = [], since = 0): Promise<string | undefined> {
  const url = page.url();
  for (const p of o.urls ?? []) {
    if (p && urlMatches(url, p)) return `the page is the sign-in page (${pathOf(url)})`;
  }
  const statuses = o.statuses ?? [401, 440];
  const denied = requests.find((r) => r.startedAt >= since && r.status !== undefined && statuses.includes(r.status) && (r.resourceType === 'document' || r.resourceType === 'xhr' || r.resourceType === 'fetch'));
  if (denied) return `${denied.method} ${pathOf(denied.url)} returned ${denied.status}`;
  const texts = [...(o.text ?? []), ...DEFAULT_EXPIRY_TEXT].map((t) => t.toLowerCase());
  const body = (await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')).toLowerCase();
  const hit = texts.find((t) => body.includes(t));
  return hit ? `the page says "${hit}"` : undefined;
}

function pathOf(u: string): string {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
}
