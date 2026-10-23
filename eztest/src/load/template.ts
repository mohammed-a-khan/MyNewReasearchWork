/**
 * Templates in user paths: `${var}`, `${data.column}`, built-ins and safe
 * expressions. Templates are compiled once per distinct string, so the hot
 * path is an array join.
 *
 *   ${token}  ${users.username}  ${__vu}  ${__iter}  ${__uuid}  ${__now}
 *   ${__rand(1,100)}  ${__randomString(12)}  ${__urlencode(name)}  ${__base64(text)}
 *   ${qty * 2}        (anything else: EZTest's safe expression language)
 */
import { randomUUID } from 'node:crypto';
import { EzTestError, evaluateExpression } from '../core/index.js';

export class TemplateError extends EzTestError {
  constructor(message: string) {
    super(message, 'LOAD_TEMPLATE');
    this.name = 'TemplateError';
  }
}

export interface TemplateScope {
  vars: Map<string, unknown>;
  vu: number;
  iter: number;
  random: () => number;
}

type Part = string | ((s: TemplateScope) => string);

const cache = new Map<string, Part[]>();
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function lookup(scope: TemplateScope, path: string): unknown {
  if (scope.vars.has(path)) return scope.vars.get(path);
  const dot = path.indexOf('.');
  if (dot > 0) {
    let cur: unknown = scope.vars.get(path.slice(0, dot));
    for (const seg of path.slice(dot + 1).split('.')) {
      if (cur === null || cur === undefined) return undefined;
      cur = (cur as Record<string, unknown>)[/^\d+$/.test(seg) && Array.isArray(cur) ? Number(seg) : seg];
    }
    return cur;
  }
  return undefined;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function compileExpr(expr: string): (s: TemplateScope) => string {
  const e = expr.trim();
  if (e === '__vu') return (s) => String(s.vu);
  if (e === '__iter') return (s) => String(s.iter);
  if (e === '__uuid') return () => randomUUID();
  if (e === '__now') return () => String(Date.now());
  if (e === '__isoNow') return () => new Date().toISOString();
  let m = /^__rand\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(e);
  if (m) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return (s) => String(lo + Math.floor(s.random() * (hi - lo + 1)));
  }
  m = /^__randomString\(\s*(\d+)\s*\)$/.exec(e);
  if (m) {
    const n = Number(m[1]);
    return (s) => {
      let out = '';
      for (let i = 0; i < n; i++) out += ALNUM[Math.floor(s.random() * ALNUM.length)];
      return out;
    };
  }
  m = /^__(urlencode|base64|htmlunescape|lower|upper)\(\s*([\w.]+)\s*\)$/.exec(e);
  if (m) {
    const fn = m[1];
    const name = m[2];
    return (s) => {
      const v = lookup(s, name);
      if (v === undefined) throw new TemplateError(`variable "${name}" is not set`);
      const t = str(v);
      if (fn === 'urlencode') return encodeURIComponent(t);
      if (fn === 'base64') return Buffer.from(t).toString('base64');
      if (fn === 'lower') return t.toLowerCase();
      if (fn === 'upper') return t.toUpperCase();
      return htmlUnescape(t);
    };
  }
  if (/^[A-Za-z_][\w]*(\.[\w]+)*$/.test(e)) {
    return (s) => {
      const v = lookup(s, e);
      if (v === undefined) throw new TemplateError(`variable "${e}" is not set (was it extracted by an earlier request?)`);
      return str(v);
    };
  }
  return (s) => {
    const vars: Record<string, unknown> = Object.fromEntries(s.vars);
    vars.__vu = s.vu;
    vars.__iter = s.iter;
    return str(evaluateExpression(e, vars));
  };
}

/** Compile a template string (memoized). */
export function compileTemplate(src: string): Part[] {
  let parts = cache.get(src);
  if (parts) return parts;
  parts = [];
  let i = 0;
  let lit = '';
  while (i < src.length) {
    const open = src.indexOf('${', i);
    if (open < 0) {
      lit += src.slice(i);
      break;
    }
    lit += src.slice(i, open);
    let depth = 1;
    let j = open + 2;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      if (depth > 0) j++;
    }
    if (depth !== 0) {
      lit += src.slice(open);
      break;
    }
    if (lit) parts.push(lit);
    lit = '';
    parts.push(compileExpr(src.slice(open + 2, j)));
    i = j + 1;
  }
  if (lit) parts.push(lit);
  if (cache.size > 50_000) cache.clear();
  cache.set(src, parts);
  return parts;
}

export function render(src: string, scope: TemplateScope): string {
  if (src.indexOf('${') < 0) return src;
  const parts = compileTemplate(src);
  let out = '';
  for (const p of parts) out += typeof p === 'string' ? p : p(scope);
  return out;
}

/** Render every string leaf of a JSON value. A leaf that is exactly "${x}" keeps x's type. */
export function renderDeep(v: unknown, scope: TemplateScope): unknown {
  if (typeof v === 'string') {
    const m = /^\$\{([\w.]+)\}$/.exec(v);
    if (m && !m[1].startsWith('__')) {
      const x = lookup(scope, m[1]);
      if (x === undefined) throw new TemplateError(`variable "${m[1]}" is not set`);
      return x;
    }
    return render(v, scope);
  }
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, scope));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, scope)]));
  return v;
}

export function htmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos' || k === '#39') return "'";
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    return String.fromCodePoint(parseInt(k.slice(1), 10));
  });
}

/** Seeded PRNG (mulberry32) for reproducible think times and random data. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
