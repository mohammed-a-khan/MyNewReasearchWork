/**
 * Browser context reuse (opt-in, `reuseContext`). Creating a BrowserContext
 * per journey is the safe default; reusing one per worker saves the setup
 * cost, provided nothing leaks from one journey into the next. Between
 * journeys the pool:
 *  - closes every page and removes the previous journey's event listeners,
 *  - clears cookies, permissions, routes, extra headers, geolocation and offline mode,
 *  - clears localStorage, sessionStorage, IndexedDB, Cache Storage and service
 *    workers of every origin the journey visited (on a blank document served
 *    for that origin by a route, so the app is never loaded),
 *  - refuses to reuse a context that got an init script or an exposed binding
 *    from a journey (those cannot be removed): such a context is closed.
 * Journeys with their own context options (emulation, video, trace) always get
 * a fresh context.
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '../../browser/index.js';
import type { Journey } from '../../core/index.js';

const EVENTS = ['page', 'request', 'response', 'requestfinished', 'requestfailed', 'console', 'dialog', 'weberror', 'serviceworker', 'backgroundpage'] as const;

interface Pooled {
  context: BrowserContext;
  origins: Set<string>;
  tainted: boolean;
  watching?: boolean;
}

const CLEAR_STORAGE = async () => {
  try { localStorage.clear(); } catch { /* disabled */ }
  try { sessionStorage.clear(); } catch { /* disabled */ }
  try {
    const dbs = (await (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases?.()) ?? [];
    await Promise.all(dbs.map((d) => new Promise<void>((res) => {
      if (!d.name) return res();
      const r = indexedDB.deleteDatabase(d.name);
      r.onsuccess = r.onerror = r.onblocked = () => res();
    })));
  } catch { /* no IndexedDB */ }
  try { if ('caches' in self) for (const k of await caches.keys()) await caches.delete(k); } catch { /* none */ }
  try { if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch { /* none */ }
};

export class ContextPool {
  private readonly idle: Pooled[] = [];
  private readonly all = new Map<BrowserContext, Pooled>();
  /** Contexts handed out, then reset and reused (for tests and reports). */
  reused = 0;
  created = 0;

  constructor(private readonly browser: Browser, private readonly base: BrowserContextOptions, private readonly onCreate?: (c: BrowserContext) => Promise<void>) {}

  /** Can this journey run in a shared context? (No per-journey context options.) */
  static eligible(journey: Journey, o: { video?: string; trace?: boolean; traceMode?: string; timeTravel?: unknown; debug?: unknown }): boolean {
    return !journey.emulation && (o.video ?? 'off') === 'off' && !o.trace && (o.traceMode ?? 'off') === 'off' && !o.timeTravel && !o.debug;
  }

  async acquire(): Promise<BrowserContext> {
    const p = this.idle.pop();
    if (p) {
      this.reused++;
      return p.context;
    }
    const context = await this.browser.newContext(this.base);
    if (this.onCreate) await this.onCreate(context);
    const pooled: Pooled = { context, origins: new Set(), tainted: false };
    // Anything a journey adds that cannot be removed again makes the context single-use.
    const taint = <T extends (...a: never[]) => unknown>(fn: T): T => ((...a: Parameters<T>) => { pooled.tainted = true; return fn.apply(context, a); }) as T;
    context.addInitScript = taint(context.addInitScript.bind(context));
    context.exposeBinding = taint(context.exposeBinding.bind(context));
    context.exposeFunction = taint(context.exposeFunction.bind(context));
    this.created++;
    this.all.set(context, pooled);
    return context;
  }

  /** Watch a journey page: service workers registered by its origin are removed on release. */
  track(page: Page): void {
    const pooled = this.all.get(page.context());
    if (!pooled || pooled.watching) return;
    pooled.watching = true;
    const remember = (url: string) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') pooled.origins.add(u.origin);
      } catch { /* ignore */ }
    };
    // Every origin a journey visits may hold storage (localStorage, IndexedDB, caches): remember them all,
    // so the reset does not depend on the driver being able to list storage after the pages are closed.
    const watchPage = (p: Page) => p.on('framenavigated', (f) => remember(f.url()));
    watchPage(page);
    page.context().on('page', watchPage);
    page.context().on('serviceworker', (w) => remember(w.url()));
  }

  /** Reset a context and make it available again (or close it when it cannot be reset safely). */
  async release(context: BrowserContext): Promise<void> {
    const pooled = this.all.get(context);
    if (!pooled) return void (await context.close().catch(() => undefined));
    try {
      if (pooled.tainted) throw new Error('tainted');
      for (const e of EVENTS) context.removeAllListeners(e);
      pooled.watching = false;
      // Closing the pages also ends their sessionStorage (it belongs to the tab).
      for (const p of context.pages()) await p.close().catch(() => undefined);
      await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => undefined);
      await context.clearCookies();
      await context.clearPermissions();
      await context.setExtraHTTPHeaders({});
      await context.setOffline(false);
      await context.setGeolocation(null);
      // Origins that still hold persistent storage (localStorage, IndexedDB) or registered a service worker.
      // Only those need a reset document, so a journey that stored nothing costs no navigation.
      const state = await context.storageState({ indexedDB: true });
      const origins = new Set([...pooled.origins, ...state.origins.filter((o) => o.localStorage.length || (o as { indexedDB?: unknown[] }).indexedDB?.length).map((o) => o.origin)]);
      if (origins.size) {
        const page = await context.newPage();
        await page.route('**/*', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>reset</title>' }));
        for (const o of origins) {
          await page.goto(`${o}/__eztest_reset__`, { timeout: 5000 });
          await page.evaluate(CLEAR_STORAGE);
        }
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.close();
        await context.clearCookies(); // the reset documents must not leave any
      }
      pooled.origins.clear();
      this.idle.push(pooled);
    } catch {
      this.all.delete(context);
      await context.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    for (const c of this.all.keys()) await c.close().catch(() => undefined);
    this.all.clear();
    this.idle.length = 0;
  }
}
