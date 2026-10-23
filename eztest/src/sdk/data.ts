/**
 * `data`: the Examples row of a data-driven journey, data files as rows with
 * filters, and records leased from the Test Data Fabric (find, create or
 * generate; released after the run).
 */
import { callSite } from './callsite.js';
import { currentHost, frame } from './runtime.js';
import { files } from './files.js';

export interface LeaseOptions {
  /** Ledger key the record is stored under (default: the entity name in lower camel case). */
  as?: string;
  strategy?: 'find' | 'create' | 'generate' | 'find-or-create';
}

export type RowFilter = Record<string, string | number | boolean> | ((row: Record<string, string>) => boolean);

function matches(row: Record<string, string>, f: RowFilter | undefined): boolean {
  if (!f) return true;
  if (typeof f === 'function') return f(row);
  return Object.entries(f).every(([k, v]) => {
    const key = Object.keys(row).find((c) => c.toLowerCase() === k.toLowerCase());
    return key !== undefined && String(row[key]) === String(v);
  });
}

export const data = {
  /** The current Examples row (empty when the journey is not data-driven). */
  get row(): Record<string, string> {
    return currentHost('data.row').row();
  },
  /** Rows of a data file (csv, xlsx, json), filtered by column values or a predicate. */
  async rows(file: string, o: { sheet?: string | number; where?: RowFilter } = {}): Promise<Array<Record<string, string>>> {
    const all = await files.rows(file, o.sheet !== undefined ? { sheet: o.sheet } : {});
    return all.filter((r) => matches(r, o.where));
  },
  /**
   * A record from the Test Data Fabric (data.entities in config), e.g.
   * `await data.lease('Customer', { region: 'EU', creditLimit: '>10000' })`.
   */
  async lease<T extends Record<string, unknown> = Record<string, unknown>>(entity: string, where: Record<string, string> = {}, o: LeaseOptions = {}): Promise<T> {
    const f = frame('data.lease');
    const as = o.as ?? entity.charAt(0).toLowerCase() + entity.slice(1);
    const source = callSite();
    return f.host.record(`Use data ${entity} as ${as}`, async (r) => {
      const rec = await f.host.lease(entity, where, as, o.strategy);
      r.capture(as, rec);
      return rec as T;
    }, { ...(source ? { source } : {}) });
  },
};

export type DataSurface = typeof data;
