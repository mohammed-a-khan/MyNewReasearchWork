/**
 * Redaction for trace capture. Everything a trace records passes through a
 * `Redactor`: the configured SecretMasker, values the run learned are secret
 * (anything typed into a password field), and key-based rules for headers,
 * query parameters, form fields and JSON keys.
 */
import { SecretMasker } from '../../config/masker.js';

export const REDACTED = '****';

/** Headers that are always redacted. */
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token']);
const SECRET_HEADER_RE = /token|secret|api[-_]?key|auth|session|signature/i;
/** Form fields, JSON keys and query parameters whose values are redacted. */
export const SECRET_FIELD_RE = /pass(?:word|wd|phrase)?|secret|token|api[-_]?key|otp|one[-_]?time|cvv|cvc|credential|signature|^sig$|^pin$|^code$|session|private[-_]?key|access[-_]?key/i;

export interface Masker {
  mask(text: string): string;
}

export class Redactor {
  /** Values learned during the run (e.g. typed into password inputs). */
  readonly learned = new SecretMasker();

  constructor(private readonly masker?: Masker) {}

  /** Register a value that must never appear in the trace. */
  learn(value: string | undefined): void {
    if (value) this.learned.add(value);
  }

  mask(text: string): string {
    if (!text) return text;
    let out = this.masker ? this.masker.mask(text) : text;
    out = this.learned.mask(out);
    return out;
  }

  maskOpt(text: string | undefined): string | undefined {
    return text === undefined ? undefined : this.mask(text);
  }

  headers(h: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h ?? {})) {
      const lk = k.toLowerCase();
      out[k] = SECRET_HEADERS.has(lk) || SECRET_HEADER_RE.test(lk) ? REDACTED : this.mask(v);
    }
    return out;
  }

  url(raw: string): string {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return this.mask(raw);
    }
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const k of [...new Set(u.searchParams.keys())]) {
      if (SECRET_FIELD_RE.test(k)) u.searchParams.set(k, REDACTED);
    }
    if (u.hash && /(?:access_token|id_token|token)=/i.test(u.hash)) u.hash = '#****';
    return this.mask(u.toString());
  }

  /** Redact a request/response body by content type, then mask. */
  body(text: string, contentType = ''): string {
    const ct = contentType.toLowerCase();
    let out = text;
    if (ct.includes('application/x-www-form-urlencoded')) {
      const p = new URLSearchParams(text);
      for (const k of [...new Set(p.keys())]) if (SECRET_FIELD_RE.test(k)) p.set(k, REDACTED);
      out = p.toString();
    } else if (ct.includes('json')) {
      try {
        out = JSON.stringify(redactJson(JSON.parse(text)));
      } catch {
        out = text;
      }
    } else if (ct.includes('multipart/form-data')) {
      out = text.replace(/(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/g, (whole, head: string, name: string) =>
        SECRET_FIELD_RE.test(name) ? `${head}${REDACTED}` : whole,
      );
    }
    return this.mask(out);
  }

  /** Mask every string in a JSON-like value; values under secret-looking keys are replaced. */
  deep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown, key?: string): unknown {
    if (typeof v === 'string') return key && SECRET_FIELD_RE.test(key) ? REDACTED : this.mask(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.walk(x, k)]));
    return v;
  }
}

function redactJson(v: unknown, key?: string): unknown {
  if (key && SECRET_FIELD_RE.test(key) && (typeof v === 'string' || typeof v === 'number')) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => redactJson(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactJson(x, k)]));
  return v;
}
