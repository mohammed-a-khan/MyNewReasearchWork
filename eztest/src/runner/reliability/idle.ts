/**
 * "App idle": an optional wait before acting until the application has
 * settled. An init script (installed on the browser context, so it runs in
 * every page and frame before any app code) counts pending fetch() and
 * XMLHttpRequest calls and remembers when network activity last ended. The
 * check also asks the frameworks that expose a quiescence signal:
 *  - Angular (getAllAngularTestabilities().isStable()),
 *  - AngularJS ($http pendingRequests),
 *  - jQuery (jQuery.active),
 *  - an app-provided hook: window.__EZTEST_BUSY__ (boolean or function returning boolean),
 *  - document.readyState and <html|body aria-busy="true">.
 * React and Vue expose no public quiescence API; for them the request
 * counter (and, if the app sets it, __EZTEST_BUSY__) is the signal.
 *
 * Reaching the cap is not an error: the step goes ahead and the wait is
 * recorded (cause "network") for the flake classifier.
 */
import type { BrowserContext, Page } from '../../browser/index.js';
import { sleep } from '../../core/index.js';
import { pageFunction } from '../../heal/fingerprint.js';

export interface AppIdleOptions {
  /** Longest wait before going ahead anyway. Default 10000 ms. */
  timeoutMs?: number;
  /** Network must have been quiet this long. Default 50 ms. */
  quietMs?: number;
  /** Requests whose URL contains any of these are not counted (long polling, analytics beacons). */
  ignoreUrls?: string[];
}

export interface IdleState {
  pending: number;
  quietForMs: number;
  busy: string[];
}

export interface IdleWaitResult {
  waitedMs: number;
  capped: boolean;
  /** Why it waited (e.g. "2 pending request(s)", "angular not stable"). */
  reasons: string[];
}

/** The init script source. `ignore` is serialised into the script as JSON (static data, never code). */
export function appIdleInitScript(ignore: string[] = []): string {
  return `(() => {
  if (window.__ezIdle) return;
  var ignore = ${JSON.stringify(ignore)};
  var s = { pending: 0, last: Date.now() };
  Object.defineProperty(window, '__ezIdle', { value: s, enumerable: false });
  var skip = function (u) { u = String(u || ''); for (var i = 0; i < ignore.length; i++) if (u.indexOf(ignore[i]) >= 0) return true; return false; };
  var done = function () { s.pending = Math.max(0, s.pending - 1); s.last = Date.now(); };
  var of = window.fetch;
  if (typeof of === 'function') {
    window.fetch = function (input, init) {
      var url = input && typeof input === 'object' && 'url' in input ? input.url : input;
      if (skip(url)) return of.apply(this, arguments);
      s.pending++; s.last = Date.now();
      var p;
      try { p = of.apply(this, arguments); } catch (e) { done(); throw e; }
      p.then(done, done);
      return p;
    };
  }
  var X = window.XMLHttpRequest;
  if (X && X.prototype) {
    var open = X.prototype.open, send = X.prototype.send;
    X.prototype.open = function (m, u) { this.__ezUrl = u; return open.apply(this, arguments); };
    X.prototype.send = function () {
      if (!skip(this.__ezUrl)) {
        s.pending++; s.last = Date.now();
        var self = this, fired = false;
        this.addEventListener('loadend', function () { if (!fired) { fired = true; done(); } });
      }
      return send.apply(this, arguments);
    };
  }
})();`;
}

const STATE = String.raw`() => {
  var s = window.__ezIdle;
  var busy = [];
  if (document.readyState !== 'complete') busy.push('document ' + document.readyState);
  try {
    if (typeof window.getAllAngularTestabilities === 'function') {
      var t = window.getAllAngularTestabilities();
      for (var i = 0; i < t.length; i++) if (!t[i].isStable()) { busy.push('angular not stable'); break; }
    }
  } catch (e) {}
  try {
    if (window.angular && window.angular.element) {
      var inj = window.angular.element(document.body).injector && window.angular.element(document.body).injector();
      if (inj && inj.has && inj.has('$http') && inj.get('$http').pendingRequests.length) busy.push('angularjs $http pending');
    }
  } catch (e) {}
  try { if (window.jQuery && window.jQuery.active > 0) busy.push('jQuery.active=' + window.jQuery.active); } catch (e) {}
  try {
    var h = window.__EZTEST_BUSY__;
    if (h === true || (typeof h === 'function' && h())) busy.push('app reports busy (__EZTEST_BUSY__)');
  } catch (e) {}
  if (document.documentElement.getAttribute('aria-busy') === 'true' || (document.body && document.body.getAttribute('aria-busy') === 'true')) busy.push('aria-busy');
  return { pending: s ? s.pending : 0, quietForMs: s ? Date.now() - s.last : 1e9, busy: busy };
}`;

const stateFn = pageFunction<void, IdleState>(STATE);

/** Install the request counter on a browser context (all pages and frames). */
export async function installAppIdle(context: BrowserContext, o: AppIdleOptions = {}): Promise<void> {
  await context.addInitScript({ content: appIdleInitScript(o.ignoreUrls ?? []) });
}

/** Read the idle state of a page once. */
export async function appIdleState(page: Page): Promise<IdleState> {
  return page.evaluate(stateFn);
}

/** Wait until the app is idle (or the cap is reached). Never throws for a busy app. */
export async function waitForAppIdle(page: Page, o: AppIdleOptions = {}): Promise<IdleWaitResult> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const quietMs = o.quietMs ?? 50;
  const t0 = Date.now();
  const reasons = new Set<string>();
  for (;;) {
    let st: IdleState;
    try {
      st = await page.evaluate(stateFn);
    } catch {
      // Navigating: the next document will report.
      reasons.add('navigation in progress');
      if (Date.now() - t0 >= timeoutMs) return { waitedMs: Date.now() - t0, capped: true, reasons: [...reasons] };
      await sleep(50);
      continue;
    }
    const why = [...st.busy];
    if (st.pending > 0) why.push(`${st.pending} pending request(s)`);
    else if (st.quietForMs < quietMs) why.push('network just finished');
    if (!why.length) return { waitedMs: Date.now() - t0, capped: false, reasons: [...reasons] };
    for (const w of why) if (w !== 'network just finished') reasons.add(w.replace(/^\d+ pending/, 'pending'));
    if (Date.now() - t0 >= timeoutMs) return { waitedMs: Date.now() - t0, capped: true, reasons: [...reasons] };
    await sleep(Math.min(50, Math.max(quietMs - st.quietForMs, 10)));
  }
}
