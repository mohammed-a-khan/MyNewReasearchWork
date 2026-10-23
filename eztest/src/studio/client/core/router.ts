/**
 * Hash router with deep links: `#/<page>/<rest>?<query>`. The first segment
 * selects a page; the page interprets the rest, e.g.
 * `#/journeys/journeys/login.ez:12` or `#/runs/<runId>/<journeyId>/<stepId>`.
 */
import { store } from './store.js';

export interface Route {
  /** Page route (first segment), e.g. "journeys". */
  page: string;
  /** Decoded remainder after the page segment ("" when none). */
  rest: string;
  /** Decoded remainder split on "/". */
  segments: string[];
  query: URLSearchParams;
  /** The raw hash without "#". */
  raw: string;
}

function parse(hash: string): Route {
  let raw = hash.replace(/^#/, '');
  // Old Studio links: "#journeys".
  if (raw && !raw.startsWith('/')) raw = `/${raw}`;
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter((p, i) => i > 0 || p !== '');
  const segs = parts.filter((p) => p !== '').map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [page = '', ...rest] = segs;
  return { page, rest: rest.join('/'), segments: rest, query: new URLSearchParams(queryPart), raw };
}

export const route = store<Route>(parse(location.hash), (a, b) => a.raw === b.raw);

window.addEventListener('hashchange', () => route.set(parse(location.hash)));

/** Build a hash link from segments (each segment is encoded; "/" inside a segment stays a separator only if passed as separate segments). */
export function link(page: string, ...segments: Array<string | number | undefined>): string {
  const segs = [page, ...segments.filter((s) => s !== undefined && s !== '').map(String)];
  return '#/' + segs.map((s) => s.split('/').map(encodeURIComponent).join('/')).join('/');
}

/** Navigate to a hash link (e.g. `link('runs', id)`). */
export function navigate(hash: string, opts: { replace?: boolean } = {}): void {
  const target = hash.startsWith('#') ? hash : `#${hash.startsWith('/') ? '' : '/'}${hash}`;
  if (location.hash === target) {
    route.set(parse(target));
    return;
  }
  if (opts.replace) {
    history.replaceState(null, '', target);
    route.set(parse(target));
  } else location.hash = target;
}
