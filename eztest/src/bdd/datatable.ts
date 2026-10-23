/**
 * The data table a step definition receives as its last argument.
 *
 *   | name  | email         |
 *   | Ann   | ann@acme.test |
 *
 *   table.raw()       [['name','email'], ['Ann','ann@acme.test']]
 *   table.rows()      [['Ann','ann@acme.test']]                 (without the header)
 *   table.hashes()    [{ name: 'Ann', email: 'ann@acme.test' }] (header row as keys)
 *   table.rowsHash()  { name: 'email', Ann: 'ann@acme.test' }   (two columns: key | value)
 *   table.transpose() the table turned by 90 degrees
 */
import { EzTestError } from '../core/index.js';

export class DataTable {
  private readonly cells: string[][];

  constructor(cells: string[][]) {
    this.cells = cells.map((r) => [...r]);
  }

  /** Every row, header included. */
  raw(): string[][] {
    return this.cells.map((r) => [...r]);
  }

  /** Rows after the header row. */
  rows(): string[][] {
    return this.cells.slice(1).map((r) => [...r]);
  }

  /** One object per row after the header, keyed by the header cells. */
  hashes(): Array<Record<string, string>> {
    const [header, ...rest] = this.cells;
    if (!header) return [];
    return rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }

  /** A two-column table as key -> value. */
  rowsHash(): Record<string, string> {
    if (this.cells.some((r) => r.length !== 2)) throw new EzTestError(`rowsHash() needs a table with two columns (this one has ${this.cells[0]?.length ?? 0})`, 'BAD_TABLE');
    return Object.fromEntries(this.cells.map((r) => [r[0], r[1]]));
  }

  transpose(): DataTable {
    const width = Math.max(0, ...this.cells.map((r) => r.length));
    return new DataTable(Array.from({ length: width }, (_x, c) => this.cells.map((r) => r[c] ?? '')));
  }

  /** The table as plain arrays (also what JSON.stringify gives). */
  toJSON(): string[][] {
    return this.raw();
  }

  toString(): string {
    const widths = this.cells.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
    return this.cells.map((r) => `| ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`).join('\n');
  }
}
