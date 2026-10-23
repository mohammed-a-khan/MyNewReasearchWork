/**
 * Web Vitals collector. A script installed with page.addInitScript (so it runs
 * before any page script on every navigation) registers buffered
 * PerformanceObservers for LCP, CLS (session windows), INP (event timing,
 * grouped by interactionId), FCP and TTFB. `collect(page)` reads the values.
 */
import type { Page } from '../browser/index.js';
import { EzTestError } from '../core/index.js';

export interface WebVitals {
  url: string;
  /** Largest Contentful Paint, ms. */
  LCP: number | null;
  /** Cumulative Layout Shift (largest session window), unitless. */
  CLS: number;
  /** Interaction to Next Paint, ms (null when there was no interaction). */
  INP: number | null;
  /** First Contentful Paint, ms. */
  FCP: number | null;
  /** Time To First Byte, ms. */
  TTFB: number | null;
  interactions: number;
  lcpElement: string | null;
  /** Entry types the browser could not observe. */
  unsupported: string[];
}

/** Browser-side source. Plain JS string: it runs in the page, never in Node. */
export const WEB_VITALS_INIT_SCRIPT = `(() => {
  if (window.__ezVitals) return;
  var v = { LCP: null, CLS: 0, INP: null, FCP: null, TTFB: null, interactions: 0, lcpElement: null, unsupported: [] };
  window.__ezVitals = v;
  function obs(type, cb, extra) {
    try {
      if (PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.indexOf(type) < 0) { v.unsupported.push(type); return; }
      var po = new PerformanceObserver(function (list) { list.getEntries().forEach(cb); });
      var o = { type: type, buffered: true };
      if (extra) for (var k in extra) o[k] = extra[k];
      po.observe(o);
    } catch (e) { v.unsupported.push(type); }
  }
  obs('largest-contentful-paint', function (e) { v.LCP = e.renderTime || e.startTime; v.lcpElement = e.element ? e.element.tagName.toLowerCase() : null; });
  var sv = 0, se = [];
  obs('layout-shift', function (e) {
    if (e.hadRecentInput) return;
    var first = se[0], last = se[se.length - 1];
    if (sv && e.startTime - last.startTime < 1000 && e.startTime - first.startTime < 5000) { sv += e.value; se.push(e); }
    else { sv = e.value; se = [e]; }
    if (sv > v.CLS) v.CLS = sv;
  });
  obs('paint', function (e) { if (e.name === 'first-contentful-paint') v.FCP = e.startTime; });
  var inter = new Map();
  function onEvent(e) {
    if (!e.interactionId) return;
    inter.set(e.interactionId, Math.max(inter.get(e.interactionId) || 0, e.duration));
    var ds = Array.from(inter.values()).sort(function (a, b) { return b - a; });
    v.INP = ds[Math.min(ds.length - 1, Math.floor(ds.length / 50))];
    v.interactions = inter.size;
  }
  obs('event', onEvent, { durationThreshold: 16 });
  obs('first-input', onEvent);
  window.__ezVitalsNav = function () {
    var n = performance.getEntriesByType('navigation')[0];
    if (n && n.responseStart > 0) v.TTFB = Math.max(0, n.responseStart - (n.activationStart || 0));
  };
  window.__ezVitalsNav();
})();`;

const READ_SCRIPT = `new Promise(function (resolve) {
  if (!window.__ezVitals) { resolve(null); return; }
  requestAnimationFrame(function () { setTimeout(function () {
    if (window.__ezVitalsNav) window.__ezVitalsNav();
    resolve(JSON.stringify(Object.assign({ url: location.href }, window.__ezVitals)));
  }, 0); });
})`;

export async function installWebVitals(page: Page): Promise<void> {
  await page.addInitScript({ content: WEB_VITALS_INIT_SCRIPT });
}

export async function collectWebVitals(page: Page): Promise<WebVitals> {
  const raw = (await page.evaluate(READ_SCRIPT)) as string | null;
  if (raw === null) {
    throw new EzTestError('Web Vitals collector is not installed in this page; call installWebVitals(page) before navigating', 'VITALS_NOT_INSTALLED');
  }
  return JSON.parse(raw) as WebVitals;
}

/** Convenience object: `const c = new WebVitalsCollector(); await c.install(page); ... await c.collect(page)`. */
export class WebVitalsCollector {
  private installed = new WeakSet<Page>();
  async install(page: Page): Promise<void> {
    if (this.installed.has(page)) return;
    await installWebVitals(page);
    this.installed.add(page);
  }
  async collect(page: Page): Promise<WebVitals> {
    return collectWebVitals(page);
  }
}
