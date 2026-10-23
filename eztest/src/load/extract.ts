/**
 * Extractors (JSON path, regular expression, boundaries, header, cookie)
 * and per-request assertions for virtual users.
 */
import { queryPath } from '../surfaces/jsonpath.js';
import type { Assertion, Extractor } from './model.js';
import { htmlUnescape, render, type TemplateScope } from './template.js';

export interface ExchangeView {
  status: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  durationMs: number;
}

class Lazy {
  private text?: string;
  private json?: { ok: boolean; v: unknown };
  constructor(readonly x: ExchangeView) {}
  get body(): string {
    return (this.text ??= this.x.body.toString('utf8'));
  }
  get parsed(): { ok: boolean; v: unknown } {
    if (!this.json) {
      try {
        this.json = { ok: true, v: JSON.parse(this.body) };
      } catch {
        this.json = { ok: false, v: undefined };
      }
    }
    return this.json;
  }
}

const reCache = new Map<string, RegExp>();
function re(src: string, flags = 'g'): RegExp {
  const k = `${flags}/${src}`;
  let r = reCache.get(k);
  if (!r) {
    r = new RegExp(src, flags);
    reCache.set(k, r);
  }
  r.lastIndex = 0;
  return r;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceText(x: Lazy, e: Pick<Extractor, 'from' | 'name'>): string[] {
  const h = x.x.headers;
  switch (e.from) {
    case 'status':
      return [String(x.x.status)];
    case 'url':
      return [x.x.url];
    case 'header': {
      const v = h[(e.name ?? '').toLowerCase()];
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    }
    case 'headers':
      return [Object.entries(h).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')];
    case 'cookie': {
      const sc = h['set-cookie'];
      const list = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
      return list.map((l) => l.split(';')[0]).filter((kv) => kv.startsWith(`${e.name}=`)).map((kv) => kv.slice((e.name ?? '').length + 1));
    }
    default:
      return [x.body];
  }
}

/** All matches of one extractor. */
export function extractAll(x: Lazy | ExchangeView, e: Extractor, scope?: TemplateScope): string[] {
  const lazy = x instanceof Lazy ? x : new Lazy(x);
  if (e.json) {
    const p = lazy.parsed;
    if (!p.ok) return [];
    return queryPath(p.v, e.json).filter((v) => v !== undefined && v !== null).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
  }
  const texts = sourceText(lazy, e);
  if (e.regex) {
    const out: string[] = [];
    const src = scope ? render(e.regex, scope) : e.regex;
    for (const t of texts) for (const m of t.matchAll(re(src))) out.push(m[e.group ?? (m.length > 1 ? 1 : 0)] ?? '');
    return out;
  }
  if (e.boundary) {
    const out: string[] = [];
    const r = re(`${escapeRe(e.boundary.left)}([\\s\\S]*?)${escapeRe(e.boundary.right)}`);
    for (const t of texts) for (const m of t.matchAll(r)) out.push(m[1]);
    return out;
  }
  return texts;
}

function decode(v: string, d: Extractor['decode']): string {
  if (d === 'url') {
    try {
      return decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      return v;
    }
  }
  if (d === 'html') return htmlUnescape(v);
  if (d === 'base64') return Buffer.from(v, 'base64').toString('utf8');
  return v;
}

export interface ExtractOutcome {
  vars: Array<[string, unknown]>;
  missing: string[];
}

export function runExtractors(x: ExchangeView, list: Extractor[], random: () => number, scope?: TemplateScope): ExtractOutcome {
  const lazy = new Lazy(x);
  const vars: Array<[string, unknown]> = [];
  const missing: string[] = [];
  for (const e of list) {
    const all = extractAll(lazy, e, scope).map((v) => decode(v, e.decode));
    let value: unknown;
    if (all.length) {
      const idx = e.index ?? 0;
      if (idx === 'all') value = all;
      else if (idx === 'random') value = all[Math.floor(random() * all.length)];
      else if (idx === 'last') value = all[all.length - 1];
      else value = all[idx];
    }
    if (value === undefined) {
      if (e.default !== undefined) value = e.default;
      else if (e.required !== false) missing.push(e.var);
    }
    if (value !== undefined) vars.push([e.var, value]);
    if (Array.isArray(value)) vars.push([`${e.var}_count`, String(value.length)]);
  }
  return { vars, missing };
}

/** First failed assertion's message, or undefined when all hold. Status is checked by the caller when no status assertion is given. */
export function checkAssertions(x: ExchangeView, list: Assertion[], scope: TemplateScope): string | undefined {
  const lazy = new Lazy(x);
  for (const a of list) {
    const label = a.message ? `${a.message}: ` : '';
    if (a.status !== undefined) {
      const ok = Array.isArray(a.status) ? a.status.includes(x.status) : x.status === a.status;
      if (!ok) return `${label}status ${x.status}, expected ${Array.isArray(a.status) ? a.status.join('/') : a.status}`;
    }
    if (a.contains !== undefined) {
      const t = render(a.contains, scope);
      if (!lazy.body.includes(t)) return `${label}response does not contain "${t.slice(0, 80)}"`;
    }
    if (a.notContains !== undefined) {
      const t = render(a.notContains, scope);
      if (lazy.body.includes(t)) return `${label}response contains "${t.slice(0, 80)}"`;
    }
    if (a.regex !== undefined && !re(a.regex, '').test(lazy.body)) return `${label}response does not match /${a.regex}/`;
    if (a.json !== undefined) {
      const p = lazy.parsed;
      const vals = p.ok ? queryPath(p.v, a.json) : [];
      if (a.exists === false) {
        if (vals.length) return `${label}${a.json} exists`;
      } else if (!vals.length) return `${label}${a.json} not found`;
      if (a.equals !== undefined) {
        const want = typeof a.equals === 'string' ? render(a.equals, scope) : a.equals;
        if (!vals.some((v) => v === want || String(v) === String(want))) return `${label}${a.json} is ${JSON.stringify(vals[0])}, expected ${JSON.stringify(want)}`;
      }
    }
    if (a.header !== undefined) {
      const v = x.headers[a.header.toLowerCase()];
      if (a.exists === false ? v !== undefined : v === undefined) return `${label}header ${a.header} ${a.exists === false ? 'present' : 'missing'}`;
      if (a.equals !== undefined && String(v) !== String(a.equals)) return `${label}header ${a.header} is "${String(v)}"`;
    }
    if (a.maxMs !== undefined && x.durationMs > a.maxMs) return `${label}took ${Math.round(x.durationMs)} ms (max ${a.maxMs})`;
    if (a.minBytes !== undefined && x.body.length < a.minBytes) return `${label}body ${x.body.length} bytes < ${a.minBytes}`;
    if (a.maxBytes !== undefined && x.body.length > a.maxBytes) return `${label}body ${x.body.length} bytes > ${a.maxBytes}`;
  }
  return undefined;
}
