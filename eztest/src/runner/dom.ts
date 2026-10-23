/**
 * Declarative DOM queries captured into the ledger (no eval): text, value,
 * attribute, property, computed CSS, bounding box, HTML, element state,
 * count, list of texts, and a table as header-mapped records; plus page
 * facts (URL, title) and recorded events (console, requests, dialogs).
 *
 * CSS and role/text locators pierce open shadow DOM, so queries reach inside
 * web components without special syntax (XPath does not pierce shadow roots).
 */
import type { Locator } from '../browser/index.js';
import { EzTestError, NotSupportedError, type Step } from '../core/index.js';
import { allMatches, regex } from './conditions-advanced.js';
import { envFor } from './step.js';
import { evaluateConditionOnce } from './conditions.js';
import { computedCss, innerTextOf, outerHtml, readProperty, tableRows } from './inpage.js';
import { urlMatches } from './pages.js';
import type { StepContext } from './types.js';

/** Query kinds that need exactly one element (strictly resolved, healable). */
export const SINGLE_ELEMENT_QUERIES = new Set(['text', 'value', 'attribute', 'property', 'css', 'box', 'html', 'state', 'table']);

/** Deep-mask strings in a captured value. */
export function maskDeep(v: unknown, mask: (s: string) => string): unknown {
  if (typeof v === 'string') return mask(v);
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, mask));
  // Only plain records are rebuilt; Dates, buffers and other class instances are kept as they are.
  if (v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, mask)]));
  }
  return v;
}

export async function queryAction(step: Step, loc: Locator | undefined, ctx: StepContext, timeout: number): Promise<Record<string, unknown>> {
  const a = step.args ?? {};
  const what = String(a.what ?? 'text');
  const name = a.name === undefined ? undefined : ctx.interpolate(String(a.name));
  const key = step.captureAs;
  if (!key) throw new EzTestError(`Step "${step.intent}" needs captureAs`, 'MISSING_CAPTURE_KEY');
  const need = (): Locator => {
    if (!loc) throw new EzTestError(`query ${what} needs a target`, 'MISSING_TARGET');
    return loc;
  };
  let v: unknown;
  switch (what) {
    case 'text': v = await need().evaluate(innerTextOf, undefined, { timeout }); break;
    case 'value': v = await need().inputValue({ timeout }); break;
    case 'attribute': v = await need().getAttribute(name ?? '', { timeout }); break;
    case 'property': v = await need().evaluate(readProperty, name ?? '', { timeout }); break;
    case 'css': v = await need().evaluate(computedCss, name ?? '', { timeout }); break;
    case 'box': {
      const b = await need().boundingBox({ timeout });
      v = b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
      break;
    }
    case 'html': v = a.outer ? await need().evaluate(outerHtml, undefined, { timeout }) : await need().innerHTML({ timeout }); break;
    case 'state': {
      const r = await evaluateConditionOnce({ type: 'state', target: step.target!, state: (name ?? 'visible') as never }, envFor(ctx));
      v = r.passed;
      break;
    }
    case 'table': v = await need().evaluate(tableRows, undefined, { timeout }); break;
    case 'count':
    case 'texts': {
      if (!step.target) throw new EzTestError(`query ${what} needs a target`, 'MISSING_TARGET');
      const m = await allMatches(envFor(ctx), step.target);
      v = what === 'count' ? m.count : m.locator ? (await m.locator.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()) : [];
      break;
    }
    case 'url': v = ctx.page.url(); break;
    case 'title': v = await ctx.page.title(); break;
    case 'console': {
      const s = ctx.session;
      const level = String(a.level ?? 'any');
      v = (s?.console ?? []).filter((m) => level === 'any' || m.type === level || (level === 'error' && m.type === 'pageerror')).map((m) => ({ type: m.type, text: m.text }));
      break;
    }
    case 'requests': {
      const pattern = name ?? '';
      v = (ctx.session?.requests ?? []).filter((r) => !pattern || urlMatches(r.url, pattern))
        .map((r) => ({ method: r.method, url: r.url, status: r.status, headers: r.headers, body: r.postData }));
      break;
    }
    case 'dialog': {
      const recs = ctx.session?.dialogs.records ?? [];
      const last = recs[recs.length - 1];
      if (!last) throw new EzTestError('no dialog has appeared', 'NO_DIALOG');
      v = last.message;
      break;
    }
    default: throw new NotSupportedError(`query "${what}"`);
  }
  if (typeof v === 'string' && a.pattern !== undefined) {
    const m = regex(ctx.interpolate(String(a.pattern))).exec(v);
    if (!m) throw new EzTestError(`"${v}" does not match ${String(a.pattern)}`, 'NO_MATCH');
    v = m[1] ?? m[0];
  }
  const masked = maskDeep(v, ctx.session?.mask ?? ((s) => s));
  ctx.ledger.set(key, masked);
  return { [key]: masked };
}
