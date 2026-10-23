/**
 * Call sites of SDK calls ("which line of the journey file is this?"): the
 * debugger's line breakpoints, the trace and the reports use them.
 *
 * The stack is read with the V8 structured stack API (no parsing of
 * user-controlled text as code). Frames inside a bundled module are mapped
 * back to the original TypeScript line with the bundle's source map, which
 * the loader registers; frames already pointing at a journey's source file
 * (tsx, Node type stripping, or a runtime with source maps enabled) are used
 * as they are.
 */
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepSource } from '../core/index.js';
import { shared, type BundleMap } from './runtime.js';

interface CallSiteLike {
  getFileName(): string | null | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
}

const toPath = (f: string): string => {
  if (f.startsWith('file://')) {
    try {
      return fileURLToPath(f.replace(/\?.*$/, ''));
    } catch {
      return f;
    }
  }
  return f.replace(/\?.*$/, '');
};

function structuredStack(limit = 40): CallSiteLike[] {
  const E = Error as unknown as { prepareStackTrace?: unknown; stackTraceLimit: number; captureStackTrace(o: object, f?: unknown): void };
  const savedPrepare = E.prepareStackTrace;
  const savedLimit = E.stackTraceLimit;
  try {
    E.stackTraceLimit = limit;
    E.prepareStackTrace = (_e: unknown, frames: CallSiteLike[]) => frames;
    const holder: { stack?: unknown } = {};
    E.captureStackTrace(holder, structuredStack);
    return Array.isArray(holder.stack) ? (holder.stack as CallSiteLike[]) : [];
  } catch {
    return [];
  } finally {
    E.prepareStackTrace = savedPrepare;
    E.stackTraceLimit = savedLimit;
  }
}

/** Map a generated position in a bundle to the original source (1-based line, 0-based column). */
export function mapPosition(map: BundleMap, line: number, column: number): { file: string; line: number; column: number } | undefined {
  const segs = map.lines[line - 1];
  if (!segs?.length) return undefined;
  let best = segs[0];
  for (const s of segs) {
    if (s[0] <= column) best = s;
    else break;
  }
  const file = map.sources[best[1]];
  return file ? { file, line: best[2] + 1, column: best[3] } : undefined;
}

/** This EZTest's own source tree (src/ or dist/): its frames are never a journey's call site. */
const FRAMEWORK_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_MODULES = /[\\/]node_modules[\\/]/;

/** Another copy of the SDK or runner (e.g. dist next to src): never a call site. */
function isFrameworkCopy(file: string): boolean {
  if (!/[\\/](?:src|dist)[\\/](?:sdk|runner|core|intent|heal)[\\/][^\\/]+\.[cm]?[jt]s$/.test(file)) return false;
  return existsSync(join(dirname(dirname(file)), 'sdk', `runtime${extname(file)}`));
}

/** Map one stack frame to a journey source location, or undefined for framework or library code. */
function resolveFrame(raw: string, line: number, col: number): StepSource | undefined {
  const s = shared();
  const file = toPath(raw);
  const map = s.maps.get(file);
  if (map) {
    const m = mapPosition(map, line, col);
    return m && !NODE_MODULES.test(m.file) ? { file: m.file, line: m.line, column: m.column } : undefined;
  }
  if (line <= 0 || !isAbsolute(file)) return undefined;
  if (NODE_MODULES.test(file) || file.startsWith(FRAMEWORK_ROOT + sep) || isFrameworkCopy(file)) return undefined;
  if (s.userFiles.has(file)) return { file, line, column: col };
  // Helpers imported by a journey (screens, step libraries) under the runtime's own TypeScript loader.
  return /\.(?:m?[jt]s|tsx)$/.test(file) ? { file, line, column: col } : undefined;
}

/**
 * The first stack frame in journey code (not in EZTest, not in node_modules),
 * mapped to the original source.
 */
export function callSite(): StepSource | undefined {
  // The formatted stack goes through any installed source-map support (a runtime that
  // transforms modules itself, or --enable-source-maps), so its positions are the ones to map.
  const E = Error as unknown as { stackTraceLimit: number; captureStackTrace(o: object, f?: unknown): void; prepareStackTrace?: unknown };
  if (typeof E.prepareStackTrace === 'function') {
    const saved = E.stackTraceLimit;
    try {
      E.stackTraceLimit = 40;
      const holder: { stack?: unknown } = {};
      E.captureStackTrace(holder, callSite);
      if (typeof holder.stack === 'string') return siteFromStackText(holder.stack);
    } catch {
      // fall back to the structured stack
    } finally {
      E.stackTraceLimit = saved;
    }
  }
  for (const fr of structuredStack()) {
    const raw = fr.getFileName();
    if (!raw) continue;
    const site = resolveFrame(raw, fr.getLineNumber() ?? 0, Math.max(0, (fr.getColumnNumber() ?? 1) - 1));
    if (site) return site;
  }
  return undefined;
}

function siteFromStackText(stack: string): StepSource | undefined {
  for (const text of stack.split('\n')) {
    const m = FRAME_RE.exec(text.trim());
    if (!m) continue;
    const site = resolveFrame(m[1], Number(m[2]), Math.max(0, Number(m[3]) - 1));
    if (site) return site;
  }
  return undefined;
}

const FRAME_RE = /((?:file:\/\/)?(?:[A-Za-z]:)?[^():\s]+(?:\?[^():\s]*)?):(\d+):(\d+)\)?\s*$/;

/** Where a thrown error came from in journey code (read from its stack text; nothing is executed). */
export function errorSite(err: unknown): StepSource | undefined {
  const stack = err instanceof Error ? err.stack : undefined;
  if (typeof stack !== 'string') return undefined;
  return siteFromStackText(stack.split('\n').slice(1).join('\n'));
}

// ------------------------------------------------------------------ source map decoding (VLQ)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64_INDEX.get(ch);
    if (digit === undefined) break;
    value += (digit & 31) << shift;
    if (digit & 32) shift += 5;
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** Decode a v3 source map's `mappings` into per-line segments. Sources are resolved by the caller. */
export function decodeSourceMap(json: { sources: string[]; mappings: string }, resolveSource: (s: string) => string): BundleMap {
  const lines: BundleMap['lines'] = [];
  let src = 0;
  let oLine = 0;
  let oCol = 0;
  for (const lineText of json.mappings.split(';')) {
    const segs: Array<[number, number, number, number]> = [];
    let gCol = 0;
    for (const seg of lineText.split(',')) {
      if (!seg) continue;
      const v = decodeVlq(seg);
      gCol += v[0] ?? 0;
      if (v.length >= 4) {
        src += v[1];
        oLine += v[2];
        oCol += v[3];
        segs.push([gCol, src, oLine, oCol]);
      }
    }
    lines.push(segs);
  }
  return { sources: json.sources.map(resolveSource), lines };
}
