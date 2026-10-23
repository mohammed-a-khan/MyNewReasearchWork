/**
 * Grid operations over any detected grid adapter: rows are found by their
 * cell values (never by position), virtualized content is scrolled, paged
 * content is paged, and every write is verified by reading the grid back.
 */
import type { Locator } from '../../browser/index.js';
import { sleep } from '../../core/index.js';
import { ComponentError } from './engine.js';
import { detectAdapter } from './registry.js';
import type { CellCondition, ComponentAdapter, ComponentReport, GridColumn, GridDialect, GridReadResult, GridRow } from './types.js';
import { DEFAULT_BUDGET, DEFAULT_TIMEOUT, describeWhere, isSorted, ms, normText, poll, sameValue, Scope, type OpOptions } from './util.js';

interface ScanResult {
  columns: GridColumn[];
  total: number;
  matches: GridRow[];
  matchCount: number;
  rows?: GridRow[];
  truncated: boolean;
  steps: number;
  gaps: number;
  virtualized: boolean;
  ms: number;
}

interface Reveal {
  found: boolean;
  key: string;
  index: number;
  rows: string[];
  cells: Record<string, string>;
  row: GridRow;
  columns: GridColumn[];
}

interface RowNow extends GridRow {
  found: boolean;
  byId: Record<string, string>;
  selected?: boolean;
  checked?: boolean;
  expanded?: boolean;
}

export interface FoundRow {
  row: GridRow;
  page: number;
  scanned: number;
  pages: number;
  virtualized: boolean;
}

export interface FindOptions {
  /** Take the first matching row instead of requiring exactly one. */
  first?: boolean;
}

/** A grid widget bound to its adapter. */
export class Grid {
  readonly timeout: number;
  readonly budget: number;
  private page = 1;

  private constructor(
    readonly loc: Locator,
    readonly adapter: ComponentAdapter<GridDialect>,
    readonly scope: Scope,
    opts: OpOptions,
  ) {
    this.timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    this.budget = opts.budgetMs ?? DEFAULT_BUDGET;
  }

  get d(): GridDialect {
    return this.adapter.dialect;
  }

  /** Detect the grid at `loc` and wait until it has rendered (not busy). */
  static async open(loc: Locator, opts: OpOptions = {}): Promise<Grid> {
    const scope = await Scope.of(loc, opts.timeoutMs);
    await scope.call('clearMarks');
    const adapter = await detectAdapter<GridDialect>('grid', scope.loc, opts.adapter);
    const g = new Grid(loc, adapter, scope, opts);
    await g.waitReady();
    return g;
  }

  private state(): Promise<{ columns: GridColumn[]; rows: number; sig: string; busy: boolean; scrollable: boolean }> {
    return this.scope.call('gridState', { d: this.d });
  }

  async waitReady(): Promise<void> {
    let emptySince = 0;
    const ok = await poll(async () => {
      const s = await this.state();
      if (s.busy || !s.columns.length) return undefined;
      if (s.rows > 0) return true;
      emptySince ||= Date.now();
      return Date.now() - emptySince > 400 ? true : undefined;
    }, this.timeout, 60);
    if (!ok) throw new ComponentError(`the ${this.adapter.label} grid did not finish loading within ${this.timeout} ms`, 'COMPONENT_NOT_READY');
  }

  async columns(): Promise<GridColumn[]> {
    return this.scope.call<GridColumn[]>('gridColumns', { d: this.d }, this.timeout);
  }

  /** Resolve a header text to a column (exact, then case-insensitive). */
  async column(header: string): Promise<GridColumn> {
    const cols = await this.columns();
    const n = normText(header);
    const hit = cols.filter((c) => c.text === n);
    const ci = hit.length ? hit : cols.filter((c) => c.text.toLowerCase() === n.toLowerCase());
    if (ci.length === 1) return ci[0];
    throw new ComponentError(ci.length ? `column "${header}" is ambiguous` : `no column "${header}" (columns: ${cols.filter((c) => c.text).map((c) => `"${c.text}"`).join(', ')})`, 'COMPONENT_NO_COLUMN');
  }

  private async pager(): Promise<{ pager: boolean; next: string | null; more: string | null; first: string | null; prev: string | null; error?: string }> {
    return this.scope.call('gridPager', { d: this.d });
  }

  private async waitChange(before: string, rowsBefore: number, grow: boolean): Promise<void> {
    const ok = await poll(async () => {
      const s = await this.state();
      if (s.busy) return undefined;
      if (grow ? s.rows > rowsBefore : s.sig !== before) return true;
      return undefined;
    }, this.timeout, 50);
    if (!ok) throw new ComponentError('the grid did not change page', 'COMPONENT_PAGING');
    await sleep(30);
  }

  /** Go back to the first page of a paged grid. */
  private async toFirstPage(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const p = await this.pager();
      if (!p.pager) return;
      const target = p.first ?? p.prev;
      if (!target) break;
      const s = await this.state();
      await this.scope.el(target, 'pager button').click({ timeout: this.timeout });
      await this.waitChange(s.sig, s.rows, false);
      if (p.first) break;
    }
    this.page = 1;
  }

  private async nextPage(): Promise<boolean> {
    const p = await this.pager();
    const t = p.next ?? p.more;
    if (!p.pager || !t) return false;
    const s = await this.state();
    await this.scope.el(t, 'next page button').click({ timeout: this.timeout });
    await this.waitChange(s.sig, s.rows, !p.next && !!p.more);
    this.page++;
    return true;
  }

  /** Scan every row (scrolling and paging) collecting matches of `where`, or all rows with collect. */
  async scan(where: CellCondition[], opts: { collect?: boolean; first?: boolean; maxRows?: number; countOnly?: boolean } = {}): Promise<{ matches: Array<GridRow & { page: number }>; matchCount: number; rows: GridRow[]; total: number; pages: number; virtualized: boolean; columns: GridColumn[]; ms: number; truncated: boolean }> {
    const t0 = Date.now();
    const deadline = t0 + this.budget;
    const p0 = await this.pager();
    if (p0.pager && (p0.first || p0.prev)) await this.toFirstPage();
    const seen = new Set<string>();
    const matches: Array<GridRow & { page: number }> = [];
    const rows: GridRow[] = [];
    let total = 0;
    let matchCount = 0;
    let lastPageMatches = 0;
    let pages = 0;
    let virtualized = false;
    let truncated = false;
    let columns: GridColumn[] = [];
    for (;;) {
      pages++;
      const left = Math.max(1000, deadline - Date.now());
      const r = await this.scope.call<ScanResult>('gridScan', {
        d: this.d, where, collect: opts.collect, first: opts.first, budgetMs: left, maxRows: opts.maxRows, page: this.page, countOnly: opts.countOnly,
      }, left + this.timeout);
      columns = r.columns;
      virtualized ||= r.virtualized;
      matchCount += r.matchCount;
      lastPageMatches = r.matchCount;
      for (const m of r.matches) {
        if (seen.has(`m:${m.key}`)) continue;
        seen.add(`m:${m.key}`);
        matches.push({ ...m, page: this.page });
      }
      if (opts.collect && r.rows) for (const row of r.rows) if (!seen.has(`r:${row.key}`)) {
        seen.add(`r:${row.key}`);
        rows.push(row);
      }
      total += r.total;
      if (r.truncated) {
        truncated = true;
        break;
      }
      if (opts.first && matches.length) break;
      if (opts.maxRows && (opts.collect ? rows.length : total) >= opts.maxRows) break;
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      if (!(await this.nextPage())) break;
    }
    // A load-more grid re-reads earlier rows on every page: its last read holds them all.
    const growing = !!(p0.more || (p0.pager && (await this.pager()).more) || (pages > 1 && !p0.next && !p0.first && !p0.prev && p0.pager));
    if (growing) {
      total = new Set([...rows.map((r) => r.key), ...matches.map((m) => m.key)]).size || total;
      matchCount = lastPageMatches;
    }
    return { matches, matchCount, rows, total, pages, virtualized, columns, ms: ms(t0), truncated };
  }

  /** Find the one row matching `where` (all pages, all virtualized rows). */
  async findRow(where: CellCondition[], opts: FindOptions = {}): Promise<FoundRow> {
    if (!where.length) throw new ComponentError('name the row by at least one cell value (where Column is "value")', 'COMPONENT_NO_ROW');
    const r = await this.scan(where, { first: opts.first });
    if (r.truncated && !(opts.first && r.matches.length)) {
      throw new ComponentError(`stopped scanning the grid after ${r.ms} ms (${r.total} rows read); raise the step timeout or filter the grid first`, 'COMPONENT_BUDGET');
    }
    if (!r.matches.length) {
      throw new ComponentError(`no row where ${describeWhere(where)} (read ${r.total} rows${r.pages > 1 ? ` on ${r.pages} pages` : ''}${r.virtualized ? ', scrolling the virtualized grid' : ''})`, 'COMPONENT_NO_ROW');
    }
    if (r.matchCount > 1 && !opts.first) {
      throw new ComponentError(`${r.matchCount} rows match where ${describeWhere(where)} (row keys ${r.matches.slice(0, 5).map((m) => m.key).join(', ')}${r.matches.length > 5 ? ', ...' : ''}); add a condition so exactly one row matches, or say "the first row where"`, 'COMPONENT_AMBIGUOUS_ROW');
    }
    const m = r.matches[0];
    const { page, ...row } = m;
    return { row, page, scanned: r.total, pages: r.pages, virtualized: r.virtualized };
  }

  private async gotoPage(page: number): Promise<void> {
    if (page === this.page) return;
    await this.toFirstPage();
    while (this.page < page) if (!(await this.nextPage())) throw new ComponentError(`could not get back to page ${page}`, 'COMPONENT_PAGING');
  }

  /** Bring a found row into view and mark its cells. */
  async reveal(found: FoundRow, column?: GridColumn): Promise<Reveal> {
    await this.gotoPage(found.page);
    const r = await this.scope.call<Reveal>('gridReveal', { d: this.d, key: found.row.key, index: found.row.index, page: this.page, ...(column ? { colId: column.id } : {}) }, this.budget);
    if (!r.found) throw new ComponentError(`row ${found.row.key} disappeared before it could be used`, 'COMPONENT_NO_ROW');
    return r;
  }

  async rowNow(key: string): Promise<RowNow> {
    return this.scope.call<RowNow>('gridRowNow', { d: this.d, key, page: this.page });
  }

  /** The cell of a revealed row to click for the row as a whole (first visible column with a header). */
  private rowCell(rv: Reveal, column?: GridColumn): string {
    if (column) {
      const t = rv.cells[column.id];
      if (!t) throw new ComponentError(`row ${rv.key} has no "${column.text}" cell on screen`, 'COMPONENT');
      return t;
    }
    const col = rv.columns.find((c) => c.text && rv.cells[c.id]);
    if (!col) throw new ComponentError(`row ${rv.key} has no cells to click`, 'COMPONENT');
    return rv.cells[col.id];
  }

  private report(op: string, found: FoundRow | undefined, verified: string, t0: number, extra: Partial<ComponentReport> = {}): ComponentReport {
    return {
      kind: 'grid', adapter: this.d.id, library: this.adapter.id, op, verified, ms: ms(t0),
      ...(found ? { rowKey: found.row.key, row: found.row, details: { page: found.page, pages: found.pages, scanned: found.scanned, virtualized: found.virtualized } } : {}),
      ...extra,
    };
  }

  async clickRow(where: CellCondition[], opts: FindOptions & { button?: 'left' | 'right'; double?: boolean } = {}): Promise<ComponentReport> {
    const t0 = Date.now();
    const found = await this.findRow(where, opts);
    const rv = await this.reveal(found);
    const cell = this.scope.el(this.rowCell(rv), 'row cell');
    if (opts.double) await cell.dblclick({ timeout: this.timeout });
    else await cell.click({ timeout: this.timeout, ...(opts.button === 'right' ? { button: 'right' as const } : {}) });
    return this.report(opts.double ? 'doubleClickRow' : 'clickRow', found, `row where ${describeWhere(where)} found by its values (key ${found.row.key}) and ${opts.double ? 'double-clicked' : 'clicked'}`, t0);
  }

  async clickInRow(where: CellCondition[], name: string, opts: FindOptions = {}): Promise<ComponentReport> {
    const t0 = Date.now();
    const found = await this.findRow(where, opts);
    const rv = await this.reveal(found);
    const c = await this.scope.call<{ tag?: string; error?: string }>('gridRowControl', { d: this.d, rows: rv.rows, what: 'name', name });
    if (!c.tag) throw new ComponentError(`${c.error} (row where ${describeWhere(where)})`, 'COMPONENT_NO_CONTROL');
    await this.scope.el(c.tag).click({ timeout: this.timeout });
    return this.report('clickInRow', found, `clicked "${name}" in the row where ${describeWhere(where)} (key ${found.row.key})`, t0);
  }

  async readCell(where: CellCondition[], column: string, opts: FindOptions = {}): Promise<ComponentReport> {
    const t0 = Date.now();
    const col = await this.column(column);
    const found = await this.findRow(where, opts);
    const v = found.row.cells[col.text];
    if (v === undefined) throw new ComponentError(`row ${found.row.key} has no "${col.text}" value`, 'COMPONENT');
    return this.report('readCell', found, `read ${col.text} = "${v}" of the row where ${describeWhere(where)}`, t0, { value: v });
  }

  async editCell(where: CellCondition[], column: string, value: string, opts: FindOptions = {}): Promise<ComponentReport> {
    const t0 = Date.now();
    const col = await this.column(column);
    const found = await this.findRow(where, opts);
    const rv = await this.reveal(found, col);
    const cell = this.scope.el(this.rowCell(rv, col), 'cell');
    const trigger = this.d.editTrigger ?? 'dblclick';
    type Ed = { found: boolean; tag?: string; tag2?: string; contenteditable?: boolean };
    const findEditor = () => this.scope.call<Ed>('gridEditor', { d: this.d, cell: rv.cells[col.id] });
    let ed: Ed | undefined;
    if (trigger === 'none') ed = await findEditor();
    else {
      if (trigger === 'click') await cell.click({ timeout: this.timeout });
      else if (trigger === 'enter') {
        await cell.click({ timeout: this.timeout });
        await cell.press('Enter', { timeout: this.timeout });
      } else await cell.dblclick({ timeout: this.timeout });
      ed = await poll(async () => {
        const e = await findEditor();
        return e.found ? e : undefined;
      }, Math.min(this.timeout, 3000));
      if (!ed && trigger !== 'enter') {
        // Some grids open their editor on Enter or F2 only.
        await cell.press('Enter', { timeout: this.timeout }).catch(() => undefined);
        ed = await poll(async () => {
          const e = await findEditor();
          return e.found ? e : undefined;
        }, 1500);
      }
    }
    if (!ed?.found || !ed.tag) throw new ComponentError(`the "${col.text}" cell of the row where ${describeWhere(where)} did not open an editor (${this.adapter.label})`, 'COMPONENT_NOT_EDITABLE');
    const input = this.scope.el(ed.tag, 'cell editor');
    if (ed.tag2 === 'select') await input.selectOption({ label: value }, { timeout: this.timeout });
    else if (ed.contenteditable) {
      await input.click({ timeout: this.timeout });
      await input.press('ControlOrMeta+a');
      await input.pressSequentially(value);
    } else await input.fill(value, { timeout: this.timeout });
    await input.press(this.d.editCommit ?? 'Enter', { timeout: this.timeout }).catch(() => undefined);
    // Verify: the cell now shows the value (read back from the grid, not from the editor).
    let last = '';
    const ok = await poll(async () => {
      const now = await this.rowNow(found.row.key);
      if (!now.found) return undefined;
      last = now.byId[col.id] ?? '';
      const editing = await this.scope.call<Ed>('gridEditor', { d: this.d, cell: rv.cells[col.id] }).catch(() => ({ found: false }) as Ed);
      return sameValue(last, value) && !editing.found ? true : undefined;
    }, this.timeout, 60);
    if (!ok) throw new ComponentError(`after editing, ${col.text} of the row where ${describeWhere(where)} shows "${last}", not "${value}"`, 'COMPONENT_VERIFY');
    return this.report('editCell', found, `${col.text} of the row where ${describeWhere(where)} (key ${found.row.key}) now shows "${last}"`, t0, { value: last });
  }

  async sort(column: string, order: 'asc' | 'desc'): Promise<ComponentReport> {
    const t0 = Date.now();
    if (this.d.sortable === false) throw new ComponentError(`${this.adapter.label} has no built-in column sorting`, 'NOT_SUPPORTED');
    type H = { id: string; text: string; state: 'asc' | 'desc' | 'none'; tag: string };
    const header = () => this.scope.call<H>('gridHeader', { d: this.d, column });
    let h = await header();
    for (let i = 0; i < 3 && h.state !== order; i++) {
      const before = h.state;
      await this.scope.el(h.tag, 'column header').click({ timeout: this.timeout });
      const changed = await poll(async () => {
        const n = await header();
        return n.state !== before ? n : undefined;
      }, Math.min(this.timeout, 3000));
      h = changed ?? (await header());
    }
    if (h.state !== order) throw new ComponentError(`could not sort ${h.text} ${order === 'asc' ? 'ascending' : 'descending'} (header shows ${h.state})`, 'COMPONENT_VERIFY');
    await this.waitReady();
    // The header flips before the rows re-render: poll until the top rows are in order.
    let v: string[] = [];
    let s: { ok: boolean; at?: number } = { ok: false };
    await poll(async () => {
      v = await this.visibleValues(h.text, 40);
      s = isSorted(v, order);
      return s.ok ? true : undefined;
    }, this.timeout, 80);
    if (!s.ok) throw new ComponentError(`the header says ${h.text} is sorted ${order}, but the rows are not ("${v[(s.at ?? 1) - 1]}" before "${v[s.at ?? 1]}")`, 'COMPONENT_VERIFY');
    return this.report('sort', undefined, `${h.text} sorted ${order === 'asc' ? 'ascending' : 'descending'} (header state and first ${v.length} rows checked)`, t0);
  }

  /** Values of a column in the first `n` rows (top of the current page). */
  private async visibleValues(column: string, n: number): Promise<string[]> {
    const r = await this.scope.call<ScanResult>('gridScan', { d: this.d, where: [], collect: true, maxRows: n, budgetMs: this.timeout, page: this.page }, this.timeout * 2);
    return (r.rows ?? []).slice(0, n).map((x) => x.cells[column] ?? '');
  }

  async filter(column: string, op: 'equals' | 'contains', value: string): Promise<ComponentReport> {
    const t0 = Date.now();
    type F = { mode?: 'column' | 'quick' | 'open'; tag?: string; column?: string; error?: string };
    let f = await this.scope.call<F>('gridFilterTarget', { d: this.d, column });
    if (f.mode === 'open' && f.tag) {
      await this.scope.el(f.tag).click({ timeout: this.timeout });
      f = (await poll(async () => {
        const x = await this.scope.call<F>('gridFilterTarget', { d: this.d, column });
        return x.mode === 'column' || x.mode === 'quick' ? x : undefined;
      }, this.timeout)) ?? f;
    }
    if (!f.tag || f.mode === 'open') throw new ComponentError(f.error ?? `no filter field for "${column}"`, 'COMPONENT_NO_FILTER');
    const input = this.scope.el(f.tag, 'filter field');
    await input.fill('', { timeout: this.timeout });
    await input.pressSequentially(value, { delay: 15, timeout: this.timeout });
    await input.press('Enter', { timeout: this.timeout }).catch(() => undefined);
    // Verify: every row now shown satisfies the filter (libraries filter with "contains" by default).
    let bad: string | undefined;
    let shown = 0;
    const ok = await poll(async () => {
      const s = await this.state();
      if (s.busy) return undefined;
      const r = await this.scope.call<ScanResult>('gridScan', { d: this.d, where: [], collect: true, maxRows: 60, budgetMs: this.timeout, page: this.page }, this.timeout * 2);
      const rows = r.rows ?? [];
      shown = rows.length;
      const col = f.column ?? column;
      const off = rows.find((x) => !normText(x.cells[col] ?? '').toLowerCase().includes(normText(value).toLowerCase()));
      bad = off ? `${col} = "${off.cells[col] ?? ''}"` : undefined;
      return off ? undefined : true;
    }, this.timeout, 100);
    if (!ok) throw new ComponentError(`after filtering ${column} by "${value}", a row still shows ${bad}`, 'COMPONENT_VERIFY');
    return this.report('filter', undefined, `filtered by ${column} ${op === 'equals' ? '=' : 'contains'} "${value}" (${f.mode === 'quick' ? 'quick filter' : 'column filter'}); ${shown} row(s) shown, all matching`, t0, { details: { mode: f.mode, shown } });
  }

  async selectRows(where: CellCondition[], opts: { all?: boolean; first?: boolean } = {}): Promise<ComponentReport> {
    const t0 = Date.now();
    const r = await this.scan(where, { first: opts.first });
    if (!r.matches.length) throw new ComponentError(`no row where ${describeWhere(where)} to select (read ${r.total} rows)`, 'COMPONENT_NO_ROW');
    if (!opts.all && r.matches.length > 1) throw new ComponentError(`${r.matches.length} rows match where ${describeWhere(where)}; say "Select the rows where ..." to select all of them`, 'COMPONENT_AMBIGUOUS_ROW');
    const keys: string[] = [];
    for (const m of r.matches) {
      const { page, ...row } = m;
      const found: FoundRow = { row, page, scanned: r.total, pages: r.pages, virtualized: r.virtualized };
      const rv = await this.reveal(found);
      const now = await this.rowNow(row.key);
      if (now.selected || now.checked) {
        keys.push(row.key);
        continue;
      }
      const cb = await this.scope.call<{ tag?: string }>('gridRowControl', { d: this.d, rows: rv.rows, what: 'checkbox' });
      if (cb.tag) await this.scope.el(cb.tag).click({ timeout: this.timeout });
      else await this.scope.el(this.rowCell(rv), 'row cell').click({ timeout: this.timeout, modifiers: keys.length ? ['ControlOrMeta'] : [] });
      const ok = await poll(async () => {
        const n = await this.rowNow(row.key);
        return n.selected || n.checked ? true : undefined;
      }, this.timeout);
      if (!ok) throw new ComponentError(`row ${row.key} (where ${describeWhere(where)}) did not become selected`, 'COMPONENT_VERIFY');
      keys.push(row.key);
    }
    return { kind: 'grid', adapter: this.d.id, library: this.adapter.id, op: 'selectRows', rowKey: keys.join(','), verified: `${keys.length} row(s) where ${describeWhere(where)} selected (keys ${keys.join(', ')})`, ms: ms(t0), details: { keys } };
  }

  async expandRow(where: CellCondition[], expand = true, opts: FindOptions = {}): Promise<ComponentReport> {
    const t0 = Date.now();
    const found = await this.findRow(where, opts);
    const rv = await this.reveal(found);
    const now = await this.rowNow(found.row.key);
    if ((now.expanded ?? !expand) !== expand) {
      const ex = await this.scope.call<{ tag?: string; error?: string }>('gridRowControl', { d: this.d, rows: rv.rows, what: 'expander' });
      if (!ex.tag) throw new ComponentError(`${ex.error ?? 'no expander'} (row where ${describeWhere(where)})`, 'COMPONENT_NO_CONTROL');
      await this.scope.el(ex.tag).click({ timeout: this.timeout });
      const ok = await poll(async () => ((await this.rowNow(found.row.key)).expanded === expand ? true : undefined), this.timeout);
      if (!ok) throw new ComponentError(`row where ${describeWhere(where)} did not ${expand ? 'expand' : 'collapse'}`, 'COMPONENT_VERIFY');
    }
    return this.report(expand ? 'expandRow' : 'collapseRow', found, `row where ${describeWhere(where)} (key ${found.row.key}) is ${expand ? 'expanded' : 'collapsed'}`, t0);
  }

  async scrollToRow(where: CellCondition[], opts: FindOptions = {}): Promise<ComponentReport> {
    const t0 = Date.now();
    const found = await this.findRow(where, opts);
    await this.reveal(found);
    const cell = await this.rowNow(found.row.key);
    if (!cell.found) throw new ComponentError(`row ${found.row.key} is not rendered after scrolling`, 'COMPONENT_VERIFY');
    return this.report('scrollToRow', found, `row where ${describeWhere(where)} (key ${found.row.key}) scrolled into view`, t0);
  }

  async readAll(where: CellCondition[] = [], maxRows?: number): Promise<GridReadResult & { truncated: boolean }> {
    const r = await this.scan(where, { collect: true, maxRows });
    if (r.truncated) {
      throw new ComponentError(`reading the grid stopped after ${r.ms} ms with ${r.rows.length} rows read (bound: ${this.budget} ms); raise the step timeout or filter the grid first`, 'COMPONENT_BUDGET');
    }
    return { columns: r.columns.filter((c) => c.text), rows: r.rows, total: r.rows.length, pages: r.pages, virtualized: r.virtualized, ms: r.ms, truncated: r.truncated };
  }

  async countRows(where: CellCondition[] = []): Promise<{ count: number; total: number; pages: number; ms: number; virtualized: boolean }> {
    const r = await this.scan(where, { collect: !where.length, countOnly: !!where.length });
    if (r.truncated) throw new ComponentError(`counting rows stopped after ${r.ms} ms (bound: ${this.budget} ms)`, 'COMPONENT_BUDGET');
    return { count: where.length ? r.matchCount : r.rows.length, total: where.length ? r.total : r.rows.length, pages: r.pages, ms: r.ms, virtualized: r.virtualized };
  }

  async assertSorted(column: string, order: 'asc' | 'desc'): Promise<ComponentReport> {
    const t0 = Date.now();
    const col = await this.column(column);
    const all = await this.readAll();
    const values = all.rows.map((r) => r.cells[col.text] ?? '');
    const s = isSorted(values, order);
    if (!s.ok) throw new ComponentError(`${col.text} is not sorted ${order === 'asc' ? 'ascending' : 'descending'}: row ${s.at} "${values[(s.at ?? 1) - 1]}" comes before "${values[s.at ?? 1]}" (${values.length} rows read)`, 'COMPONENT_ASSERT');
    return this.report('expectSorted', undefined, `${col.text} is sorted ${order === 'asc' ? 'ascending' : 'descending'} across all ${values.length} rows`, t0, { details: { rows: values.length, ms: all.ms } });
  }

  get library(): string {
    return this.adapter.id;
  }
}
