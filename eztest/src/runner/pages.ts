/**
 * The page registry: every tab, window and popup a journey's browser context
 * opens, which one is current, and the current frame chain inside it.
 *
 * `StepContext.page` is always the *current* page, so screenshots, evidence,
 * post-conditions and healing follow tab switches automatically.
 */
import type { BrowserContext, Page } from '../browser/index.js';
import { EzTestError, sleep } from '../core/index.js';
import { rootFor, type LocatorRoot } from './locate.js';

export interface PageEntry {
  page: Page;
  /** 1-based number in opening order ("tab 2"); stable while the page is open. */
  number: number;
  /** Optional name given by "Open a new tab with /x as reports". */
  name?: string;
  /** Frame selector chain the journey has switched into on this page. */
  frames: string[];
  /** Whether the journey has switched to this page at least once. */
  visited: boolean;
}

export type PageSelector =
  | { by: 'new' }
  | { by: 'main' }
  | { by: 'previous' }
  | { by: 'index'; index: number }
  | { by: 'title'; value: string }
  | { by: 'url'; value: string }
  | { by: 'name'; value: string };

/** URL pattern match: /regex/, a glob with *, or a substring. */
export function urlMatches(url: string, pattern: string): boolean {
  const re = /^\/(.+)\/([gimsuy]*)$/.exec(pattern);
  if (re) return new RegExp(re[1], re[2]).test(url);
  if (pattern.includes('*')) {
    const rx = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
    let path = url;
    let pathAndQuery = url;
    try {
      const u = new URL(url);
      path = u.pathname;
      pathAndQuery = u.pathname + u.search;
    } catch {
      /* not an absolute URL */
    }
    return rx.test(url) || rx.test(pathAndQuery) || rx.test(path);
  }
  return url.includes(pattern);
}

export class PageRegistry {
  readonly entries: PageEntry[] = [];
  private current: PageEntry;
  private readonly history: PageEntry[] = [];
  private counter = 0;
  private waiters: Array<(e: PageEntry) => void> = [];

  constructor(
    readonly context: BrowserContext,
    first: Page,
    private readonly onNewPage: (page: Page) => void = () => undefined,
  ) {
    this.current = this.add(first);
    this.current.visited = true;
    context.on('page', (p) => {
      if (this.entries.some((e) => e.page === p)) return;
      const entry = this.add(p);
      this.onNewPage(p);
      for (const w of this.waiters.splice(0)) w(entry);
    });
  }

  private add(page: Page): PageEntry {
    const entry: PageEntry = { page, number: ++this.counter, frames: [], visited: false };
    this.entries.push(entry);
    page.on('close', () => this.removed(entry));
    return entry;
  }

  private removed(entry: PageEntry): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
    for (let h = this.history.length - 1; h >= 0; h--) if (this.history[h] === entry) this.history.splice(h, 1);
    if (this.current === entry && this.entries.length) {
      this.current = this.history.pop() ?? this.entries[0];
    }
  }

  /** The current page. */
  get page(): Page {
    return this.current.page;
  }

  get currentEntry(): PageEntry {
    return this.current;
  }

  /** Frame chain of the current page. */
  get frames(): string[] {
    return this.current.frames;
  }

  set frames(chain: string[]) {
    this.current.frames = chain;
  }

  /** Open pages, in opening order. */
  get open(): PageEntry[] {
    return this.entries.filter((e) => !e.page.isClosed());
  }

  /** Make an entry current (remembering the previous one). */
  activate(entry: PageEntry): void {
    if (entry === this.current) return;
    this.history.push(this.current);
    this.current = entry;
    entry.visited = true;
  }

  /** Resolve once a page newer than all current ones opens (or one opened unvisited already exists). */
  waitForNewPage(timeoutMs: number, since?: number): Promise<PageEntry> {
    const existing = this.entries.find((e) => !e.visited && (since === undefined || e.number > since));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new EzTestError(`No new tab, window or popup opened within ${timeoutMs} ms`, 'NO_NEW_PAGE'));
      }, timeoutMs);
      const done = (e: PageEntry) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push(done);
    });
  }

  /** Highest page number so far (to wait for pages opened after this point). */
  get lastNumber(): number {
    return this.counter;
  }

  /** Find a page by selector, polling until `timeoutMs` (titles and URLs may still be loading). */
  async find(sel: PageSelector, timeoutMs: number): Promise<PageEntry> {
    if (sel.by === 'new') {
      const e = await this.waitForNewPage(timeoutMs);
      await e.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined);
      return e;
    }
    if (sel.by === 'main') {
      const e = this.open[0];
      if (!e) throw new EzTestError('No open page', 'NO_PAGE');
      return e;
    }
    if (sel.by === 'previous') {
      const prev = [...this.history].reverse().find((e) => !e.page.isClosed());
      if (!prev) throw new EzTestError('There is no previous tab or window to switch back to', 'NO_PAGE');
      return prev;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const open = this.open;
      let hits: PageEntry[] = [];
      if (sel.by === 'index') hits = open[sel.index - 1] ? [open[sel.index - 1]] : [];
      else if (sel.by === 'name') hits = open.filter((e) => e.name === sel.value);
      else if (sel.by === 'url') hits = open.filter((e) => urlMatches(e.page.url(), sel.value));
      else if (sel.by === 'title') {
        const titles = await Promise.all(open.map((e) => e.page.title().catch(() => '')));
        hits = open.filter((_, i) => titles[i].includes(sel.value));
        if (!hits.length) hits = open.filter((e) => e.name === sel.value);
      }
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new EzTestError(`${hits.length} tabs match ${describeSelector(sel)}; be more specific (e.g. by URL or number)`, 'AMBIGUOUS_PAGE');
      }
      if (Date.now() >= deadline) {
        const list = await Promise.all(open.map(async (e) => `#${open.indexOf(e) + 1} "${await e.page.title().catch(() => '')}" ${e.page.url()}`));
        throw new EzTestError(`No tab or window matches ${describeSelector(sel)}. Open: ${list.join('; ')}`, 'NO_PAGE');
      }
      await sleep(100);
    }
  }

  /** A locator root for the current page and frame chain plus extra frames. */
  root(extraFrames?: string[]): LocatorRoot {
    return rootFor(this.page, [...this.frames, ...(extraFrames ?? [])]);
  }
}

export function describeSelector(sel: PageSelector): string {
  switch (sel.by) {
    case 'new': return 'the newly opened tab';
    case 'main': return 'the main tab';
    case 'previous': return 'the previous tab';
    case 'index': return `tab ${sel.index}`;
    case 'title': return `title "${sel.value}"`;
    case 'url': return `URL "${sel.value}"`;
    case 'name': return `name "${sel.value}"`;
  }
}

/** Candidate CSS selectors for a frame description: name, id, title, aria-label, then src (in that order). */
export function frameSelectorCandidates(description: string): string[] {
  const d = description.trim();
  const css = /^css\s*=\s*(.+)$/i.exec(d);
  if (css) return [css[1].trim()];
  if (/^(?:[#.[]|i?frame\b)/i.test(d)) return [d];
  const v = d.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    `iframe[name="${v}"]`, `frame[name="${v}"]`, `iframe[id="${v}"]`, `frame[id="${v}"]`,
    `iframe[title="${v}"]`, `iframe[aria-label="${v}"]`, `iframe[src*="${v}"]`, `frame[src*="${v}"]`,
  ];
}

/**
 * Resolve a frame description into the one selector that matches exactly one
 * frame element under `root`, polling until `timeoutMs` (frames load late).
 */
export async function resolveFrameSelector(root: LocatorRoot, description: string, timeoutMs: number): Promise<string> {
  const cands = frameSelectorCandidates(description);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const notes: string[] = [];
    for (const c of cands) {
      const n = await root.locator(c).count().catch(() => 0);
      if (n === 1) return c;
      if (n > 1) notes.push(`${c}: ${n} frames`);
    }
    if (Date.now() >= deadline) {
      throw new EzTestError(
        `No frame "${description}" found (tried name, id, title, aria-label and src${notes.length ? `; ambiguous: ${notes.join(', ')}` : ''})`,
        'NO_FRAME',
      );
    }
    await sleep(100);
  }
}
