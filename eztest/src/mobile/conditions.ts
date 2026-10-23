/**
 * Post-conditions on native apps. UI conditions are evaluated against the
 * device (strict resolution, element text/state) and the page source (screen
 * text); data conditions (ledger, API, DB, expressions, JSON) reuse the runner's
 * evaluator unchanged. Browser-only conditions fail clearly instead of
 * silently passing.
 */
import { sleep, type Condition, type ConditionResult } from '../core/index.js';
import { compareOp } from '../runner/conditions-advanced.js';
import { evaluateConditionOnce } from '../runner/conditions.js';
import type { Ledger } from '../runner/ledger.js';
import { intersects } from './gestures.js';
import { isWebContext, type NativeContext } from './native.js';
import { screenText } from './source.js';

export interface NativeConditionEnv {
  native: NativeContext;
  ledger: Ledger;
  vars: () => Record<string, unknown>;
  interpolate: (s: string) => string;
  baseDir?: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const fail = (condition: Condition, message: string, actual?: string): ConditionResult => ({ condition, passed: false, message, ...(actual !== undefined ? { actual } : {}) });
const ok = (condition: Condition, actual?: string): ConditionResult => ({ condition, passed: true, ...(actual !== undefined ? { actual } : {}) });

/** A page stand-in for the runner's evaluator: data conditions never touch it; anything that does is a browser-only condition. */
export function noPage(what: string): never {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      throw new Error(`${what} needs a browser page; it is not available on a native app`);
    },
  }) as never;
}

const BROWSER_ONLY = new Set(['css', 'hasClass', 'sorted', 'tabCount', 'console', 'request', 'wsMessage', 'cookie', 'storage']);

/** Evaluate one condition once on the device. */
export async function evaluateNativeConditionOnce(c: Condition, env: NativeConditionEnv): Promise<ConditionResult> {
  const { native } = env;
  const I = env.interpolate;
  const vars = env.vars();
  const strict = async (target: Extract<Condition, { target: unknown }>['target']) => {
    const r = await native.resolve(target, vars, 0);
    return r;
  };
  switch (c.type) {
    case 'pageContainsText':
    case 'pageNotContainsText': {
      const { src } = await native.source(0);
      const text = norm(screenText(src));
      const v = norm(I(c.value));
      if (!v) return fail(c, 'expected text is empty');
      const has = text.includes(v);
      if (c.type === 'pageContainsText') return has ? ok(c) : fail(c, `the screen does not contain "${v}"`, text.slice(0, 300));
      return has ? fail(c, `the screen contains "${v}"`) : ok(c);
    }
    case 'urlContains':
    case 'urlMatches':
    case 'titleContains': {
      if (!isWebContext(native.context) || !native.web) return fail(c, `${c.type} needs a web view or the device browser (current context: ${native.context}); switch to the web view first`);
      const v = c.type === 'titleContains' ? await native.web!.title() : await native.web!.url();
      if (c.type === 'urlMatches') return new RegExp(I(c.pattern)).test(v) ? ok(c, v) : fail(c, `URL does not match /${I(c.pattern)}/`, v);
      const want = I(c.value);
      return v.includes(want) ? ok(c, v) : fail(c, `${c.type === 'titleContains' ? 'title' : 'URL'} does not contain "${want}"`, v);
    }
    case 'visible':
    case 'textContains':
    case 'textEquals':
    case 'valueEquals':
    case 'textMatches':
    case 'attribute':
    case 'state': {
      if (c.type === 'state' && (c.state === 'detached' || c.state === 'hidden')) {
        const ids = await native.matches(c.target, vars);
        if (c.state === 'detached') return ids.length === 0 ? ok(c, 'detached') : fail(c, `${c.target.description} is still present (${ids.length})`, 'attached');
        for (const id of ids) if (await native.ui.displayed(id).catch(() => false)) return fail(c, `${c.target.description} is visible`, 'visible');
        return ok(c, 'hidden');
      }
      const r = await strict(c.target);
      if (!r.element) return fail(c, `${c.target.description}: not found exactly once (${r.notes.join('; ')})`);
      const el = r.element;
      switch (c.type) {
        case 'visible':
          return (await native.ui.displayed(el)) ? ok(c, 'visible') : fail(c, `${c.target.description} is not visible`, 'hidden');
        case 'valueEquals': {
          const v = await native.valueOf(el);
          const want = I(c.value);
          return v === want ? ok(c, v) : fail(c, `${c.target.description} value is "${v}", expected "${want}"`, v);
        }
        case 'textMatches': {
          const v = c.field === 'value' ? await native.valueOf(el) : norm(await native.textOf(el));
          const re = new RegExp(I(c.pattern), c.flags);
          return re.test(v) ? ok(c, v) : fail(c, `${c.target.description} "${v}" does not match /${re.source}/`, v);
        }
        case 'attribute': {
          const v = await native.ui.attribute(el, c.name).catch(() => null);
          const want = c.value !== undefined ? I(c.value) : undefined;
          return compareOp(v, c.op, want) ? ok(c, v ?? 'absent') : fail(c, `${c.target.description} attribute ${c.name} is ${v === null ? 'absent' : `"${v}"`} (${c.op}${want !== undefined ? ` "${want}"` : ''})`, v ?? 'absent');
        }
        case 'state': {
          let actual: boolean;
          switch (c.state) {
            case 'enabled': actual = await native.ui.enabled(el); break;
            case 'disabled': actual = !(await native.ui.enabled(el)); break;
            case 'checked': actual = await native.checkedOf(el); break;
            case 'unchecked': actual = !(await native.checkedOf(el)); break;
            case 'visible': actual = await native.ui.displayed(el); break;
            case 'attached': actual = true; break;
            case 'focused': actual = (await native.ui.attribute(el, 'focused').catch(() => null)) === 'true'; break;
            case 'inViewport':
            case 'notInViewport': {
              const on = intersects(await native.ui.rect(el), await native.window());
              actual = c.state === 'inViewport' ? on : !on;
              break;
            }
            case 'empty': actual = (await native.textOf(el)) === ''; break;
            case 'editable':
            case 'readonly': {
              const n = await native.nodeOf(el);
              const editable = !!n && /EditText|TextField|TextView|InputField/.test(n.tag) && n.attrs.enabled !== 'false';
              actual = c.state === 'editable' ? editable : !editable;
              break;
            }
            default: return fail(c, `state "${c.state}" is not supported on native apps`);
          }
          return actual ? ok(c, c.state) : fail(c, `${c.target.description} is not ${c.state}`);
        }
        default: {
          const text = norm(await native.textOf(el));
          const want = norm(I(c.value));
          if (c.type === 'textEquals') return text === want ? ok(c, text) : fail(c, `${c.target.description} text is "${text}", expected "${want}"`, text);
          if (!want) return fail(c, 'expected text is empty');
          return text.includes(want) ? ok(c, text) : fail(c, `${c.target.description} text "${text}" does not contain "${want}"`, text);
        }
      }
    }
    case 'hidden': {
      for (const id of await native.matches(c.target, vars)) {
        if (await native.ui.displayed(id).catch(() => false)) return fail(c, `${c.target.description} is visible`, 'visible');
      }
      return ok(c, 'hidden');
    }
    case 'count': {
      const n = (await native.matches(c.target, vars)).length;
      return n === c.equals ? ok(c, String(n)) : fail(c, `${c.target.description}: found ${n}, expected ${c.equals}`, String(n));
    }
    case 'countCompare': {
      const n = (await native.matches(c.target, vars)).length;
      const pass = c.op === 'between' ? n >= c.value && n <= (c.max ?? c.value) : compareOp(n, c.op === 'eq' ? 'equals' : c.op, String(c.value));
      return pass ? ok(c, String(n)) : fail(c, `${c.target.description}: found ${n} (${c.op} ${c.value}${c.max !== undefined ? `..${c.max}` : ''})`, String(n));
    }
    case 'dialogSeen': {
      const text = await native.device.alertText().catch(() => undefined);
      if (text === undefined) return fail(c, 'no alert is open');
      return !c.contains || text.includes(I(c.contains)) ? ok(c, text) : fail(c, `alert text "${text}" does not contain "${I(c.contains)}"`, text);
    }
    default:
      if (BROWSER_ONLY.has(c.type)) return fail(c, `${c.type} is a browser condition; it is not supported on native apps`);
      // Data conditions (ledger, API, DB, downloads, expressions, JSON Schema/JSONPath): the runner's evaluator.
      return evaluateConditionOnce(c, { page: noPage(c.type), ledger: env.ledger, vars: env.vars, interpolate: env.interpolate, baseDir: env.baseDir });
  }
}

/** Evaluate all conditions, polling until every one holds or `timeoutMs` elapses. */
export async function evaluateNativeConditions(conds: Condition[], env: NativeConditionEnv, timeoutMs: number): Promise<ConditionResult[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    env.native.invalidate();
    const results: ConditionResult[] = [];
    for (const c of conds) {
      try {
        results.push(await evaluateNativeConditionOnce(c, env));
      } catch (e) {
        results.push(fail(c, `error evaluating ${c.type}: ${(e as Error).message.split('\n')[0]}`));
      }
    }
    if (results.every((r) => r.passed) || Date.now() >= deadline) return results;
    await sleep(Math.min(300, Math.max(20, deadline - Date.now())));
  }
}
