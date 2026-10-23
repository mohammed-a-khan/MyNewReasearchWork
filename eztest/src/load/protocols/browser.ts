/**
 * Browser-level virtual users through EZTest's own browser driver
 * (`eztest/browser`): one browser per load generator, one isolated context
 * (cookies, storage, cache) per VU. Each browser action is timed as a
 * "page" sample; navigations also report the browser's Navigation Timing
 * (TTFB, DOMContentLoaded, load). Network emulation for a population is
 * applied through the DevTools protocol on Chromium.
 */
import { EzTestError } from '../../core/index.js';
import type { BrowserActionSpec, LoadOptionsSpec, NetworkSpec } from '../model.js';
import { render, type TemplateScope } from '../template.js';

type Browser = import('../../browser/index.js').Browser;
type BrowserContext = import('../../browser/index.js').BrowserContext;
type Page = import('../../browser/index.js').Page;

export interface BrowserOutcome {
  ok: boolean;
  errorType?: string;
  message?: string;
  navigation?: { ttfb: number; domContentLoaded: number; load: number; transferSize: number };
  vars?: Array<[string, unknown]>;
}

export class BrowserPool {
  private browser?: Promise<Browser>;
  constructor(private readonly o: NonNullable<LoadOptionsSpec['browser']> | undefined) {}

  private launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        assertBrowserAvailable();
        const mod = await import('../../browser/index.js');
        const type = this.o?.name === 'firefox' ? mod.firefox : mod.chromium;
        return type.launch({ headless: this.o?.headless ?? true, ...(this.o?.executablePath ? { executablePath: this.o.executablePath } : {}) });
      })();
    }
    return this.browser;
  }

  async newUser(network?: NetworkSpec, baseUrl?: string): Promise<BrowserUser> {
    const b = await this.launch();
    const ctx = await b.newContext({ ...(baseUrl ? { baseURL: baseUrl } : {}), viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    if (network && (network.latencyMs || network.downloadKbps || network.uploadKbps)) {
      try {
        const cdp = page.cdpSession();
        await cdp.send('Network.enable', {});
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: network.latencyMs,
          downloadThroughput: network.downloadKbps ? (network.downloadKbps * 1000) / 8 : -1,
          uploadThroughput: network.uploadKbps ? (network.uploadKbps * 1000) / 8 : -1,
        });
      } catch {
        // Firefox: no CDP network emulation; the population runs unshaped.
      }
    }
    return new BrowserUser(ctx, page, baseUrl);
  }

  async close(): Promise<void> {
    const b = await this.browser?.catch(() => undefined);
    this.browser = undefined;
    await b?.close().catch(() => undefined);
  }
}

export class BrowserUser {
  constructor(readonly context: BrowserContext, readonly page: Page, private readonly baseUrl?: string) {}

  async run(a: BrowserActionSpec, scope: TemplateScope, timeoutDefault: number): Promise<BrowserOutcome> {
    const timeout = a.timeoutMs ?? timeoutDefault;
    const p = this.page;
    const r = (s: string) => render(s, scope);
    try {
      let navigation: BrowserOutcome['navigation'];
      if (a.goto !== undefined) {
        const url = new URL(r(a.goto), this.baseUrl ?? 'http://localhost').href;
        const res = await p.goto(url, { timeout, waitUntil: 'load' });
        if (res && res.status() >= 400) return { ok: false, errorType: `HTTP ${res.status()}`, message: `${url} returned ${res.status()}` };
        navigation = await this.navigationTiming();
      }
      if (a.fill !== undefined) await p.locator(r(a.fill)).fill(r(a.value ?? ''), { timeout });
      if (a.select !== undefined) await p.locator(r(a.select)).selectOption(r(a.value ?? ''), { timeout });
      if (a.check !== undefined) await p.locator(r(a.check)).check({ timeout });
      if (a.press !== undefined) await p.locator(r(a.press)).press(r(a.key ?? 'Enter'), { timeout });
      if (a.click !== undefined) {
        await p.locator(r(a.click)).click({ timeout });
        await p.waitForLoadState('load', { timeout }).catch(() => undefined);
      }
      if (a.waitFor !== undefined) await p.locator(r(a.waitFor)).first().waitFor({ state: 'visible', timeout });
      if (a.expectUrl !== undefined) {
        const want = r(a.expectUrl);
        await p.waitForURL((u: URL) => u.href.includes(want), { timeout }).catch(() => undefined);
        if (!p.url().includes(want)) return { ok: false, errorType: 'assertion', message: `page URL ${p.url()} does not contain "${want}"` };
      }
      if (a.expectText !== undefined) {
        const want = r(a.expectText);
        const ok = await p.getByText(want).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
        if (!ok) return { ok: false, errorType: 'assertion', message: `page does not show "${want.slice(0, 80)}"` };
      }
      let vars: BrowserOutcome['vars'];
      if (a.capture) vars = [[a.capture.var, ((await p.locator(r(a.capture.selector)).first().textContent({ timeout })) ?? '').trim()]];
      if ((a.click !== undefined || a.press !== undefined) && !navigation) navigation = await this.navigationTiming();
      return { ok: true, navigation, vars };
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      return { ok: false, errorType: /timeout/i.test(msg) ? 'TIMEOUT' : 'browser', message: msg.split('\n')[0].slice(0, 300) };
    }
  }

  private async navigationTiming(): Promise<BrowserOutcome['navigation']> {
    try {
      return (await this.page.evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { ttfb: n.responseStart - n.startTime, domContentLoaded: n.domContentLoadedEventEnd - n.startTime, load: n.loadEventEnd - n.startTime, transferSize: n.transferSize || 0 } : undefined; })()`)) as BrowserOutcome['navigation'];
    } catch {
      return undefined;
    }
  }

  async clearSession(): Promise<void> {
    await this.context.clearCookies();
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

export function assertBrowserAvailable(): void {
  if (process.env.EZTEST_LOAD_NO_BROWSER === '1') throw new EzTestError('browser-level users are disabled on this load generator (EZTEST_LOAD_NO_BROWSER=1)', 'LOAD_BROWSER');
}
