/**
 * DataNeed `where` constraints: "EU" or "=EU", "!=US", ">10000", ">=5", "<5",
 * "<=5", "~Contoso" (contains) or "~Con%" (SQL LIKE pattern). To match a literal
 * value that starts with an operator character, prefix it with "=" ("=>x").
 */
import { EzTestError } from '../core/index.js';
import type { SqlDialect, SqlValue } from '../surfaces/index.js';

export type ConstraintOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~';

export interface Constraint {
  field: string;
  op: ConstraintOp;
  value: string;
}

const OPS: ConstraintOp[] = ['>=', '<=', '!=', '=', '>', '<', '~'];
const NUMERIC_RE = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function parseConstraint(field: string, raw: string): Constraint {
  if (!field) throw new EzTestError('Constraint field name is empty', 'DATA_CONSTRAINT');
  if (typeof raw !== 'string') throw new EzTestError(`Constraint for ${field} must be a string`, 'DATA_CONSTRAINT');
  const s = raw.trim();
  for (const op of OPS) {
    if (s.startsWith(op)) {
      const value = s.slice(op.length).trim();
      if (value === '' && op !== '=' && op !== '!=') throw new EzTestError(`Constraint ${field} "${raw}" has no value after "${op}"`, 'DATA_CONSTRAINT');
      if ((op === '>' || op === '>=' || op === '<' || op === '<=') && !NUMERIC_RE.test(value) && !ISO_DATE_RE.test(value)) {
        throw new EzTestError(`Constraint ${field} "${raw}": "${op}" needs a number or an ISO date`, 'DATA_CONSTRAINT');
      }
      return { field, op, value };
    }
  }
  return { field, op: '=', value: s };
}

export function parseWhere(where: Record<string, string> = {}): Constraint[] {
  return Object.entries(where).map(([f, v]) => parseConstraint(f, v));
}

export function describeConstraints(cs: Constraint[]): string {
  return cs.length ? cs.map((c) => `${c.field} ${c.op === '~' ? 'like' : c.op} ${c.value}`).join(', ') : '(no constraints)';
}

function likeToRegex(pattern: string): RegExp {
  const p = /[%_]/.test(pattern) ? pattern : `%${pattern}%`;
  const re = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${re}$`, 'is');
}

function cmp(a: unknown, b: string): number | undefined {
  if (typeof a === 'number' || typeof a === 'bigint' || (typeof a === 'string' && NUMERIC_RE.test(a))) {
    if (!NUMERIC_RE.test(b)) return undefined;
    return Number(a) - Number(b);
  }
  const ad = a instanceof Date ? a.getTime() : typeof a === 'string' && ISO_DATE_RE.test(a) ? Date.parse(a) : NaN;
  const bd = ISO_DATE_RE.test(b) ? Date.parse(b) : NaN;
  if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
  return undefined;
}

/** Evaluate a constraint against a value in memory (API and synthetic providers, and as a safety check). */
export function matchesConstraint(value: unknown, c: Constraint): boolean {
  switch (c.op) {
    case '=':
    case '!=': {
      let eq: boolean;
      if (value === null || value === undefined) eq = c.value === '';
      else {
        const n = cmp(value, c.value);
        eq = n !== undefined ? n === 0 : String(value) === c.value;
      }
      return c.op === '=' ? eq : !eq;
    }
    case '~':
      return value !== null && value !== undefined && likeToRegex(c.value).test(String(value));
    default: {
      if (value === null || value === undefined) return false;
      const n = cmp(value, c.value);
      if (n === undefined) return false;
      return c.op === '>' ? n > 0 : c.op === '>=' ? n >= 0 : c.op === '<' ? n < 0 : n <= 0;
    }
  }
}

export function matchesAll(record: Record<string, unknown>, cs: Constraint[]): boolean {
  return cs.every((c) => matchesConstraint(record[c.field], c));
}

/** A value that satisfies the constraint, used when creating records. Undefined for "!=". */
export function satisfyingValue(c: Constraint): string | number | undefined {
  const num = NUMERIC_RE.test(c.value) ? Number(c.value) : undefined;
  const isInt = num !== undefined && Number.isInteger(num);
  switch (c.op) {
    case '=':
      return c.value;
    case '!=':
      return undefined;
    case '~':
      return c.value.replace(/%/g, '').replace(/_/g, 'x');
    case '>=':
    case '<=':
      return num ?? c.value;
    case '>':
      if (num !== undefined) return isInt ? num + 1 : num + 0.01;
      return new Date(Date.parse(c.value) + 86_400_000).toISOString().slice(0, c.value.length > 10 ? undefined : 10);
    case '<':
      if (num !== undefined) return isInt ? num - 1 : num - 0.01;
      return new Date(Date.parse(c.value) - 86_400_000).toISOString().slice(0, c.value.length > 10 ? undefined : 10);
    default:
      return undefined;
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Quote a SQL identifier after strict validation (identifiers cannot be bound as parameters). */
export function quoteIdent(name: string, dialect: SqlDialect): string {
  const parts = name.split('.');
  for (const p of parts) if (!IDENT_RE.test(p)) throw new EzTestError(`Invalid SQL identifier "${name}"`, 'DATA_IDENTIFIER');
  return parts.map((p) => (dialect === 'mssql' ? `[${p}]` : `"${p}"`)).join('.');
}

export function placeholder(dialect: SqlDialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : dialect === 'mssql' ? `@p${index}` : '?';
}

/** Build a parameterized WHERE clause. Values are always bound; never spliced. */
export function toSqlWhere(cs: Constraint[], columnFor: (field: string) => string, dialect: SqlDialect, startIndex = 1): { sql: string; params: SqlValue[] } {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  let i = startIndex;
  for (const c of cs) {
    const col = quoteIdent(columnFor(c.field), dialect);
    if ((c.op === '=' || c.op === '!=') && c.value === '') {
      parts.push(c.op === '=' ? `(${col} IS NULL OR ${col} = ${placeholder(dialect, i++)})` : `(${col} IS NOT NULL AND ${col} <> ${placeholder(dialect, i++)})`);
      params.push('');
      continue;
    }
    if (c.op === '~') {
      const pattern = /[%_]/.test(c.value) ? c.value : `%${c.value}%`;
      parts.push(dialect === 'postgres' ? `${col} ILIKE ${placeholder(dialect, i++)}` : `${col} LIKE ${placeholder(dialect, i++)}`);
      params.push(pattern);
      continue;
    }
    const sqlOp = c.op === '!=' ? '<>' : c.op;
    const v: SqlValue = c.op !== '=' && c.op !== '!=' && NUMERIC_RE.test(c.value) ? Number(c.value) : c.value;
    parts.push(`${col} ${sqlOp} ${placeholder(dialect, i++)}`);
    params.push(v);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}
