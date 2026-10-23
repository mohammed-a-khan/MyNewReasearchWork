/**
 * Advanced post-conditions: element attributes, CSS, states, classes, count
 * comparisons, sort order, regex; tabs, dialogs, console, requests and
 * WebSocket messages; JSON Schema, JSONPath and response time of captured
 * API responses; downloads, cookies and storage; and safe expressions.
 * Everything is declarative: expressions go through the safe evaluator.
 */
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { Locator } from '../browser/index.js';
import { asNumber, asText, evaluateExpression, truthy, type CompareOp, type Condition, type ConditionResult, type Target } from '../core/index.js';
import { getPath, validateSchema } from '../surfaces/index.js';
import type { ConditionEnv } from './conditions.js';
import { classList, computedCss, innerTextOf, isFocused, rectOf, storageOp, tableRows, viewportRatio } from './inpage.js';
import { describeCandidate, rootFor, targetLocators } from './locate.js';
import { urlMatches } from './pages.js';
import { evaluateApiContract } from '../contracts/condition.js';
import { evaluateDepthCondition } from './conditions-depth.js';
import { evaluateLocaleCondition } from './reliability/locale-conditions.js';

type Adv = Exclude<Condition, { type: 'urlContains' | 'urlMatches' | 'titleContains' | 'visible' | 'hidden' | 'textContains' | 'textEquals' | 'valueEquals' | 'count' | 'pageContainsText' | 'pageNotContainsText' | 'ledgerEquals' | 'apiStatus' | 'dbRowCount' | 'downloadExists' }>;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const fail = (condition: Condition, message: string, actual?: string): ConditionResult => ({ condition, passed: false, message, ...(actual !== undefined ? { actual } : {}) });
const ok = (condition: Condition, actual?: string): ConditionResult => ({ condition, passed: true, ...(actual !== undefined ? { actual } : {}) });

/** Frames a target lives in: the current frame chain plus the target's own. */
export function framesOf(env: Pick<ConditionEnv, 'frames'>, target: Target): string[] {
  return [...(env.frames ?? []), ...(target.frames ?? [])];
}

/** Exactly-one resolution (same rule as actions). */
export async function strictLocator(env: ConditionEnv, target: Target): Promise<{ locator?: Locator; notes: string[] }> {
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

/** All elements of the first candidate that matches anything (for counts, lists, sort order). */
export async function allMatches(env: ConditionEnv, target: Target): Promise<{ locator?: Locator; count: number }> {
  const root = rootFor(env.page, framesOf(env, target));
  const t = await targetLocators(root, target, env.vars());
  for (const { locator: loc } of t.locators) {
    const n = await loc.count().catch(() => 0);
    if (n > 0) return { locator: loc, count: n };
  }
  return { count: 0 };
}

/** Compare an actual value with an operator and expected value. */
export function compareOp(actual: unknown, op: CompareOp, expected?: string): boolean {
  const present = actual !== undefined && actual !== null;
  switch (op) {
    case 'exists': return present;
    case 'absent': return !present;
    case 'equals': return present && (asNumber(actual) !== undefined && asNumber(expected) !== undefined ? asNumber(actual) === asNumber(expected) : asText(actual) === (expected ?? ''));
    case 'ne': return !compareOp(actual, 'equals', expected);
    case 'contains': return present && asText(actual).includes(expected ?? '');
    case 'matches': return present && regex(expected ?? '').test(asText(actual));
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      if (a === undefined || b === undefined) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
  }
}

/** "/x/i" or plain pattern text. */
export function regex(p: string, flags?: string): RegExp {
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(p);
  return m ? new RegExp(m[1], m[2]) : new RegExp(p, flags);
}

const OP_TEXT: Record<string, string> = { equals: 'equal', contains: 'contain', matches: 'match', exists: 'exist', absent: 'be absent', gt: 'be >', gte: 'be >=', lt: 'be <', lte: 'be <=', ne: 'differ from', eq: 'be' };

function numOp(n: number, op: string, v: number, max?: number): boolean {
  switch (op) {
    case 'gt': return n > v;
    case 'gte': return n >= v;
    case 'lt': return n < v;
    case 'lte': return n <= v;
    case 'ne': return n !== v;
    case 'between': return n >= v && n <= (max ?? v);
    default: return n === v;
  }
}

/** The body of an API response, or the value itself. */
function bodyOf(v: unknown): unknown {
  return v && typeof v === 'object' && 'status' in v && 'body' in v ? (v as { body: unknown }).body : v;
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.json': 'application/json', '.txt': 'text/plain', '.html': 'text/html', '.xml': 'application/xml',
  '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Evaluate one advanced condition once. */
export async function evaluateAdvancedCondition(c: Condition, env: ConditionEnv): Promise<ConditionResult> {
  const I = env.interpolate;
  const a = c as Adv;
  switch (a.type) {
    case 'apiContract': return evaluateApiContract(a, env);
    case 'accessible': case 'ariaSnapshot': case 'textNot': case 'pageMatches': return evaluateDepthCondition(a, env);
    case 'attribute': case 'css': case 'state': case 'hasClass': case 'textMatches': {
      if (a.type === 'state' && (a.state === 'detached' || a.state === 'hidden')) {
        const m = await allMatches(env, a.target);
        if (a.state === 'detached') return m.count === 0 ? ok(c, 'detached') : fail(c, `${a.target.description} is still attached (${m.count})`, 'attached');
        for (let i = 0; i < m.count; i++) if (await m.locator!.nth(i).isVisible()) return fail(c, `${a.target.description} is visible`, 'visible');
        return ok(c, 'hidden');
      }
      const r = await strictLocator(env, a.target);
      if (!r.locator) {
        if (a.type === 'attribute' && a.op === 'absent') return fail(c, `${a.target.description}: not found exactly once (${r.notes.join('; ')})`);
        return fail(c, `${a.target.description}: not found exactly once (${r.notes.join('; ')})`);
      }
      const loc = r.locator;
      if (a.type === 'attribute') {
        const v = await loc.getAttribute(a.name, { timeout: 2000 });
        const want = a.value === undefined ? undefined : I(a.value);
        return compareOp(v ?? undefined, a.op, want)
          ? ok(c, v ?? '(absent)')
          : fail(c, `${a.target.description} attribute ${a.name} is ${v === null ? 'absent' : `"${v}"`}, expected to ${OP_TEXT[a.op]}${want !== undefined ? ` "${want}"` : ''}`, v ?? '(absent)');
      }
      if (a.type === 'css') {
        const v = await loc.evaluate(computedCss, a.property, { timeout: 2000 });
        const want = I(a.value);
        return norm(v) === norm(want) ? ok(c, v) : fail(c, `${a.target.description} ${a.property} is "${v}", expected "${want}"`, v);
      }
      if (a.type === 'hasClass') {
        const cls = await loc.evaluate(classList, undefined, { timeout: 2000 });
        const want = I(a.value);
        const has = cls.includes(want);
        return has !== !!a.negate ? ok(c, cls.join(' ')) : fail(c, `${a.target.description} ${a.negate ? 'has' : 'does not have'} class "${want}"`, cls.join(' '));
      }
      if (a.type === 'textMatches') {
        const v = a.field === 'value' ? await loc.inputValue({ timeout: 2000 }) : await loc.evaluate(innerTextOf, undefined, { timeout: 2000 });
        const re = regex(I(a.pattern), a.flags);
        return re.test(v) ? ok(c, v) : fail(c, `${a.target.description} ${a.field ?? 'text'} "${v}" does not match ${re}`, v);
      }
      // state
      let actual: boolean;
      switch (a.state) {
        case 'enabled': actual = await loc.isEnabled({ timeout: 2000 }); break;
        case 'disabled': actual = await loc.isDisabled({ timeout: 2000 }); break;
        case 'editable': actual = await loc.isEditable({ timeout: 2000 }); break;
        case 'readonly': actual = !(await loc.isEditable({ timeout: 2000 })); break;
        case 'checked': actual = await loc.isChecked({ timeout: 2000 }); break;
        case 'unchecked': actual = !(await loc.isChecked({ timeout: 2000 })); break;
        case 'focused': actual = await loc.evaluate(isFocused, undefined, { timeout: 2000 }); break;
        case 'inViewport': actual = (await loc.evaluate(viewportRatio, undefined, { timeout: 2000 })) > 0; break;
        case 'notInViewport': actual = (await loc.evaluate(viewportRatio, undefined, { timeout: 2000 })) === 0; break;
        case 'attached': actual = true; break;
        case 'visible': actual = await loc.isVisible(); break;
        case 'empty': actual = (await loc.evaluate(innerTextOf, undefined, { timeout: 2000 })) === '' && ((await loc.inputValue({ timeout: 500 }).catch(() => '')) === ''); break;
        case 'stable': {
          const r1 = await loc.evaluate(rectOf, undefined, { timeout: 2000 });
          await env.page.waitForTimeout(100);
          const r2 = await loc.evaluate(rectOf, undefined, { timeout: 2000 });
          actual = JSON.stringify(r1) === JSON.stringify(r2);
          break;
        }
        default: actual = false;
      }
      return actual ? ok(c, a.state) : fail(c, `${a.target.description} is not ${a.state}`);
    }
    case 'countCompare': {
      const n = (await allMatches(env, a.target)).count;
      return numOp(n, a.op, a.value, a.max)
        ? ok(c, String(n))
        : fail(c, `${a.target.description}: found ${n}, expected ${a.op === 'between' ? `between ${a.value} and ${a.max}` : `${a.op} ${a.value}`}`, String(n));
    }
    case 'sorted': {
      let texts: string[];
      if (a.column !== undefined) {
        const t = await strictLocator(env, a.target);
        if (!t.locator) return fail(c, `${a.target.description}: not found exactly once (${t.notes.join('; ')})`);
        const rows = await t.locator.evaluate(tableRows, undefined, { timeout: 2000 });
        const col = I(a.column);
        if (rows.length && !(col in rows[0])) return fail(c, `${a.target.description} has no column "${col}" (columns: ${Object.keys(rows[0]).join(', ')})`);
        texts = rows.map((r) => norm(r[col] ?? ''));
      } else {
        const m = await allMatches(env, a.target);
        texts = m.locator ? (await m.locator.allInnerTexts()).map(norm) : [];
      }
      if (texts.length < 2) return fail(c, `${a.target.description}: need at least 2 values to check order (found ${texts.length})`);
      const numeric = a.numeric ?? texts.every((t) => asNumber(t.replace(/[^\d.+-]/g, '')) !== undefined && /\d/.test(t));
      const key = (t: string) => (numeric ? Number(t.replace(/[^\d.+-]/g, '')) : t.toLowerCase());
      for (let i = 1; i < texts.length; i++) {
        const x = key(texts[i - 1]);
        const y = key(texts[i]);
        const bad = a.order === 'desc' ? x < y : x > y;
        if (bad) return fail(c, `${a.target.description} not sorted ${a.order === 'desc' ? 'descending' : 'ascending'}: "${texts[i - 1]}" before "${texts[i]}"`, texts.join(' | '));
      }
      return ok(c, texts.join(' | '));
    }
    case 'expr': {
      const v = evaluateExpression(a.expr, env.vars());
      return truthy(v) ? ok(c, asText(v)) : fail(c, `"${a.expr}" is false`, asText(v));
    }
    case 'tabCount': {
      if (!env.session) return fail(c, 'no browser session');
      const n = env.session.pages.open.length;
      return numOp(n, a.op, a.value) ? ok(c, String(n)) : fail(c, `${n} tabs/windows open, expected ${a.op} ${a.value}`, String(n));
    }
    case 'dialogSeen': {
      if (!env.session) return fail(c, 'no browser session');
      const want = a.contains === undefined ? undefined : I(a.contains);
      const rec = env.session.dialogs.records.find((d) => !d.checked && (!a.kind || d.kind === a.kind) && (want === undefined || d.message.includes(want)));
      if (!rec) {
        const seen = env.session.dialogs.records.map((d) => `${d.kind}: "${d.message}"`).join('; ') || 'none';
        return fail(c, `no ${a.kind ?? 'dialog'}${want !== undefined ? ` saying "${want}"` : ''} appeared (seen: ${seen})`);
      }
      rec.checked = true;
      return ok(c, `${rec.kind}: ${rec.message}`);
    }
    case 'console': {
      if (!env.session) return fail(c, 'no browser session');
      const want = a.contains === undefined ? undefined : I(a.contains);
      const hits = env.session.console.filter((m) => (a.level === 'any' || m.type === a.level || (a.level === 'error' && m.type === 'pageerror')) && (want === undefined || m.text.includes(want)));
      const n = hits.length;
      const tooMany = a.max !== undefined && n > a.max;
      const tooFew = a.min !== undefined ? n < a.min : a.max === undefined && n === 0;
      const desc = `${a.level === 'any' ? '' : `${a.level} `}console messages${want !== undefined ? ` containing "${want}"` : ''}`;
      if (tooMany) return fail(c, `${n} ${desc} (max ${a.max}): ${hits.slice(0, 3).map((h) => h.text).join(' | ')}`, String(n));
      if (tooFew) return fail(c, `${n} ${desc}, expected at least ${a.min ?? 1}`, String(n));
      return ok(c, String(n));
    }
    case 'request': {
      if (!env.session) return fail(c, 'no browser session');
      const url = I(a.url);
      const body = a.bodyContains === undefined ? undefined : I(a.bodyContains);
      const hv = a.headerValue === undefined ? undefined : I(a.headerValue);
      const hits = env.session.requests.filter((r) =>
        urlMatches(r.url, url) && (!a.method || r.method === a.method.toUpperCase()) && (body === undefined || (r.postData ?? '').includes(body)) &&
        (!a.header || (a.header.toLowerCase() in r.headers && (hv === undefined || r.headers[a.header.toLowerCase()].includes(hv)))) &&
        (a.status === undefined || r.status === a.status));
      if (a.negate) return hits.length === 0 ? ok(c, '0') : fail(c, `${hits.length} request(s) to ${url} were made`, String(hits.length));
      if (hits.length) return ok(c, `${hits[hits.length - 1].method} ${hits[hits.length - 1].url}`);
      const near = env.session.requests.filter((r) => urlMatches(r.url, url)).slice(-3).map((r) => `${r.method} ${r.url} ${r.status ?? ''} ${r.postData ? `body=${r.postData.slice(0, 80)}` : ''}`);
      return fail(c, `no matching request to ${url}${near.length ? ` (similar: ${near.join('; ')})` : ''}`);
    }
    case 'wsMessage': {
      if (!env.session) return fail(c, 'no browser session');
      const want = I(a.contains);
      if (a.socket) {
        const s = env.session.sockets.get(a.socket);
        if (!s) return fail(c, `no websocket "${a.socket}" (connect it first)`);
        const hit = s.messages.find((m) => env.session!.mask(m.text).includes(want));
        return hit ? ok(c, env.session.mask(hit.text)) : fail(c, `websocket ${a.socket} received no message containing "${want}"`);
      }
      const hit = env.session.wsFrames.find((f) => f.payload.includes(want));
      return hit ? ok(c, hit.payload) : fail(c, `no websocket frame containing "${want}"`);
    }
    case 'jsonSchema': {
      const v = env.ledger.get(a.captureKey);
      if (v === undefined) return fail(c, `ledger has no value "${a.captureKey}"`);
      let schema = a.schema;
      if (!schema && a.schemaFile) schema = JSON.parse(readFileSync(resolve(env.baseDir ?? process.cwd(), I(a.schemaFile)), 'utf8')) as Record<string, unknown>;
      if (!schema) return fail(c, 'jsonSchema needs schema or schemaFile');
      const r = validateSchema(bodyOf(v), schema);
      return r.valid ? ok(c, 'valid') : fail(c, `${a.captureKey} does not match the schema: ${r.errors.slice(0, 5).join('; ')}`, r.errors.join('; '));
    }
    case 'jsonPath': {
      const v = env.ledger.get(a.captureKey);
      if (v === undefined) return fail(c, `ledger has no value "${a.captureKey}"`);
      let got: unknown;
      try {
        got = getPath(bodyOf(v), I(a.path));
      } catch (e) {
        return fail(c, (e as Error).message);
      }
      const want = a.value === undefined ? undefined : I(a.value);
      return compareOp(got, a.op, want) ? ok(c, asText(got)) : fail(c, `${a.captureKey} ${a.path} is ${got === undefined ? 'absent' : `"${asText(got)}"`}, expected to ${OP_TEXT[a.op]}${want !== undefined ? ` "${want}"` : ''}`, asText(got));
    }
    case 'responseTime': {
      const v = env.ledger.get(a.captureKey) as { durationMs?: number } | undefined;
      if (!v || typeof v.durationMs !== 'number') return fail(c, `ledger has no timed API response "${a.captureKey}"`);
      return v.durationMs <= a.maxMs ? ok(c, `${v.durationMs} ms`) : fail(c, `${a.captureKey} took ${v.durationMs} ms (max ${a.maxMs} ms)`, `${v.durationMs} ms`);
    }
    case 'download': {
      const d = env.ledger.get(a.captureKey) as { filename?: string; size?: number; path?: string } | undefined;
      if (!d || typeof d.filename !== 'string') return fail(c, `ledger has no download "${a.captureKey}"`);
      const problems: string[] = [];
      if (a.name !== undefined && d.filename !== I(a.name)) problems.push(`name is "${d.filename}", expected "${I(a.name)}"`);
      if (a.nameMatches !== undefined && !regex(I(a.nameMatches)).test(d.filename)) problems.push(`name "${d.filename}" does not match ${I(a.nameMatches)}`);
      const size = d.size ?? 0;
      if (a.minBytes !== undefined && size < a.minBytes) problems.push(`size ${size} < ${a.minBytes} bytes`);
      if (a.maxBytes !== undefined && size > a.maxBytes) problems.push(`size ${size} > ${a.maxBytes} bytes`);
      if (a.contentType !== undefined) {
        const ext = extname(d.filename).toLowerCase();
        const mime = MIME[ext] ?? 'application/octet-stream';
        const want = I(a.contentType).toLowerCase().replace(/^\./, '');
        if (!(mime === want || mime.includes(want) || ext === `.${want}`)) problems.push(`type is ${mime} (${ext || 'no extension'}), expected ${want}`);
      }
      return problems.length ? fail(c, `download ${a.captureKey}: ${problems.join('; ')}`, `${d.filename} ${size} bytes`) : ok(c, `${d.filename} ${size} bytes`);
    }
    case 'cookie': {
      const cookies = await env.page.context().cookies();
      const ck = cookies.find((x) => x.name === I(a.name));
      const mask = env.session?.mask ?? ((s: string) => s);
      const want = a.value === undefined ? undefined : I(a.value);
      return compareOp(ck?.value, a.op, want) ? ok(c, ck ? mask(ck.value) : '(absent)') : fail(c, `cookie ${a.name} is ${ck ? `"${mask(ck.value)}"` : 'absent'}, expected to ${OP_TEXT[a.op]}${want !== undefined ? ` "${mask(want)}"` : ''}`);
    }
    case 'storage': {
      const v = (await env.page.evaluate(storageOp, { area: a.area, op: 'get', key: I(a.key) })) as string | null;
      const mask = env.session?.mask ?? ((s: string) => s);
      const want = a.value === undefined ? undefined : I(a.value);
      return compareOp(v ?? undefined, a.op, want) ? ok(c, v === null ? '(absent)' : mask(v)) : fail(c, `${a.area}Storage ${a.key} is ${v === null ? 'absent' : `"${mask(v)}"`}, expected to ${OP_TEXT[a.op]}${want !== undefined ? ` "${mask(want)}"` : ''}`);
    }
    case 'localeValue':
    case 'direction':
      return evaluateLocaleCondition(a, env);
  }
}
