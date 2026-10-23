/**
 * NativeContext: one device session as the executor sees it. It tracks the
 * current context (the native app, or an attached web view), caches the page
 * source per step, resolves targets strictly (exactly one element) and reads
 * element facts (text, value, checked state, bounds) the same way on every
 * platform.
 */
import { interpolate, sleep, type LocatorCandidate, type Target } from '../core/index.js';
import { describeFinder, findersFor, type Finder } from './locators.js';
import { idOf, nodesAt, parseSource, textOf, type NativeNode, type NativePlatform, type PageSource } from './source.js';
import { DeviceError, type DeviceSession, type ElementBackend, type Gesture, type Rect, type WebViewSession } from './session.js';

export interface TriedFinder {
  candidate: LocatorCandidate;
  finder: Finder;
  /** Match count; -1 when the finder was rejected (invalid or unsupported strategy). */
  count: number;
  error?: string;
}

export interface NativeResolution {
  element?: string;
  candidate?: LocatorCandidate;
  finder?: Finder;
  notes: string[];
  tried: TriedFinder[];
  ambiguous: boolean;
}

export interface GestureLogEntry {
  stepId?: string;
  op: string;
  gesture: Gesture;
  at: string;
}

export const NATIVE_CONTEXT = 'NATIVE_APP';

/** A web view context: web locators apply. */
export function isWebContext(context: string): boolean {
  return context !== NATIVE_CONTEXT;
}

export class NativeContext {
  /** Current context: NATIVE_APP or the name of the attached web view. */
  context = NATIVE_CONTEXT;
  /** The attached web view (when the context is not native). */
  web?: WebViewSession;
  /** Gestures sent, for evidence. */
  readonly gestures: GestureLogEntry[] = [];
  /** Dialog plan armed by "Accept the next dialog" (applied after the next action that raises an alert). */
  armedDialog?: { accept: boolean; text?: string };
  currentStep?: string;
  /** Strategies the backend rejected as unsupported (skipped from then on, per context kind). */
  readonly unsupportedStrategies = new Set<string>();
  private sourceCache?: { at: number; src: PageSource; xml: string; context: string };
  private windowCache?: Rect;

  constructor(
    readonly device: DeviceSession,
    /** App under test (package / bundle id), for app lifecycle steps. */
    public appId: string | undefined,
  ) {}

  get platform(): NativePlatform {
    return this.device.platform;
  }

  /** Element operations of the current context. */
  get ui(): ElementBackend {
    return this.web ?? this.device;
  }

  invalidate(window = false): void {
    this.sourceCache = undefined;
    if (window) this.windowCache = undefined;
  }

  /** Switch to an attached web view, or back to the native app (undefined). */
  async setWebView(web: WebViewSession | undefined): Promise<void> {
    if (this.web && this.web !== web) await this.web.close().catch(() => undefined);
    this.web = web;
    this.context = web ? web.name : NATIVE_CONTEXT;
    this.invalidate();
  }

  /** Page source of the current context, cached for a short time within a step. */
  async source(maxAgeMs = 250): Promise<{ src: PageSource; xml: string }> {
    const c = this.sourceCache;
    if (c && c.context === this.context && Date.now() - c.at <= maxAgeMs) return c;
    const xml = await this.ui.source();
    this.sourceCache = { at: Date.now(), src: parseSource(xml), xml, context: this.context };
    return this.sourceCache;
  }

  /** Native screen source (whatever the current context). */
  async nativeSource(): Promise<{ src: PageSource; xml: string }> {
    if (!this.web) return this.source(0);
    const xml = await this.device.source();
    return { src: parseSource(xml), xml };
  }

  async window(): Promise<Rect> {
    this.windowCache ??= await this.device.window();
    return this.windowCache;
  }

  async perform(op: string, gesture: Gesture): Promise<void> {
    this.gestures.push({ stepId: this.currentStep, op, gesture, at: new Date().toISOString() });
    await this.device.gesture(gesture);
    this.invalidate();
  }

  private strategyKey(f: Finder): string {
    return `${this.web ? 'web' : 'native'}:${f.using}`;
  }

  /** Count matches of one finder; an error when the strategy is rejected. */
  async count(f: Finder): Promise<{ ids: string[]; error?: string }> {
    if (this.unsupportedStrategies.has(this.strategyKey(f))) return { ids: [], error: `strategy "${f.using}" is not supported here` };
    try {
      return { ids: await this.ui.findElements(f.using, f.value) };
    } catch (e) {
      if (e instanceof DeviceError && e.code === 'no such element') return { ids: [] };
      if (e instanceof DeviceError && e.code === 'connection failed') throw e;
      if (e instanceof DeviceError && e.unsupported) this.unsupportedStrategies.add(this.strategyKey(f));
      return { ids: [], error: (e as Error).message.split('\n')[0] };
    }
  }

  /** Try one candidate's finders once: the first finder matching exactly one element wins. */
  async tryCandidate(c: LocatorCandidate, out: NativeResolution): Promise<boolean> {
    const finders = findersFor(c, this.platform, this.context);
    if (!finders.length) {
      out.notes.push(`${c.strategy}=${JSON.stringify(c.value)}: cannot be used in ${this.context}`);
      return false;
    }
    for (const f of finders) {
      const r = await this.count(f);
      out.tried.push({ candidate: c, finder: f, count: r.error ? -1 : r.ids.length, ...(r.error ? { error: r.error } : {}) });
      if (r.error) {
        out.notes.push(`${describeFinder(f)}: rejected (${r.error})`);
        continue;
      }
      if (r.ids.length === 1) {
        out.element = r.ids[0];
        out.candidate = c;
        out.finder = f;
        return true;
      }
      if (r.ids.length > 1) {
        out.ambiguous = true;
        out.notes.push(`${describeFinder(f)}: ${r.ids.length} matches (ambiguous, skipped)`);
      } else out.notes.push(`${describeFinder(f)}: no match`);
    }
    return false;
  }

  /** Strict resolution with polling (elements may still be appearing). */
  async resolve(target: Target, vars: Record<string, unknown>, timeoutMs: number): Promise<NativeResolution> {
    const deadline = Date.now() + timeoutMs;
    if (!target.locators.length) return { notes: ['target has no locator candidates'], tried: [], ambiguous: false };
    for (;;) {
      const out: NativeResolution = { notes: [], tried: [], ambiguous: false };
      for (const raw of target.locators) {
        if (await this.tryCandidate(interpolateCandidate(raw, vars), out)) return out;
      }
      if (Date.now() >= deadline) return out;
      await sleep(Math.min(300, Math.max(20, deadline - Date.now())));
    }
  }

  /** All matches of a target's first candidate that matches anything (counts and "hidden"). */
  async matches(target: Target, vars: Record<string, unknown>): Promise<string[]> {
    for (const raw of target.locators) {
      for (const f of findersFor(interpolateCandidate(raw, vars), this.platform, this.context)) {
        const r = await this.count(f);
        if (r.ids.length) return r.ids;
      }
    }
    return [];
  }

  /** The source node of a found element (matched by bounds; unique match only). Native context only. */
  async nodeOf(element: string): Promise<NativeNode | undefined> {
    if (this.web) return undefined;
    const rect = await this.ui.rect(element).catch(() => undefined);
    if (!rect) return undefined;
    const { src } = await this.source(1000);
    const at = nodesAt(src, rect);
    if (at.length === 1) return at[0];
    // Several nodes share the box (wrappers): prefer the innermost.
    const leaves = at.filter((n) => !n.children.some((ch) => at.includes(ch)));
    return leaves.length === 1 ? leaves[0] : undefined;
  }

  /** Visible text: the agent's text, else the node's text/label/value. */
  async textOf(element: string): Promise<string> {
    const t = await this.ui.text(element).catch(() => '');
    if (t) return t;
    const n = await this.nodeOf(element);
    return (n && textOf(n)) ?? '';
  }

  /** The value of an input (text for Android EditText, value for iOS). */
  async valueOf(element: string): Promise<string> {
    if (this.platform === 'ios' && !this.web) {
      const v = await this.ui.attribute(element, 'value').catch(() => null);
      if (v !== null) return v;
    }
    return this.ui.text(element).catch(() => '');
  }

  /** Checked state: Android `checked`, iOS switch `value` 1/0, else `selected`. */
  async checkedOf(element: string): Promise<boolean> {
    const checked = await this.ui.attribute(element, 'checked').catch(() => null);
    if (checked === 'true' || checked === 'false') return checked === 'true';
    if (this.platform === 'ios') {
      const v = await this.ui.attribute(element, 'value').catch(() => null);
      if (v === '1' || v === '0') return v === '1';
    }
    return this.ui.selected(element).catch(() => false);
  }

  static idAttr(n: NativeNode): string | undefined {
    return idOf(n);
  }
}

export function interpolateCandidate(c: LocatorCandidate, vars: Record<string, unknown>): LocatorCandidate {
  return { ...c, value: interpolate(c.value, vars), ...(c.name !== undefined ? { name: interpolate(c.name, vars) } : {}) };
}
