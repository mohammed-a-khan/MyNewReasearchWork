/**
 * Deterministic example data from JSON Schemas (OpenAPI component schemas):
 * examples and defaults first, then values synthesised with a seeded PRNG
 * (enum, const, formats, numeric bounds, string lengths, simple patterns,
 * property-name hints such as email/name/city). The same seed and schema give
 * the same value on every run.
 */
import { Synthetic } from '../data/synthetic.js';
import { resolveSchemaRef, type ApiSpec } from './openapi.js';

type Json = Record<string, unknown>;

export interface GenerateOptions {
  seed?: string | number;
  /** Prefer schema `example`/`default` values (default true). */
  useExamples?: boolean;
  /** Items generated for arrays without minItems (default 2). */
  arrayItems?: number;
  maxDepth?: number;
}

/** Generate a string matching a simple regular expression (literals, classes, \d \w \s, groups, alternation, quantifiers). */
export function stringFromPattern(pattern: string, rnd: Synthetic): string | undefined {
  let i = 0;
  const p = pattern.replace(/^\^/, '').replace(/\$$/, '');
  const DIGITS = '0123456789';
  const WORD = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
  type Node = { kind: 'set'; chars: string } | { kind: 'group'; alts: Node[][] };
  function parseAlts(): Node[][] {
    const alts: Node[][] = [[]];
    while (i < p.length && p[i] !== ')') {
      if (p[i] === '|') {
        alts.push([]);
        i++;
        continue;
      }
      const atom = parseAtom();
      if (!atom) return alts;
      const { min, max } = parseQuant();
      const n = min === max ? min : min + rnd.int(0, Math.min(max, min + 3) - min);
      for (let k = 0; k < n; k++) alts[alts.length - 1].push(atom);
    }
    return alts;
  }
  function parseQuant(): { min: number; max: number } {
    const c = p[i];
    if (c === '?') return (i++, { min: 0, max: 1 });
    if (c === '*') return (i++, { min: 0, max: 3 });
    if (c === '+') return (i++, { min: 1, max: 3 });
    if (c === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(p.slice(i));
      if (m) {
        i += m[0].length;
        const min = Number(m[1]);
        return { min, max: m[2] === undefined ? min : m[2] === '' ? min + 3 : Number(m[2]) };
      }
    }
    return { min: 1, max: 1 };
  }
  function escapeSet(c: string): string {
    if (c === 'd') return DIGITS;
    if (c === 'w') return WORD;
    if (c === 's') return ' ';
    return c;
  }
  function parseAtom(): Node | undefined {
    const c = p[i];
    if (c === '(') {
      i++;
      if (p.startsWith('?:', i)) i += 2;
      const alts = parseAlts();
      if (p[i] !== ')') return undefined;
      i++;
      return { kind: 'group', alts };
    }
    if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end < 0) return undefined;
      let body = p.slice(i + 1, end);
      i = end + 1;
      if (body.startsWith('^')) return { kind: 'set', chars: 'x' };
      let chars = '';
      body = body.replace(/\\(.)/g, (_m, x: string) => `\u0000${x}`);
      for (let k = 0; k < body.length; k++) {
        if (body[k] === '\u0000') {
          chars += escapeSet(body[++k]);
          continue;
        }
        if (body[k + 1] === '-' && k + 2 < body.length) {
          for (let x = body.charCodeAt(k); x <= body.charCodeAt(k + 2); x++) chars += String.fromCharCode(x);
          k += 2;
        } else chars += body[k];
      }
      return { kind: 'set', chars: chars || 'x' };
    }
    if (c === '\\') {
      i += 2;
      return { kind: 'set', chars: escapeSet(p[i - 1]) };
    }
    if (c === '.') return (i++, { kind: 'set', chars: 'abc' });
    if (c === ')' || c === '|') return undefined;
    i++;
    return { kind: 'set', chars: c };
  }
  const emit = (nodes: Node[]): string => nodes.map((n) => (n.kind === 'set' ? n.chars[rnd.int(0, n.chars.length - 1)] : emit(n.alts[rnd.int(0, n.alts.length - 1)]))).join('');
  try {
    const alts = parseAlts();
    if (i < p.length) return undefined;
    const out = emit(alts[rnd.int(0, alts.length - 1)]);
    return new RegExp(pattern).test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

const BASE_DATE = Date.UTC(2026, 0, 15, 9, 30, 0);

function byName(name: string, rnd: Synthetic): string | undefined {
  const n = name.toLowerCase();
  if (/e-?mail/.test(n)) return rnd.email();
  if (/^first_?name$/.test(n)) return rnd.firstName();
  if (/^last_?name$|surname/.test(n)) return rnd.lastName();
  if (/^(?:full_?)?name$|customer$|owner$/.test(n)) return rnd.fullName();
  if (/company|organi[sz]ation/.test(n)) return rnd.company();
  if (/phone|mobile/.test(n)) return rnd.phone();
  if (/city/.test(n)) return rnd.address().city;
  if (/country/.test(n)) return rnd.address().country;
  if (/street|address/.test(n)) return rnd.address().street;
  if (/post_?code|zip/.test(n)) return rnd.address().postcode;
  if (/currency/.test(n)) return rnd.pick(['USD', 'EUR', 'GBP']);
  if (/status/.test(n)) return rnd.pick(['active', 'pending']);
  return undefined;
}

export function generateValue(spec: ApiSpec | undefined, schema: Json | undefined, opts: GenerateOptions = {}, name = '', rnd = new Synthetic(opts.seed ?? 42), depth = 0): unknown {
  let s = spec ? resolveSchemaRef(spec, schema) : schema;
  if (!s || typeof s !== 'object') return name ? byName(name, rnd) ?? 'example' : {};
  const useEx = opts.useExamples !== false;
  if (useEx && s.example !== undefined) return s.example;
  if (useEx && Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.const !== undefined) return s.const;
  if (useEx && s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.find((e) => e !== null) ?? s.enum[0];
  if (Array.isArray(s.allOf)) {
    const merged: Json = { type: 'object', properties: {}, required: [] as string[] };
    for (const part of s.allOf as Json[]) {
      const r = spec ? resolveSchemaRef(spec, part) : part;
      if (!r) continue;
      if (r.properties) Object.assign(merged.properties as Json, r.properties);
      if (Array.isArray(r.required)) (merged.required as string[]).push(...(r.required as string[]));
      for (const k of ['type', 'items', 'enum', 'format', 'pattern', 'minimum', 'maximum']) if (r[k] !== undefined && merged[k] === undefined) merged[k] = r[k];
    }
    s = merged;
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length) return generateValue(spec, s.oneOf[0] as Json, opts, name, rnd, depth + 1);
  if (Array.isArray(s.anyOf) && s.anyOf.length) return generateValue(spec, (s.anyOf as Json[]).find((x) => x.type !== 'null') ?? (s.anyOf[0] as Json), opts, name, rnd, depth + 1);
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : (s.type as string | undefined) ?? (s.properties ? 'object' : s.items ? 'array' : 'string');
  const max = opts.maxDepth ?? 6;
  switch (type) {
    case 'object': {
      const out: Json = {};
      if (depth >= max) return out;
      for (const [k, ps] of Object.entries((s.properties ?? {}) as Json)) out[k] = generateValue(spec, ps as Json, opts, k, rnd, depth + 1);
      return out;
    }
    case 'array': {
      if (depth >= max) return [];
      const min = Number(s.minItems ?? 0);
      const maxItems = s.maxItems === undefined ? Infinity : Number(s.maxItems);
      const n = Math.min(Math.max(min, opts.arrayItems ?? 2), maxItems);
      return Array.from({ length: n }, () => generateValue(spec, s.items as Json, opts, name.replace(/s$/, ''), rnd, depth + 1));
    }
    case 'integer': case 'number': {
      const lo = typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : /id$/i.test(name) ? 1 : 0;
      const hi = typeof s.maximum === 'number' ? s.maximum : typeof s.exclusiveMaximum === 'number' ? s.exclusiveMaximum - 1 : Math.max(lo + 1000, lo);
      if (type === 'integer') {
        let v = rnd.int(Math.ceil(lo), Math.floor(hi));
        if (typeof s.multipleOf === 'number' && s.multipleOf > 0) v = Math.ceil(v / s.multipleOf) * s.multipleOf;
        return v;
      }
      return rnd.float(lo, hi, 2);
    }
    case 'boolean': return rnd.bool();
    case 'null': return null;
    default: {
      const f = String(s.format ?? '');
      let v: string;
      if (f === 'date-time') v = new Date(BASE_DATE + rnd.int(0, 86_400) * 1000).toISOString();
      else if (f === 'date') v = new Date(BASE_DATE + rnd.int(0, 365) * 86_400_000).toISOString().slice(0, 10);
      else if (f === 'uuid') v = rnd.uuid();
      else if (f === 'email') v = rnd.email();
      else if (f === 'uri' || f === 'url') v = `https://example.com/${rnd.letters(6).toLowerCase()}`;
      else if (f === 'ipv4') v = `10.0.${rnd.int(0, 255)}.${rnd.int(1, 254)}`;
      else if (f === 'byte') v = Buffer.from(rnd.letters(6)).toString('base64');
      else if (typeof s.pattern === 'string') v = stringFromPattern(s.pattern, rnd) ?? 'x';
      else v = byName(name, rnd) ?? `${name || 'value'}-${rnd.digits(4)}`;
      const minL = Number(s.minLength ?? 0);
      const maxL = s.maxLength === undefined ? Infinity : Number(s.maxLength);
      if (v.length < minL) v = v.padEnd(minL, 'x');
      if (v.length > maxL) v = v.slice(0, maxL);
      return v;
    }
  }
}
