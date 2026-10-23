/**
 * Value printing for assertion messages and diffs (EZTest testkit, dev-only).
 *
 * `inline()` prints a short one-line form for messages ("expected 'a' to be 'b'");
 * `pretty()` prints a stable multi-line form that the line diff compares.
 */
import { isAsymmetric } from './asymmetric.js';

const MAX_DEPTH = 12;
const MAX_ITEMS = 500;

function tag(v: unknown): string {
  return Object.prototype.toString.call(v).slice(8, -1);
}

function ctorName(v: object): string {
  const proto = Object.getPrototypeOf(v);
  if (proto === null) return 'Object';
  const name = proto.constructor?.name;
  return typeof name === 'string' && name ? name : 'Object';
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function keyText(k: string | symbol): string {
  if (typeof k === 'symbol') return `[${String(k)}]`;
  return quote(k);
}

function ownKeys(v: object): Array<string | symbol> {
  const keys: Array<string | symbol> = Object.keys(v);
  for (const s of Object.getOwnPropertySymbols(v)) if (Object.getOwnPropertyDescriptor(v, s)?.enumerable) keys.push(s);
  return keys;
}

function primitive(v: unknown): string | undefined {
  switch (typeof v) {
    case 'string':
      return quote(v);
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v);
    case 'bigint':
      return `${v}n`;
    case 'boolean':
      return String(v);
    case 'undefined':
      return 'undefined';
    case 'symbol':
      return String(v);
    case 'function':
      return `[Function ${(v as { name?: string }).name || 'anonymous'}]`;
    default:
      return v === null ? 'null' : undefined;
  }
}

/** Multi-line, diff-friendly form: sorted nothing, keys in insertion order, trailing commas. */
export function pretty(value: unknown, indent = '', seen: unknown[] = [], depth = 0): string {
  const p = primitive(value);
  if (p !== undefined) return p;
  const v = value as object;
  if (isAsymmetric(v)) return v.toString();
  if (seen.includes(v)) return '[Circular]';
  const t = tag(v);
  if (t === 'Date') return Number.isNaN((v as Date).getTime()) ? 'Date { NaN }' : `${(v as Date).toISOString()}`;
  if (t === 'RegExp') return String(v);
  if (v instanceof Error) {
    const extra = ownKeys(v).filter((k) => k !== 'stack' && k !== 'message');
    const head = `[${v.name || ctorName(v)}: ${v.message}]`;
    if (!extra.length || depth >= MAX_DEPTH) return head;
    return `${head} ${objectBody(v, extra, indent, [...seen, v], depth)}`;
  }
  if (t === 'URL' || v instanceof URL) return `URL ${quote(String(v))}`;
  if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[Array]' : `[${ctorName(v)}]`;
  const next = indent + '  ';
  const s = [...seen, v];
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const arr = v as unknown as ArrayLike<unknown>;
    const name = Array.isArray(v) ? (ctorName(v) === 'Array' ? '' : `${ctorName(v)} `) : `${ctorName(v)} `;
    if (arr.length === 0) return `${name}[]`;
    const lines: string[] = [];
    const n = Math.min(arr.length, MAX_ITEMS);
    for (let i = 0; i < n; i++) lines.push(`${next}${i in (arr as object) ? pretty(arr[i], next, s, depth + 1) : '<empty>'},`);
    if (arr.length > n) lines.push(`${next}... ${arr.length - n} more`);
    return `${name}[\n${lines.join('\n')}\n${indent}]`;
  }
  if (v instanceof Map) {
    if (v.size === 0) return 'Map {}';
    const lines = [...v.entries()].slice(0, MAX_ITEMS).map(([k, x]) => `${next}${pretty(k, next, s, depth + 1)} => ${pretty(x, next, s, depth + 1)},`);
    return `Map {\n${lines.join('\n')}\n${indent}}`;
  }
  if (v instanceof Set) {
    if (v.size === 0) return 'Set {}';
    const lines = [...v.values()].slice(0, MAX_ITEMS).map((x) => `${next}${pretty(x, next, s, depth + 1)},`);
    return `Set {\n${lines.join('\n')}\n${indent}}`;
  }
  if (typeof (v as { then?: unknown }).then === 'function' && t === 'Promise') return 'Promise {}';
  const name = ctorName(v);
  const keys = ownKeys(v);
  const prefix = name === 'Object' ? '' : `${name} `;
  if (!keys.length) return `${prefix}{}`;
  return `${prefix}${objectBody(v, keys, indent, s, depth)}`;
}

function objectBody(v: object, keys: Array<string | symbol>, indent: string, seen: unknown[], depth: number): string {
  const next = indent + '  ';
  const lines = keys.slice(0, MAX_ITEMS).map((k) => {
    let val: unknown;
    try {
      val = (v as Record<string | symbol, unknown>)[k];
    } catch (e) {
      val = `[getter threw: ${(e as Error).message}]`;
    }
    return `${next}${keyText(k)}: ${pretty(val, next, seen, depth + 1)},`;
  });
  if (keys.length > MAX_ITEMS) lines.push(`${next}... ${keys.length - MAX_ITEMS} more`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

/** One-line, length-capped form for messages. */
export function inline(value: unknown, max = 120): string {
  if (typeof value === 'string') {
    const q = `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
    return q.length > max ? `${q.slice(0, max - 4)}...'` : q;
  }
  const p = primitive(value);
  if (p !== undefined) return p;
  let text: string;
  try {
    text = pretty(value)
      .split('\n')
      .map((l) => l.trim())
      .join(' ')
      .replace(/,\s*([}\]])/g, ' $1')
      .replace(/\[ /g, '[')
      .replace(/ \]/g, ']');
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
