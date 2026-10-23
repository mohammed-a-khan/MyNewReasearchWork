/**
 * Case-insensitive result rows. Oracle folds unquoted column names to UPPER
 * CASE, PostgreSQL to lower case, and SQL Server keeps them as written. A row
 * keeps the column names exactly as the database returned them (Object.keys,
 * JSON, reports), but reading a column works with any casing:
 *
 *   row.ACCOUNT_ID === row.account_id === row.Account_Id
 *   'account_id' in row  // true
 */

const MARK = Symbol.for('eztest.caseInsensitiveRow');

function findKey(target: object, prop: string): string | undefined {
  if (prop in target) return prop;
  const lower = prop.toLowerCase();
  for (const k of Object.keys(target)) if (k.toLowerCase() === lower) return k;
  return undefined;
}

export function isCaseInsensitiveRow(v: unknown): boolean {
  return !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[MARK] === true;
}

/** Wrap a plain row so property reads and `in` ignore case. Keys and values are unchanged. */
export function caseInsensitiveRow<T extends Record<string, unknown>>(row: T): T {
  if (!row || typeof row !== 'object' || isCaseInsensitiveRow(row)) return row;
  return new Proxy(row, {
    get(t, p, r) {
      if (p === MARK) return true;
      if (typeof p === 'string' && !(p in t)) {
        const k = findKey(t, p);
        if (k !== undefined) return (t as Record<string, unknown>)[k];
      }
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (typeof p === 'string' && !(p in t)) return findKey(t, p) !== undefined;
      return Reflect.has(t, p);
    },
    // Object.hasOwn(row, 'name') holds for NAME too (expressions use it); Object.keys/JSON still list the real keys only.
    getOwnPropertyDescriptor(t, p) {
      if (typeof p === 'string' && !Object.prototype.hasOwnProperty.call(t, p)) {
        const k = findKey(t, p);
        const d = k === undefined ? undefined : Reflect.getOwnPropertyDescriptor(t, k);
        if (d) return { ...d, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
  });
}

export function caseInsensitiveRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => caseInsensitiveRow(r));
}

/** Read a column from any row (plain or wrapped) ignoring case; exact matches win. */
export function getColumn(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  const k = findKey(row, column);
  return k === undefined ? undefined : row[k];
}

/** Whether a row has a column, ignoring case. */
export function hasColumn(row: Record<string, unknown>, column: string): boolean {
  return column in row || findKey(row, column) !== undefined;
}

/** A value as JSON-friendly data: bigint -> number (or string when unsafe), bytes -> base64 marker, Date -> ISO. */
export function jsonFriendly(v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return v;
}
