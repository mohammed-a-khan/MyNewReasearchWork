/**
 * A Firefox frame: a WebDriver BiDi browsing context. The frame API,
 * lifecycle bookkeeping and waiting come from CrFrame (engine-independent);
 * this class supplies the BiDi halves: navigation (browsingContext.navigate),
 * the utility world (a sandbox realm) and the owner element.
 */
import { readFile } from 'node:fs/promises';
import { UTILITY_WORLD_NAME } from '../injected/contract.js';
import { CrFrame } from '../chromium/frame.js';
import type { ElementHandle } from '../chromium/handles.js';
import type { CrPage, TargetSession } from '../chromium/page.js';
import type { Deadline } from '../util.js';
import { rewriteError } from '../errors.js';
import type { BidiConnection } from './connection.js';
import type { FfRealm } from './realm.js';
import { netErrorText } from './network.js';
import { targetSessionUnavailable } from './stubs.js';

const SESSION = targetSessionUnavailable() as TargetSession;

/** Sandbox that stands in for the main world when the page runs without JavaScript. */
export const PAGE_WORLD_NAME = '__eztest_page_world__';

export class FfFrame extends CrFrame {
  /** Firefox rewrites such documents fine (the workaround is for a Chromium bug). */
  protected override objectFramesBreakRewrite(): boolean {
    return false;
  }

  /** Navigations (by BiDi navigation id) that failed, with the error to report. */
  readonly failedNavigations = new Map<string, string>();
  /** The last document request of this frame that failed: its error text, and when. */
  lastFailure?: { text: string; at: number };
  /** Navigations that turned into downloads. */
  readonly downloadNavigations = new Set<string>();

  constructor(
    page: CrPage,
    id: string,
    private readonly bidi: BidiConnection,
  ) {
    super(page, id, SESSION);
  }

  /** The realm of a world, if it exists right now. */
  realm(world: 'main' | 'utility'): FfRealm | undefined {
    const r = this.contexts[world] as FfRealm | undefined;
    return r && !r.disposed ? r : undefined;
  }

  protected override async createUtilityWorld(): Promise<unknown> {
    // Addressing the sandbox creates it; its realm arrives as script.realmCreated (and in the result).
    const res = await this.bidi.send('script.evaluate', { expression: '0', target: { context: this.id, sandbox: UTILITY_WORLD_NAME }, awaitPromise: false, resultOwnership: 'none' });
    (this._page as unknown as { onRealmCreated(e: unknown): void }).onRealmCreated({ realm: res.realm, context: this.id, type: 'window', sandbox: UTILITY_WORLD_NAME });
    return res;
  }

  /**
   * With JavaScript disabled (javaScriptEnabled: false) Firefox runs no script in the page's own
   * realm, not even ours: the "main world" is then a sandbox of the document (same DOM; the page
   * has no script globals to see anyway).
   */
  protected override requestMainWorld(): void {
    if (this._page.context().options.javaScriptEnabled !== false || this.creatingPageWorld) return;
    this.creatingPageWorld = this.bidi.send('script.evaluate', { expression: '0', target: { context: this.id, sandbox: PAGE_WORLD_NAME }, awaitPromise: false, resultOwnership: 'none' })
      .then((res) => (this._page as unknown as { onRealmCreated(e: unknown): void }).onRealmCreated({ realm: res.realm, context: this.id, type: 'window', sandbox: PAGE_WORLD_NAME }))
      .catch(() => undefined)
      .finally(() => {
        this.creatingPageWorld = undefined;
      });
  }

  private creatingPageWorld?: Promise<unknown>;

  /**
   * bypassCSP for inline scripts: Firefox has no per-context CSP switch, and a CSP given in a
   * <meta> tag is not covered by stripping response headers. When the page's CSP blocks the
   * inline script of addScriptTag({content | path}), its source runs as a script of the main world
   * instead (BiDi evaluation is not subject to CSP), as it would with CSP bypassed.
   */
  override async addScriptTag(options: { url?: string; path?: string; content?: string; type?: string }): Promise<ElementHandle> {
    const inline = !options.url && (options.content !== undefined || options.path !== undefined) && (!options.type || options.type === 'text/javascript');
    if (!inline || !this._page.context().options.bypassCSP) return super.addScriptTag(options);
    const main = (await this.context('main')) as FfRealm;
    await main.evaluate(() => {
      const w = window as unknown as { __ezCspBlocked?: boolean };
      w.__ezCspBlocked = false;
      document.addEventListener('securitypolicyviolation', (e) => {
        if ((e as SecurityPolicyViolationEvent).blockedURI === 'inline') w.__ezCspBlocked = true;
      }, { once: true });
    }, [], true);
    const el = await super.addScriptTag(options);
    // The violation event is queued: give it a turn.
    const blocked = await main.evaluate(() => new Promise((r) => setTimeout(() => r((window as unknown as { __ezCspBlocked?: boolean }).__ezCspBlocked), 0)), [], true);
    if (blocked) {
      let source = options.content ?? '';
      if (options.path) source = `${await readFile(options.path, 'utf8')}\n//# sourceURL=${options.path.replace(/\n/g, '')}`;
      await main.runScript(source);
    }
    return el;
  }

  override async ownerElement(world: 'main' | 'utility'): Promise<ElementHandle | undefined> {
    const parent = this.parent as FfFrame | undefined;
    if (!parent) return undefined;
    const ctx = (await parent.context(world)) as FfRealm;
    return ctx.ownerElementOf(this.id);
  }

  protected override async startNavigation(target: string, _referer: string | undefined, _deadline: Deadline): Promise<string | undefined> {
    const current = this.url();
    const sameDocument = (() => {
      try {
        const a = new URL(current);
        const b = new URL(target);
        return b.hash !== '' && a.href.replace(/#.*$/, '') === b.href.replace(/#.*$/, '');
      } catch {
        return false;
      }
    })();
    let res: { navigation: string | null; url: string };
    const started = Date.now();
    try {
      res = await this.bidi.send('browsingContext.navigate', { context: this.id, url: target, wait: 'none' }) as typeof res;
    } catch (e) {
      const m = (e as Error).message;
      if (/invalid argument/i.test(m) && /url/i.test(m)) throw new Error('page.goto: Protocol error (browsingContext.navigate): Cannot navigate to invalid URL');
      if (/download/i.test(m)) throw new Error('page.goto: Download is starting');
      // The document request's own error (route.abort reason, network error) is the precise one.
      if (this.lastFailure && this.lastFailure.at >= started) throw new Error(`page.goto: ${this.lastFailure.text} at ${target}`);
      if (/\b(NS|SEC|SSL|MOZILLA_PKIX)_[A-Z0-9_]+|deniedPortAccess/.test(m)) throw new Error(`page.goto: ${netErrorText(m)} at ${target}`);
      throw rewriteError(e as Error, 'page.goto');
    }
    if (sameDocument || !res.navigation) return undefined;
    return res.navigation;
  }

  protected override navigationError(loaderId: string, api: string, url: string | undefined): Error | undefined {
    if (this.downloadNavigations.has(loaderId)) return new Error(`${api}: Download is starting`);
    const text = this.failedNavigations.get(loaderId);
    if (text === undefined) return undefined;
    return new Error(`${api}: ${text} at ${url ?? this.url()}`);
  }
}
