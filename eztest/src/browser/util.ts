/** Small shared helpers of the browser driver. */
import { TimeoutError } from './errors.js';
import type { URLMatch } from './types.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: Error): void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const d = {
    settled: false,
    promise: new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    resolve: (v: T) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    reject: (e: Error) => {
      if (d.settled) return;
      d.settled = true;
      reject(e);
    },
  };
  // Avoid unhandled-rejection noise for deferreds nobody awaits.
  d.promise.catch(() => undefined);
  return d;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Race a promise against a timeout (0 = no timeout). */
export function withTimeout<T>(p: Promise<T>, ms: number, message: () => string): Promise<T> {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return p;
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(message())), ms);
    }),
  ]);
}

/**
 * Wait for `p` at most `ms`: resolves to its value, or to `onTimeout`. The timer is cleared when
 * `p` settles first, so a grace period never keeps the process alive after the wait is over.
 */
export async function settleWithin<T, U>(p: Promise<T>, ms: number, onTimeout: U): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<U>((r) => { timer = setTimeout(() => r(onTimeout), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** A point in time after which an operation gives up. */
export class Deadline {
  readonly end: number;
  constructor(readonly timeout: number) {
    this.end = timeout > 0 ? Date.now() + timeout : Number.POSITIVE_INFINITY;
  }
  remaining(): number {
    return Math.max(0, this.end - Date.now());
  }
  expired(): boolean {
    return Date.now() >= this.end;
  }
}

/** Poll intervals for retry loops: quick first, then steady. */
export function pollDelay(attempt: number): number {
  return [0, 20, 50, 100, 100, 250][attempt] ?? 250;
}

/** Convert a URL glob to a RegExp: `*` = any chars except '/', `**` = anything, `?` literal, `{a,b}` alternatives. */
export function globToRegex(glob: string): RegExp {
  let re = '^';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      re += `\\${glob[++i]}`;
      continue;
    }
    if (c === '*') {
      const before = glob[i - 1];
      let stars = 1;
      while (glob[i + 1] === '*') {
        stars++;
        i++;
      }
      const after = glob[i + 1];
      if (stars > 1 && (before === undefined || before === '/') && (after === undefined || after === '/')) {
        re += '((?:[^/]*(?:/|$))*)';
        if (after === '/') i++;
      } else if (stars > 1) re += '.*';
      else re += '([^/]*)';
      continue;
    }
    if (c === '{') {
      inGroup = true;
      re += '(';
      continue;
    }
    if (c === '}' && inGroup) {
      inGroup = false;
      re += ')';
      continue;
    }
    if (c === ',' && inGroup) {
      re += '|';
      continue;
    }
    re += /[.+?^$()|[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${re}$`);
}

/** Does `url` match a route / waitForURL pattern (relative globs resolved against baseURL)? */
export function urlMatches(baseURL: string | undefined, url: string, match: URLMatch | undefined): boolean {
  if (match === undefined || match === '') return true;
  if (typeof match === 'string') {
    let pattern = match;
    if (baseURL && !/^[a-z][a-z0-9+.-]*:|^\*/i.test(pattern)) {
      try {
        pattern = new URL(pattern, baseURL).href;
      } catch {
        /* keep as is */
      }
    }
    if (!pattern.includes('*') && !pattern.includes('{')) {
      if (url === pattern) return true;
      // A URL without query/hash matches the same URL with a trailing slash difference only.
      try {
        return new URL(url).href === new URL(pattern).href;
      } catch {
        return false;
      }
    }
    return globToRegex(pattern).test(url);
  }
  if (match instanceof RegExp) {
    match.lastIndex = 0;
    return match.test(url);
  }
  try {
    return !!match(new URL(url));
  } catch {
    return false;
  }
}

/** Header list -> lower-cased record (repeated headers joined; set-cookie with \n). */
export function headersToObject(headers: Array<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of headers) {
    const k = name.toLowerCase();
    if (k in out) out[k] = k === 'set-cookie' ? `${out[k]}\n${value}` : `${out[k]}, ${value}`;
    else out[k] = value;
  }
  return out;
}

/** CDP header object (name -> value, multiple values joined by \n) -> array. */
export function headersFromProtocol(h: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [name, value] of Object.entries(h ?? {})) {
    for (const v of String(value).split('\n')) out.push({ name, value: v });
  }
  return out;
}

export function isRegExp(v: unknown): v is RegExp {
  return v instanceof RegExp || Object.prototype.toString.call(v) === '[object RegExp]';
}

/** Escape for use inside a description: JSON-like quoting. */
export function quote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** MIME type guess from a file name (enough for fulfill({path}) and setInputFiles). */
export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
    txt: 'text/plain', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip', wasm: 'application/wasm',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
    wav: 'audio/wav', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    md: 'text/markdown', yaml: 'application/yaml', yml: 'application/yaml',
  };
  return map[ext] ?? 'application/octet-stream';
}
