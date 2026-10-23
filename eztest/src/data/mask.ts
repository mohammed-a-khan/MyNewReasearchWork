/**
 * Deterministic masking for subsetting production-like data: the same input
 * (and salt) always masks to the same output, so joins across tables still work.
 */
import { createHash, createHmac } from 'node:crypto';
import { NotSupportedError } from '../core/index.js';

export type MaskRule =
  | 'redact'
  | 'hash'
  | 'null'
  | 'email'
  | { type: 'partial'; keepStart?: number; keepEnd?: number; char?: string }
  | { type: 'fixed'; value: unknown }
  | { type: 'hash'; length?: number };

export interface MaskOptions {
  /** HMAC key for hashes. Without it, hashes are plain SHA-256 (guessable for small domains). */
  salt?: string;
}

function digest(v: string, o: MaskOptions): string {
  return o.salt ? createHmac('sha256', o.salt).update(v).digest('hex') : createHash('sha256').update(v).digest('hex');
}

export function maskValue(value: unknown, rule: MaskRule, o: MaskOptions = {}): unknown {
  if (value === null || value === undefined) return value;
  const s = value instanceof Date ? value.toISOString() : String(value);
  if (typeof rule === 'string') {
    switch (rule) {
      case 'redact':
        return '[REDACTED]';
      case 'null':
        return null;
      case 'hash':
        return digest(s, o).slice(0, 16);
      case 'email':
        return `user-${digest(s.toLowerCase(), o).slice(0, 10)}@example.com`;
      default:
        throw new NotSupportedError(`mask rule "${String(rule)}"`);
    }
  }
  switch (rule.type) {
    case 'partial': {
      const ks = rule.keepStart ?? 0;
      const ke = rule.keepEnd ?? 4;
      const ch = rule.char ?? '*';
      const chars = [...s];
      if (chars.length <= ks + ke) return ch.repeat(chars.length);
      return chars.slice(0, ks).join('') + ch.repeat(chars.length - ks - ke) + (ke ? chars.slice(-ke).join('') : '');
    }
    case 'fixed':
      return rule.value;
    case 'hash':
      return digest(s, o).slice(0, rule.length ?? 16);
    default:
      throw new NotSupportedError(`mask rule "${(rule as { type: string }).type}"`);
  }
}

export function maskRecord<T extends Record<string, unknown>>(record: T, rules: Record<string, MaskRule>, o: MaskOptions = {}): T {
  const out: Record<string, unknown> = { ...record };
  for (const [field, rule] of Object.entries(rules)) {
    if (field in out) out[field] = maskValue(out[field], rule, o);
  }
  return out as T;
}

export function maskRows<T extends Record<string, unknown>>(rows: T[], rules: Record<string, MaskRule>, o: MaskOptions = {}): T[] {
  return rows.map((r) => maskRecord(r, rules, o));
}
