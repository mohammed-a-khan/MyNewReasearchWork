/**
 * A small, safe JSONPath subset: $ . key ['key'] [0] [-1] [*] .*
 * No filters or script expressions (nothing is evaluated).
 */
import { EzTestError } from '../core/index.js';

type Seg = { kind: 'key'; key: string } | { kind: 'index'; index: number } | { kind: 'wild' };

const cache = new Map<string, Seg[]>();

export function parsePath(path: string): Seg[] {
  const hit = cache.get(path);
  if (hit) return hit;
  const segs: Seg[] = [];
  let i = 0;
  const p = path.trim();
  if (p.startsWith('$')) i = 1;
  const err = (msg: string) => new EzTestError(`Invalid path "${path}": ${msg}`, 'PATH_SYNTAX');
  while (i < p.length) {
    const c = p[i];
    if (c === '.') {
      i++;
      if (p[i] === '*') {
        segs.push({ kind: 'wild' });
        i++;
        continue;
      }
      const m = /^[A-Za-z_$][\w$-]*/.exec(p.slice(i));
      if (!m) throw err(`expected a name at ${i}`);
      segs.push({ kind: 'key', key: m[0] });
      i += m[0].length;
    } else if (c === '[') {
      const close = p.indexOf(']', i);
      if (close < 0) throw err('missing ]');
      const inner = p.slice(i + 1, close).trim();
      if (inner === '*') segs.push({ kind: 'wild' });
      else if (/^-?\d+$/.test(inner)) segs.push({ kind: 'index', index: Number(inner) });
      else if (/^'.*'$|^".*"$/.test(inner)) segs.push({ kind: 'key', key: inner.slice(1, -1) });
      else throw err(`unsupported selector [${inner}]`);
      i = close + 1;
    } else if (i === 0 || (segs.length === 0 && i === (p.startsWith('$') ? 1 : 0))) {
      // allow a bare leading name: "a.b"
      const m = /^[A-Za-z_$][\w$-]*/.exec(p.slice(i));
      if (!m) throw err(`unexpected "${c}"`);
      segs.push({ kind: 'key', key: m[0] });
      i += m[0].length;
    } else throw err(`unexpected "${c}" at ${i}`);
  }
  cache.set(path, segs);
  return segs;
}

/** All values matching the path (wildcards fan out). Missing branches are skipped. */
export function queryPath(value: unknown, path: string): unknown[] {
  let cur: unknown[] = [value];
  for (const s of parsePath(path)) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (s.kind === 'wild') {
        if (Array.isArray(v)) next.push(...v);
        else if (v && typeof v === 'object') next.push(...Object.values(v));
      } else if (s.kind === 'index') {
        if (Array.isArray(v)) {
          const idx = s.index < 0 ? v.length + s.index : s.index;
          if (idx >= 0 && idx < v.length) next.push(v[idx]);
        }
      } else if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, s.key)) {
        next.push((v as Record<string, unknown>)[s.key]);
      }
    }
    cur = next;
  }
  return cur;
}

/** Single value for a definite path; an array of matches when the path has a wildcard. */
export function getPath(value: unknown, path: string): unknown {
  const wild = parsePath(path).some((s) => s.kind === 'wild');
  const r = queryPath(value, path);
  return wild ? r : r[0];
}

export function hasPath(value: unknown, path: string): boolean {
  return queryPath(value, path).length > 0;
}
