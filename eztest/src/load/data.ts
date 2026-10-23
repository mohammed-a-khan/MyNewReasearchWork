/**
 * Parameterization: data sets from CSV/JSON files, inline rows or SQL
 * queries, handed to virtual users by policy:
 *
 *   order: sequential | random | unique   (unique: a row is used once, across all agents)
 *   scope: iteration | vu | test          (when a new row is taken)
 *   onExhausted: recycle | stopVu | error
 *
 * For distributed runs the controller loads the rows once and gives each
 * agent its slice (row i goes to agent i mod N for sequential/unique; random
 * sets go whole to every agent).
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';
import { parseCsv } from '../docs/csv.js';
import { connectDb, type DbConnectionSpec } from '../surfaces/db.js';
import type { DatasetSpec, Scenario } from './model.js';

export type Row = Record<string, string>;

export class DataExhausted extends EzTestError {
  constructor(readonly dataset: string, readonly stopVu: boolean) {
    super(`data set "${dataset}" is exhausted`, 'LOAD_DATA_EXHAUSTED');
    this.name = 'DataExhausted';
  }
}

export class DataPool {
  private cursor = 0;
  private shared?: Row;

  constructor(readonly name: string, readonly rows: Row[], readonly spec: Pick<DatasetSpec, 'order' | 'scope' | 'onExhausted'>, private readonly random: () => number = Math.random) {
    if (!rows.length) throw new EzTestError(`data set "${name}" has no rows`, 'LOAD_DATA');
  }

  get size(): number {
    return this.rows.length;
  }

  get used(): number {
    return this.cursor;
  }

  /** The next row for a consumer. Throws DataExhausted when a unique/sequential set runs out without recycling. */
  take(): Row {
    if (this.spec.scope === 'test') return (this.shared ??= this.pick());
    return this.pick();
  }

  private pick(): Row {
    if (this.spec.order === 'random') return this.rows[Math.floor(this.random() * this.rows.length)];
    if (this.cursor >= this.rows.length) {
      if (this.spec.onExhausted === 'recycle' && this.spec.order !== 'unique') this.cursor = 0;
      else if (this.spec.onExhausted === 'recycle') this.cursor = 0;
      else throw new DataExhausted(this.name, this.spec.onExhausted === 'stopVu');
    }
    return this.rows[this.cursor++];
  }
}

/** Rows of a data set (file, inline rows or SQL query). */
export async function loadDatasetRows(name: string, spec: DatasetSpec, scenario: Pick<Scenario, 'baseDir' | 'connections'>): Promise<Row[]> {
  if (spec.rows) return spec.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)])));
  if (spec.file) {
    const path = resolve(scenario.baseDir, spec.file);
    const text = await readFile(path, 'utf8');
    if (extname(path).toLowerCase() === '.json') {
      const j = JSON.parse(text) as unknown;
      if (!Array.isArray(j)) throw new EzTestError(`data.${name}: ${spec.file} must hold an array of objects`, 'LOAD_DATA');
      return j.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])));
    }
    return parseCsv(text, { delimiter: spec.delimiter ?? (extname(path).toLowerCase() === '.tsv' ? '\t' : ',') }).rows;
  }
  if (spec.query) {
    const conn = scenario.connections[spec.connection!];
    if (!conn) throw new EzTestError(`data.${name}: unknown connection "${spec.connection}"`, 'LOAD_DATA');
    const db = await connectDb(spec.connection!, resolveConnection(conn, scenario.baseDir));
    try {
      const rows = await db.query(spec.query);
      return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v)])));
    } finally {
      await db.close();
    }
  }
  throw new EzTestError(`data.${name}: no source`, 'LOAD_DATA');
}

/** A connection spec from the scenario (`driver: sqlite|postgres|mssql|oracle`), sqlite paths resolved. */
export function resolveConnection(c: Record<string, unknown>, baseDir: string): DbConnectionSpec {
  const driver = String(c.driver ?? c.type ?? '');
  if (!['sqlite', 'postgres', 'mssql', 'oracle'].includes(driver)) throw new EzTestError(`connection: driver must be sqlite, postgres, mssql or oracle (got "${driver}")`, 'LOAD_SCENARIO');
  const spec = { ...c, driver } as Record<string, unknown>;
  delete spec.type;
  if (driver === 'sqlite' && typeof spec.file === 'string' && spec.file !== ':memory:') spec.file = resolve(baseDir, spec.file);
  for (const [k, v] of Object.entries(spec)) if (typeof v === 'string' && v.startsWith('env:')) spec[k] = process.env[v.slice(4)] ?? '';
  return spec as unknown as DbConnectionSpec;
}

/** Load every data set of a scenario. */
export async function loadAllData(s: Scenario): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const [name, spec] of Object.entries(s.data)) out[name] = await loadDatasetRows(name, spec, s);
  return out;
}

/** The slice of rows agent `index` of `count` receives. */
export function sliceRows(rows: Row[], spec: Pick<DatasetSpec, 'order' | 'scope'>, index: number, count: number): Row[] {
  if (count <= 1 || spec.order === 'random' || spec.scope === 'test') return rows;
  const out = rows.filter((_, i) => i % count === index);
  return out.length ? out : rows.slice(0, 1);
}
