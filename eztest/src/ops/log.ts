/**
 * Structured JSON logs: one JSON object per line with `ts`, `level`, `msg`
 * and context fields (runId, journeyId, stepId, ...). Secrets never reach the
 * output: fields whose name looks sensitive are replaced, token-shaped values
 * are masked, and an optional masker (the config's secret masker) runs last.
 */
import type { Logger } from '../core/index.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(password|passwd|passphrase|^pass$|^pwd$|secret|token|authorization|cookie|api[-_]?key|^pat$|credential|private[-_]?key|session)/i;
const TOKEN_VALUE = /\b(ezt_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g;

export interface JsonLogger extends Logger {
  child(fields: Record<string, unknown>): JsonLogger;
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  base?: Record<string, unknown>;
  out?: (line: string) => void;
  mask?: (s: string) => string;
  now?: () => Date;
}

export function redact(value: unknown, mask?: (s: string) => string, depth = 0): unknown {
  if (typeof value === 'string') {
    const t = value.replace(TOKEN_VALUE, '[redacted]');
    return mask ? mask(t) : t;
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, mask) };
  if (Array.isArray(value)) return value.map((v) => redact(v, mask, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) && v !== undefined && v !== null && typeof v !== 'boolean' ? '[redacted]' : redact(v, mask, depth + 1);
  return out;
}

export function createJsonLogger(o: JsonLoggerOptions = {}): JsonLogger {
  const min = RANK[o.level ?? 'info'];
  const out = o.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const now = o.now ?? (() => new Date());
  const make = (base: Record<string, unknown>): JsonLogger => {
    const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
      if (RANK[level] < min) return;
      const rec = redact({ ts: now().toISOString(), level, msg, ...base, ...fields }, o.mask) as Record<string, unknown>;
      out(JSON.stringify(rec));
    };
    return {
      log,
      debug: (m, f) => log('debug', m, f as Record<string, unknown>),
      info: (m, f) => log('info', m, f as Record<string, unknown>),
      warn: (m, f) => log('warn', m, f as Record<string, unknown>),
      error: (m, f) => log('error', m, f as Record<string, unknown>),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return make(o.base ?? {});
}
