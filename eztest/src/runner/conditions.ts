/**
 * Post-condition evaluation. Conditions are declarative; each is evaluated
 * against the page and the ledger, polling until all hold or time runs out.
 * Targets in conditions use the same strict (exactly-one) resolution as actions.
 */
import { existsSync, statSync } from 'node:fs';
import type { Locator, Page } from '../browser/index.js';
import { sleep, type Condition, type ConditionResult, type Target } from '../core/index.js';
import type { Ledger } from './ledger.js';
import { describeCandidate, rootFor, targetLocators } from './locate.js';
import { evaluateAdvancedCondition, framesOf } from './conditions-advanced.js';
import type { BrowserSession } from './session.js';
import { activeSurface } from './surface.js';
import { dismissInterstitials } from './reliability/interstitials.js';
import { AdaptiveDeadline, type Extension, type Probeable } from './reliability/load.js';

/**
 * The visible text of an element as the page wrote it: CSS text-transform (uppercase headings, capitalised
 * buttons) does not apply, so a check written with the words in the HTML holds as well as one written with the
 * words on screen. Hidden text still does not count.
 */
export async function writtenText(loc: Locator): Promise<string> {
  return loc
    .evaluate((root) => {
      let out = '';
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement;
        if (!p || /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
        const shown = typeof p.checkVisibility === 'function' ? p.checkVisibility({ visibilityProperty: true }) : p.getClientRects().length > 0;
        if (shown) out += n.nodeValue ?? '';
      }
      return out;
    })
    .catch(() => '');
}

export interface ConditionEnv {
  page: Page;
  ledger: Ledger;
  vars: () => Record<string, unknown>;
  interpolate: (s: string) => string;
  /** Tabs, dialogs and recorded events (advanced conditions). */
  session?: BrowserSession;
  /** Current frame chain targets are resolved in. */
  frames?: string[];
  /** Directory relative files (e.g. JSON Schemas) resolve against. */
  baseDir?: string;
  /** The configured API spec for "conforms to the API spec" (RunOptions.apiSpec). */
  apiSpec?: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

async function uniqueLocator(env: ConditionEnv, target: Target) {
  const root = rootFor(env.page, framesOf(env, target));
  const notes: string[] = [];
  if (!target.locators.length) return { notes: [target.element ? `element @${target.element} is not in the element repository` : 'target has no locator candidates'] };
  const t = await targetLocators(root, target, env.vars());
  if (t.error) return { notes: [t.error] };
  for (const { candidate: c, locator: loc } of t.locators) {
    const n = await loc.count();
    if (n === 1) return { locator: loc, notes };
    notes.push(n === 0 ? `${describeCandidate(c)}: no match` : `${describeCandidate(c)}: ${n} matches (ambiguous)`);
  }
  return { notes };
}

function fail(condition: Condition, message: string, actual?: string): ConditionResult {
  return { condition, passed: false, message, ...(actual !== undefined ? { actual } : {}) };
}
function ok(condition: Condition, actual?: string): ConditionResult {
  return { condition, passed: true, ...(actual !== undefined ? { actual } : {}) };
}
/** A dotted path ("order.lines.0.sku") into a variables record. */
function pathIn(vars: Record<string, unknown>, key: string): unknown {
  let cur: unknown = vars;
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const NUMERIC = /^\s*-?\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*$/i;
/** Equal as text, or as numbers when both sides are numbers or numeric text ("2450.7" equals 2450.70). */
function sameValue(a: unknown, b: unknown): boolean {
  if (show(a) === show(b)) return true;
  const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && NUMERIC.test(x) ? Number(x) : undefined);
  const x = num(a);
  const y = num(b);
  return x !== undefined && y !== undefined && Number.isFinite(x) && Math.abs(x - y) < 1e-9;
}

function show(v: unknown): string {
  if (v === undefined) return 'undefined';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Evaluate one condition once (no polling). */
export async function evaluateConditionOnce(c: Condition, env: ConditionEnv): Promise<ConditionResult> {
  // An active desktop/terminal/SAP/screen surface answers the conditions it understands (runner/surface.ts).
  const surface = activeSurface(env.session);
  if (surface) {
    const r = await surface.evaluate(c, env);
    if (r) return r;
  }
  const I = env.interpolate;
  const { page, ledger } = env;
  switch (c.type) {
    case 'urlContains': {
      const url = page.url();
      const v = I(c.value);
      return url.includes(v) ? ok(c, url) : fail(c, `URL does not contain "${v}"`, url);
    }
    case 'urlMatches': {
      const url = page.url();
      const re = new RegExp(I(c.pattern));
      return re.test(url) ? ok(c, url) : fail(c, `URL does not match /${re.source}/`, url);
    }
    case 'titleContains': {
      const t = await page.title();
      const v = I(c.value);
      return t.includes(v) ? ok(c, t) : fail(c, `title does not contain "${v}"`, t);
    }
    case 'pageContainsText':
    case 'pageNotContainsText': {
      // Inside a frame block (In the "payment" frame ... End) the page is the current frame.
      const bodyLoc = rootFor(page, env.frames).locator('body');
      const body = norm(await bodyLoc.innerText({ timeout: 2000 }).catch(() => ''));
      const v = norm(I(c.value));
      if (!v) return fail(c, 'expected text is empty');
      // As shown, or as written when CSS changes its case ("Searched Products" shown as SEARCHED PRODUCTS).
      const has = body.includes(v) || norm(await writtenText(bodyLoc)).includes(v);
      if (c.type === 'pageContainsText') return has ? ok(c) : fail(c, `page does not contain "${v}"`, body.slice(0, 300));
      return has ? fail(c, `page contains "${v}"`) : ok(c);
    }
    case 'visible':
    case 'textContains':
    case 'textEquals':
    case 'valueEquals': {
      const r = await uniqueLocator(env, c.target);
      if (!r.locator) return fail(c, `${c.target.description}: not found exactly once (${r.notes.join('; ')})`);
      if (c.type === 'visible') {
        return (await r.locator.isVisible()) ? ok(c, 'visible') : fail(c, `${c.target.description} is not visible`, 'hidden');
      }
      if (c.type === 'valueEquals') {
        const v = await r.locator.inputValue({ timeout: 2000 });
        const want = I(c.value);
        return v === want ? ok(c, v) : fail(c, `${c.target.description} value is "${v}", expected "${want}"`, v);
      }
      const text = norm(await r.locator.innerText({ timeout: 2000 }));
      const want = norm(I(c.value));
      if (!want && c.type !== 'textEquals') return fail(c, 'expected text is empty');
      const holds = (t: string) => (c.type === 'textEquals' ? t === want : t.includes(want));
      if (holds(text) || holds(norm(await writtenText(r.locator)))) return ok(c, text);
      if (c.type === 'textEquals') return fail(c, `${c.target.description} text is "${text}", expected "${want}"`, text);
      return fail(c, `${c.target.description} text "${text}" does not contain "${want}"`, text);
    }
    case 'hidden': {
      if (!c.target.locators.length) return fail(c, `${c.target.description}: target has no locator candidates`);
      const root = rootFor(page, framesOf(env, c.target));
      // A scoped target whose container or anchor is gone is hidden too.
      const t = await targetLocators(root, c.target, env.vars());
      if (t.error && t.scope?.ambiguous) return fail(c, `${c.target.description}: ${t.error}`);
      for (const { candidate, locator: loc } of t.locators) {
        const n = await loc.count();
        for (let i = 0; i < n; i++) {
          if (await loc.nth(i).isVisible()) return fail(c, `${c.target.description} is visible (${describeCandidate(candidate)})`, 'visible');
        }
      }
      return ok(c, 'hidden');
    }
    case 'count': {
      if (!c.target.locators.length) return fail(c, `${c.target.description}: target has no locator candidates`);
      const root = rootFor(page, framesOf(env, c.target));
      let n = 0;
      const t = await targetLocators(root, c.target, env.vars());
      if (t.error) return fail(c, `${c.target.description}: ${t.error}`);
      for (const { locator } of t.locators) {
        n = await locator.count();
        if (n > 0) break;
      }
      return n === c.equals ? ok(c, String(n)) : fail(c, `${c.target.description}: found ${n}, expected ${c.equals}`, String(n));
    }
    case 'ledgerEquals': {
      // ${a} == ${b}: both sides are looked up like ${...} interpolation (captured values, then journey and run variables).
      const lookup = (k: string) => {
        const hit = ledger.get(k);
        return hit !== undefined ? hit : pathIn(env.vars(), k);
      };
      const v = lookup(c.key);
      if (v === undefined) return fail(c, `no value "${c.key}" (not captured, and no journey or run variable of that name)`);
      let want: unknown;
      if (c.otherKey !== undefined) {
        want = lookup(c.otherKey);
        if (want === undefined) return fail(c, `no value "${c.otherKey}" (not captured, and no journey or run variable of that name)`);
      } else if (c.expected !== undefined) want = I(c.expected);
      else return fail(c, 'ledgerEquals needs expected or otherKey');
      return sameValue(v, want) ? ok(c, show(v)) : fail(c, `${c.key} is "${show(v)}", expected "${show(want)}"`, show(v));
    }
    case 'apiStatus': {
      const r = ledger.get(c.captureKey) as { status?: unknown } | undefined;
      if (!r || typeof r.status !== 'number') return fail(c, `ledger has no API response "${c.captureKey}"`);
      return r.status === c.status ? ok(c, String(r.status)) : fail(c, `status ${r.status}, expected ${c.status}`, String(r.status));
    }
    case 'dbRowCount': {
      const rows = ledger.get(c.captureKey);
      if (!Array.isArray(rows)) return fail(c, `ledger has no query result "${c.captureKey}"`);
      return rows.length === c.equals ? ok(c, String(rows.length)) : fail(c, `${rows.length} rows, expected ${c.equals}`, String(rows.length));
    }
    case 'downloadExists': {
      const d = ledger.get(c.captureKey) as { path?: unknown } | undefined;
      if (!d || typeof d.path !== 'string') return fail(c, `ledger has no download "${c.captureKey}"`);
      if (!existsSync(d.path)) return fail(c, `downloaded file missing: ${d.path}`);
      const size = statSync(d.path).size;
      return size > 0 ? ok(c, `${size} bytes`) : fail(c, 'downloaded file is empty', '0 bytes');
    }
    default:
      return evaluateAdvancedCondition(c, env);
  }
}

/** Evaluate all conditions, polling until every one holds or `timeoutMs` elapses. */
export async function evaluateConditions(conds: Condition[], env: ConditionEnv, timeoutMs: number, onExtend?: (e: Extension) => void): Promise<ConditionResult[]> {
  // Extended in proportion to the load measured while it polls (reliability/load.ts).
  const deadline = new AdaptiveDeadline(timeoutMs, { what: 'post-conditions', ...(env.page ? { probe: env.page as Probeable } : {}), ...(onExtend ? { onExtend } : {}) });
  for (;;) {
    const results: ConditionResult[] = [];
    for (const c of conds) {
      try {
        results.push(await evaluateConditionOnce(c, env));
      } catch (e) {
        results.push(fail(c, `error evaluating ${c.type}: ${(e as Error).message.split('\n')[0]}`));
      }
    }
    if (results.every((r) => r.passed) || (await deadline.reached())) return results;
    // A full-screen ad after a link click holds the navigation back until someone closes it.
    if (env.page && env.session && (await dismissInterstitials(env.page))) continue;
    await sleep(Math.min(150, Math.max(10, deadline.remaining())));
  }
}
