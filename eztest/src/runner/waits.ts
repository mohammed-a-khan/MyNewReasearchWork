/**
 * Explicit waits beyond EZTest's implicit auto-wait: load states, URL
 * patterns, element states (enabled, stable, detached, ...), text changes,
 * browser requests and responses (with capture), DOM events, and a custom
 * poll of any condition or expression with timeout and interval.
 */
import type { Locator, Page } from '../browser/index.js';
import { EzTestError, NotSupportedError, asText, evaluateExpression, sleep, truthy, type Condition, type ElementState, type Step } from '../core/index.js';
import type { ActionOutcome } from './actions.js';
import { evaluateConditionOnce } from './conditions.js';
import { maskDeep } from './dom.js';
import { innerTextOf, listenElement, listenGlobal, readEvents } from './inpage.js';
import { urlMatches } from './pages.js';
import { envFor } from './step.js';
import type { RequestRecord } from './session.js';
import type { RunOptions, StepContext } from './types.js';

let listenerSeq = 0;

// ------------------------------------------------------------------ global loader / spinner wait

/** Used by "Wait for loaders to disappear" when neither config nor the journey names any loader. */
export const DEFAULT_LOADER_SELECTORS = ['.spinner', '.loading', '.loader', '[aria-busy="true"]', '[role="progressbar"]'];

/** Steps that never touch the page: no loader check before them. */
export const NO_PAGE_ACTIONS = new Set(['api', 'db', 'set', 'compareData', 'email', 'sms', 'log', 'runJourney', 'group', 'if', 'while', 'forEach', 'repeat', 'try']);

/** In-page check: is any element matching any selector visible? (CSS, or XPath with "xpath=" / "//"). */
const anyVisible = (sels: string[]): boolean => {
  const visible = (el: Element): boolean => {
    const h = el as HTMLElement & { checkVisibility?: (o: object) => boolean };
    if (typeof h.checkVisibility === 'function') return h.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const st = getComputedStyle(h);
    return h.getClientRects().length > 0 && st.visibility !== 'hidden' && st.opacity !== '0';
  };
  for (const raw of sels) {
    const s = raw.trim();
    try {
      if (s.startsWith('xpath=') || s.startsWith('//') || s.startsWith('(')) {
        const r = document.evaluate(s.replace(/^xpath=/, ''), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (let i = 0; i < r.snapshotLength; i++) {
          const n = r.snapshotItem(i);
          if (n instanceof Element && visible(n)) return true;
        }
      } else {
        for (const el of Array.from(document.querySelectorAll(s.replace(/^css=/, '')))) if (visible(el)) return true;
      }
    } catch {
      /* an invalid selector never blocks */
    }
  }
  return false;
};

export interface LoaderWaitResult {
  /** Time spent waiting (0 when no loader was visible). */
  waitedMs: number;
  /** True when the cap was reached with a loader still visible. */
  capped: boolean;
  checks: number;
}

/**
 * Wait until no loader matching `selectors` is visible, polling every 100 ms, for at
 * most `timeoutMs`. With no selectors it returns at once without touching the page.
 * Reaching the cap is not an error (the step itself then decides); it is reported.
 */
export async function waitForLoaders(page: Page, selectors: readonly string[], timeoutMs = 30_000): Promise<LoaderWaitResult> {
  if (!selectors.length) return { waitedMs: 0, capped: false, checks: 0 };
  const t0 = Date.now();
  const list = [...selectors];
  let checks = 0;
  for (;;) {
    checks++;
    const busy = await page.evaluate(anyVisible, list).catch(() => true); // navigating: look again
    if (!busy) return { waitedMs: checks === 1 ? 0 : Date.now() - t0, capped: false, checks };
    if (Date.now() - t0 >= timeoutMs) return { waitedMs: Date.now() - t0, capped: true, checks };
    await sleep(100);
  }
}

/** Loader selectors in force for a step: config waits.loaders plus the journey's Loaders: header. */
export function loaderSelectorsFor(ctx: StepContext, opts: RunOptions): string[] {
  const fromJourney = ctx.journey.loaders ?? [];
  const fromConfig = opts.loaders?.selectors ?? [];
  if (!fromJourney.length) return fromConfig;
  if (!fromConfig.length) return fromJourney;
  return [...new Set([...fromConfig, ...fromJourney])];
}

/** The automatic wait before an action or a post-condition check (no-op without loaders). */
export async function settleLoaders(step: Step, ctx: StepContext, opts: RunOptions): Promise<void> {
  if (!opts.loaders?.selectors.length && !ctx.journey.loaders?.length) return;
  if (NO_PAGE_ACTIONS.has(step.action) || (step.action === 'wait' && step.args?.for === 'loaders')) return;
  const r = await waitForLoaders(ctx.page, loaderSelectorsFor(ctx, opts), opts.loaders?.timeoutMs ?? 30_000);
  if (r.capped) ctx.logger.warn('loader still visible after the cap; continuing', { stepId: step.id, waitedMs: r.waitedMs });
}

/** Poll `check` until it returns a value (not undefined) or time runs out. */
async function until<T>(check: () => Promise<T | undefined>, timeoutMs: number, intervalMs: number, what: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) throw new EzTestError(`Timed out after ${timeoutMs} ms waiting for ${what()}`, 'WAIT_TIMEOUT');
    await sleep(Math.min(intervalMs, Math.max(10, deadline - Date.now())));
  }
}

/** Install (once) an in-page listener for an event type on a target or window/document; returns its id. */
export async function ensureListener(step: Step, loc: Locator | undefined, ctx: StepContext, type: string, timeout: number): Promise<string> {
  const session = ctx.session;
  const on = String(step.args?.on ?? 'window');
  const key = `${ctx.page.url()}|${type}|${step.target?.description ?? on}`;
  const hit = session?.eventListeners.get(key);
  if (hit) return hit;
  const id = `ez${++listenerSeq}`;
  if (loc) await loc.evaluate(listenElement, { type, id }, { timeout });
  else await ctx.page.evaluate(listenGlobal, { type, id, on });
  session?.eventListeners.set(key, id);
  return id;
}

async function responseRecord(r: RequestRecord, mask: (s: string) => string): Promise<Record<string, unknown>> {
  let body: unknown;
  if (r.response) {
    const text = await r.response.text().catch(() => '');
    try {
      body = /json/.test(r.responseHeaders?.['content-type'] ?? '') && text ? JSON.parse(text) : text;
    } catch {
      body = text;
    }
  }
  return maskDeep({ url: r.url, method: r.method, status: r.status, headers: r.responseHeaders ?? {}, body, durationMs: r.durationMs, requestBody: r.postData }, mask) as Record<string, unknown>;
}

export async function waitAction(step: Step, loc: Locator | undefined, ctx: StepContext, opts: RunOptions, timeout: number): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const kind = String(a.for);
  const page = ctx.page;
  const interval = a.intervalMs === undefined ? 200 : Number(a.intervalMs);
  const within = a.timeoutMs === undefined ? timeout : Number(a.timeoutMs);
  const I = (v: unknown) => ctx.interpolate(String(v));
  switch (kind) {
    case 'load': {
      const state = String(a.state ?? 'load') as 'load' | 'domcontentloaded' | 'networkidle';
      await page.waitForLoadState(state, { timeout: within });
      return {};
    }
    case 'url': {
      const pattern = I(a.url);
      await page.waitForURL((u) => urlMatches(u.toString(), pattern), { timeout: within, waitUntil: 'commit' });
      return {};
    }
    case 'state': {
      if (!step.target) throw new EzTestError('wait for state needs a target', 'MISSING_TARGET');
      const state = String(a.state) as ElementState;
      if (state === 'attached' || state === 'detached' || state === 'visible' || state === 'hidden') {
        if (loc) {
          await loc.waitFor({ state, timeout: within });
          return {};
        }
      }
      const cond: Condition = { type: 'state', target: step.target, state };
      let last = '';
      await until(async () => {
        const r = await evaluateConditionOnce(cond, envFor(ctx, opts)).catch((e: Error) => ({ passed: false, message: e.message }));
        last = r.message ?? '';
        return r.passed ? true : undefined;
      }, within, interval, () => `${step.target!.description} to be ${state}${last ? ` (${last})` : ''}`);
      return {};
    }
    case 'textChange': {
      if (!loc) throw new EzTestError('wait for text change needs a target', 'MISSING_TARGET');
      const from = a.from !== undefined ? I(a.from) : await loc.evaluate(innerTextOf, undefined, { timeout });
      const to = await until(async () => {
        const t = await loc.evaluate(innerTextOf, undefined, { timeout: 2000 }).catch(() => from);
        return t !== from ? t : undefined;
      }, within, interval, () => `the text of ${step.target?.description ?? 'the element'} to change from "${from}"`);
      if (step.captureAs) {
        ctx.ledger.set(step.captureAs, to);
        return { captured: { [step.captureAs]: to } };
      }
      return {};
    }
    case 'request':
    case 'response': {
      const session = ctx.session;
      if (!session) throw new EzTestError('waiting for network needs a browser session', 'NO_SESSION');
      const url = I(a.url);
      const method = a.method ? String(a.method).toUpperCase() : undefined;
      const status = a.status === undefined ? undefined : Number(a.status);
      const rec = await until(async () => session.requests.find((r) =>
        !r.consumed && urlMatches(r.url, url) && (!method || r.method === method) &&
        (kind === 'request' || (r.status !== undefined && (status === undefined || r.status === status)))), within, 50,
      () => `a ${kind} ${method ?? ''} ${url}${status ? ` with status ${status}` : ''}`);
      rec.consumed = true;
      if (kind === 'response' && rec.response) await rec.response.finished().catch(() => undefined);
      if (step.captureAs) {
        const v = kind === 'response' ? await responseRecord(rec, session.mask) : maskDeep({ url: rec.url, method: rec.method, headers: rec.headers, body: rec.postData }, session.mask);
        ctx.ledger.set(step.captureAs, v);
        return { captured: { [step.captureAs]: v } };
      }
      return {};
    }
    case 'event': {
      const type = I(a.event);
      const id = await ensureListener(step, loc, ctx, type, timeout);
      const seen = Number(a.after ?? 0);
      const ev = await until(async () => {
        const list = await page.evaluate(readEvents, id).catch(() => []);
        return list.length > seen ? list[list.length - 1] : undefined;
      }, within, 50, () => `the "${type}" event${step.target ? ` on ${step.target.description}` : ''}`);
      if (step.captureAs) {
        ctx.ledger.set(step.captureAs, ev.detail ?? ev.type);
        return { captured: { [step.captureAs]: ev.detail ?? ev.type } };
      }
      return {};
    }
    case 'listen': {
      await ensureListener(step, loc, ctx, I(a.event), timeout);
      return {};
    }
    case 'loaders': {
      const given = Array.isArray(a.selectors) ? (a.selectors as unknown[]).map((x) => I(x)) : [];
      const sels = given.length ? given : loaderSelectorsFor(ctx, opts);
      const r = await waitForLoaders(page, sels.length ? sels : DEFAULT_LOADER_SELECTORS, a.timeoutMs === undefined ? (opts.loaders?.timeoutMs ?? timeout) : within);
      if (r.capped) throw new EzTestError(`Timed out after ${r.waitedMs} ms waiting for loaders to disappear (${(sels.length ? sels : DEFAULT_LOADER_SELECTORS).join(', ')})`, 'WAIT_TIMEOUT');
      return {};
    }
    case 'condition': {
      const cond = a.condition as Condition | undefined;
      const expr = a.expr === undefined ? undefined : String(a.expr);
      if (!cond && !expr) throw new EzTestError('wait until needs a condition or an expression', 'MISSING_VALUE');
      let last = '';
      await until(async () => {
        if (expr) {
          try {
            const v = evaluateExpression(expr, ctx.vars());
            last = asText(v);
            return truthy(v) ? true : undefined;
          } catch (e) {
            last = (e as Error).message;
            return undefined;
          }
        }
        const r = await evaluateConditionOnce(cond!, envFor(ctx, opts)).catch((e: Error) => ({ passed: false, message: e.message }));
        last = r.message ?? '';
        return r.passed ? true : undefined;
      }, within, interval, () => `${expr ?? cond!.type}${last ? ` (last: ${last})` : ''}`);
      return {};
    }
    default:
      throw new NotSupportedError(`wait for "${kind}"`);
  }
}
