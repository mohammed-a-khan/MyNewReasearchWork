/**
 * Values written in step text, data table cells, doc strings and Examples rows:
 *
 *  - `${name}`, `${a.b.0.c}` and `${name:-default}` read journey, run and config variables;
 *  - `${...}` holding a call (`${unique("VIS-")}`, `${format(addBusinessDays(today(), 2), "MM/DD/YYYY")}`,
 *    `${uuid()}`) is an inline expression, evaluated by EZTest's safe expression evaluator (never JavaScript);
 *  - `$${...}` is a literal `${...}`.
 *
 * Each distinct inline expression is evaluated once per journey attempt: the value is kept in the
 * attempt's expression record, so every step of a scenario sees the same visit reference, and a
 * retry starts fresh. The record is kept in the ledger under {@link EXPRESSIONS_KEY}.
 *
 * A value that is a whole `secret://store/key` reference or an `ENC(...)` value is resolved when the
 * step runs (never earlier) and registered for masking.
 */
import { evaluateExpression, interpolate, unresolvedNames } from '../core/index.js';

/** Ledger key of the attempt's inline-expression record (expression text -> value). */
export const EXPRESSIONS_KEY = '$expressions';

/** Index just past the `}` closing a placeholder body that starts at `i` (quotes and parentheses honoured); -1 when unterminated. */
function closeAt(src: string, i: number): number {
  let quote = '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '}' && depth <= 0) return j;
  }
  return -1;
}

/** True for a placeholder body that is an inline expression (it holds a call). */
export function isInlineExpression(body: string): boolean {
  return body.includes('(');
}

/** The inline expressions (`${...(...)}`, not escaped) of a text, in order. */
export function inlineExpressions(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src.startsWith('$${', i)) {
      const end = closeAt(src, i + 3);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (!src.startsWith('${', i)) continue;
    const end = closeAt(src, i + 2);
    if (end < 0) break;
    const body = src.slice(i + 2, end).trim();
    if (isInlineExpression(body) && !out.includes(body)) out.push(body);
    i = end;
  }
  return out;
}

export interface ExpressionRecord {
  /** Values by expression text (evaluated once per attempt). */
  values: Map<string, unknown>;
  /** Called the first time an expression is evaluated. */
  onEvaluate?: (expression: string, value: unknown) => void;
}

const asText = (v: unknown): string => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The value of an inline expression, evaluated once per record. */
export function expressionValue(body: string, vars: Record<string, unknown>, rec: ExpressionRecord): unknown {
  const key = body.trim();
  if (rec.values.has(key)) return rec.values.get(key);
  const v = evaluateExpression(key, vars);
  rec.values.set(key, v);
  rec.onEvaluate?.(key, v);
  return v;
}

/**
 * Interpolate a text: inline expressions first (cached in `rec`), then `${name}` variables with
 * EZTest's usual rules (unknown names stay as written; `$${` is an escape).
 */
export function interpolateInline(src: string, vars: Record<string, unknown>, rec: ExpressionRecord): string {
  if (!src.includes('${')) return src;
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('$${', i)) {
      const end = closeAt(src, i + 3);
      if (end < 0) return interpolate(out + src.slice(i), vars);
      const body = src.slice(i + 3, end);
      // `$${unique("x")}` is the literal text `${unique("x")}`; `$${name}` is left for interpolate().
      out += isInlineExpression(body) ? src.slice(i + 1, end + 1) : src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (src.startsWith('${', i)) {
      const end = closeAt(src, i + 2);
      if (end < 0) break;
      const body = src.slice(i + 2, end);
      if (isInlineExpression(body)) {
        // The value is literal text: a `${` inside it is escaped so interpolate() leaves it alone.
        out += asText(expressionValue(body, vars, rec)).replace(/\$\{/g, '$${');
      } else out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += src[i++];
  }
  out += src.slice(i);
  return interpolate(out, vars);
}

/** `${name}` placeholders a text uses that nothing sets (inline expressions and `$${` escapes are not names). */
export function missingNames(src: string, vars: Record<string, unknown>): string[] {
  return unresolvedNames(src, vars);
}

/** A whole-value secret reference or encrypted value, resolved when a step uses it. */
export function isSecretValue(v: string): boolean {
  const t = v.trim();
  return /^secret:\/\/[^\s]+$/.test(t) || (t.startsWith('ENC(') && t.endsWith(')'));
}
