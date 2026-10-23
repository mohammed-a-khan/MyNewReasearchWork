/**
 * SecretMasker: every secret value EZTest touches is registered here, and
 * every string that leaves the process (logs, errors, reports, prompts) can be
 * passed through mask() first.
 */
import { createConsoleLogger, type Logger, type LogLevel, type SecretStore } from '../core/index.js';

export const MASK = '****';
/** Values shorter than this are not registered; masking them would shred unrelated text. */
export const MIN_SECRET_LENGTH = 3;

export class SecretMasker {
  private readonly values = new Set<string>();
  private sorted: string[] | undefined;

  /** Register a secret value (plus its URL-encoded and base64 forms). Returns the value for chaining. */
  add(value: string | undefined | null): string | undefined | null {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) return value;
    const forms = new Set([value, encodeURIComponent(value), Buffer.from(value, 'utf8').toString('base64')]);
    // JSON-escaped form, so secrets inside JSON.stringify output are caught too.
    forms.add(JSON.stringify(value).slice(1, -1));
    for (const f of forms) {
      if (f.length >= MIN_SECRET_LENGTH && !this.values.has(f)) {
        this.values.add(f);
        this.sorted = undefined;
      }
    }
    return value;
  }

  addAll(values: Iterable<string | undefined | null>): void {
    for (const v of values) this.add(v);
  }

  get size(): number {
    return this.values.size;
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  /** Replace every registered secret in `text` with ****. */
  mask(text: string): string {
    if (this.values.size === 0 || !text) return text;
    if (!this.sorted) this.sorted = [...this.values].sort((a, b) => b.length - a.length);
    let out = text;
    for (const v of this.sorted) {
      if (out.includes(v)) out = out.split(v).join(MASK);
    }
    return out;
  }

  /** Mask all strings inside a JSON-like value (returns a copy). */
  maskDeep<T>(value: T): T {
    return maskDeepInner(value, this, new WeakMap()) as T;
  }

  /** Mask an error's message and stack in place and return it. */
  maskError<E>(err: E): E {
    if (err instanceof Error) {
      err.message = this.mask(err.message);
      if (err.stack) err.stack = this.mask(err.stack);
    }
    return err;
  }

  /** Wrap a SecretStore so every value it returns is registered before anyone sees it. */
  wrapStore(store: SecretStore): SecretStore {
    const self = this;
    return {
      name: store.name,
      async get(key: string) {
        const v = await store.get(key);
        if (v !== undefined) self.add(v);
        return v;
      },
    };
  }
}

function maskDeepInner(value: unknown, m: SecretMasker, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return m.mask(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const v of value) out.push(maskDeepInner(v, m, seen));
    return out;
  }
  if (value instanceof Date || value instanceof Uint8Array) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = maskDeepInner(v, m, seen);
  return out;
}

/** Process-wide masker shared by config, identity and surfaces unless one is injected. */
export const defaultMasker = new SecretMasker();

/** Console logger whose every line goes through the masker. */
export function createMaskedLogger(level: LogLevel = 'info', masker: SecretMasker = defaultMasker): Logger {
  return createConsoleLogger(level, (s) => masker.mask(s));
}
