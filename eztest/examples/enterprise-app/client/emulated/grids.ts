/**
 * Emulated data grids of commercial / framework-bound libraries. One state
 * model (sorting, filtering, paging, selection, inline editing) drives
 * renderers that reproduce each library's documented DOM: Kendo UI Grid,
 * DevExtreme dxDataGrid, PrimeNG p-table, PrimeFaces DataTable, Angular
 * Material mat-table (+ mat-paginator, mat-sort), Oracle JET oj-table (load
 * more on scroll) and SAP UI5 sap.m.Table (growing "More" trigger).
 */
import type { Order } from '../../data.js';
import { log } from '../page.js';
import { clear, h } from './dom.js';

export interface Col {
  field: keyof Order;
  title: string;
  editable?: boolean;
}

export const COLS: Col[] = [
  { field: 'id', title: 'Id' },
  { field: 'customer', title: 'Customer' },
  { field: 'region', title: 'Region' },
  { field: 'status', title: 'Status' },
  { field: 'amount', title: 'Amount', editable: true },
  { field: 'orderDate', title: 'Order date' },
];

export const show = (o: Order, f: keyof Order): string => (f === 'amount' ? o.amount.toFixed(2) : String(o[f]));

export class GridModel {
  sort: { field: keyof Order; dir: 'asc' | 'desc' } | null = null;
  filters: Partial<Record<keyof Order, string>> = {};
  quick = '';
  page = 0;
  selected = new Set<number>();
  expanded = new Set<number>();
  editing: { id: number; field: keyof Order } | null = null;
  private listeners: Array<() => void> = [];

  constructor(
    public rows: Order[],
    public pageSize: number,
  ) {}

  on(f: () => void): void {
    this.listeners.push(f);
  }

  changed(): void {
    for (const f of this.listeners) f();
  }

  view(): Order[] {
    let v = this.rows.filter((r) =>
      Object.entries(this.filters).every(([f, t]) => !t || show(r, f as keyof Order).toLowerCase().includes(String(t).toLowerCase())) &&
      (!this.quick || COLS.some((c) => show(r, c.field).toLowerCase().includes(this.quick.toLowerCase()))));
    if (this.sort) {
      const { field, dir } = this.sort;
      v = [...v].sort((a, b) => {
        const x = a[field];
        const y = b[field];
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return dir === 'asc' ? c : -c;
      });
    }
    return v;
  }

  pages(): number {
    return Math.max(1, Math.ceil(this.view().length / this.pageSize));
  }

  pageRows(): Order[] {
    const v = this.view();
    if (this.page >= this.pages()) this.page = this.pages() - 1;
    return v.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
  }

  toggleSort(field: keyof Order): void {
    if (!this.sort || this.sort.field !== field) this.sort = { field, dir: 'asc' };
    else if (this.sort.dir === 'asc') this.sort = { field, dir: 'desc' };
    else this.sort = null;
    this.changed();
  }

  dirOf(field: keyof Order): 'asc' | 'desc' | null {
    return this.sort && this.sort.field === field ? this.sort.dir : null;
  }

  setFilter(field: keyof Order, text: string): void {
    this.filters[field] = text;
    this.page = 0;
    this.changed();
  }

  setQuick(text: string): void {
    this.quick = text;
    this.page = 0;
    this.changed();
  }

  go(page: number): void {
    this.page = Math.max(0, Math.min(this.pages() - 1, page));
    this.changed();
  }

  toggleSelect(id: number): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.changed();
  }

  commit(id: number, field: keyof Order, raw: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (row && field === 'amount') {
      const n = Number(raw.replace(',', '.'));
      if (Number.isFinite(n)) row.amount = n;
    }
    log(`edited ${id} ${String(field)}=${raw}`);
    this.editing = null;
    this.changed();
  }
}

/** Put an inline editor in a cell (in place: the cell element stays), commit on Enter or blur. */
export function inlineEditor(td: HTMLElement, model: GridModel, row: Order, col: Col, inputAttrs: Record<string, string>, wrap?: (input: HTMLElement) => HTMLElement): void {
  model.editing = { id: row.id, field: col.field };
  clear(td);
  const input = h('input', { type: 'text', value: show(row, col.field), ...inputAttrs }) as HTMLInputElement;
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    model.commit(row.id, col.field, input.value);
  };
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') commit();
    if ((e as KeyboardEvent).key === 'Escape') {
      done = true;
      model.editing = null;
      model.changed();
    }
  });
  input.addEventListener('blur', commit);
  td.appendChild(wrap ? wrap(input) : input);
  input.focus();
  input.select();
}

const filterInput = (model: GridModel, col: Col, attrs: Record<string, string>) => {
  const i = h('input', { type: 'text', value: model.filters[col.field] ?? '', ...attrs }) as HTMLInputElement;
  i.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') model.setFilter(col.field, i.value);
  });
  return i;
};

// ------------------------------------------------------------------ Kendo UI Grid (jQuery / Angular, "new rendering")

export function kendoGrid(host: HTMLElement, model: GridModel): void {
  const render = () => {
    const focus = document.activeElement?.getAttribute('data-filter-for');
    clear(host);
    const sortIcon = (c: Col) => {
      const d = model.dirOf(c.field);
      return d ? h('span', { class: 'k-sort-icon' }, h('span', { class: `k-icon k-svg-icon k-svg-i-sort-${d}-small` })) : null;
    };
    const head = h('thead', { class: 'k-table-thead', role: 'rowgroup' },
      h('tr', { class: 'k-table-row', role: 'row' }, COLS.map((c, i) => h('th', {
        class: 'k-header k-table-th', role: 'columnheader', 'data-field': c.field, 'data-title': c.title, 'data-index': i,
        'aria-sort': model.dirOf(c.field) === 'asc' ? 'ascending' : model.dirOf(c.field) === 'desc' ? 'descending' : null,
      }, h('span', { class: 'k-cell-inner' }, h('span', { class: 'k-link', onclick: () => model.toggleSort(c.field) }, h('span', { class: 'k-column-title' }, c.title), sortIcon(c)))))),
      h('tr', { class: 'k-filter-row', role: 'row' }, COLS.map((c) => h('th', { class: 'k-table-th', role: 'columnheader' },
        h('span', { class: 'k-filtercell' }, h('span', { class: 'k-textbox k-input k-input-md' }, filterInput(model, c, { class: 'k-input-inner', 'data-filter-for': String(c.field), title: `${c.title} filter` })))))));
    const rows = model.pageRows().map((o, i) => {
      const tr = h('tr', {
        class: `k-master-row k-table-row${i % 2 ? ' k-alt k-table-alt-row' : ''}${model.selected.has(o.id) ? ' k-selected' : ''}`, role: 'row', 'data-uid': `uid-${o.id}`,
        'aria-selected': model.selected.has(o.id) ? 'true' : 'false',
      }, COLS.map((c) => {
        const td = h('td', { class: 'k-table-td', role: 'gridcell' }, show(o, c.field));
        if (c.editable) td.addEventListener('click', () => {
          if (model.editing?.id === o.id) return;
          td.classList.add('k-edit-cell');
          inlineEditor(td, model, o, c, { class: 'k-input-inner', 'aria-label': c.title }, (inp) => h('span', { class: 'k-input k-numerictextbox' }, inp));
        });
        else td.addEventListener('click', () => model.toggleSelect(o.id));
        return td;
      }));
      return tr;
    });
    const pager = h('div', { class: 'k-pager k-grid-pager', role: 'application' },
      h('div', { class: 'k-pager-numbers-wrap' },
        h('button', { class: `k-pager-nav k-pager-first k-button${model.page === 0 ? ' k-disabled' : ''}`, title: 'Go to the first page', 'aria-label': 'Go to the first page', onclick: () => model.go(0) }, '|<'),
        h('button', { class: `k-pager-nav k-button${model.page === 0 ? ' k-disabled' : ''}`, title: 'Go to the previous page', 'aria-label': 'Go to the previous page', onclick: () => model.go(model.page - 1) }, '<'),
        h('div', { class: 'k-pager-numbers' }, `${model.page + 1} / ${model.pages()}`),
        h('button', { class: `k-pager-nav k-button${model.page >= model.pages() - 1 ? ' k-disabled' : ''}`, title: 'Go to the next page', 'aria-label': 'Go to the next page', onclick: () => model.go(model.page + 1) }, '>'),
        h('button', { class: `k-pager-nav k-pager-last k-button${model.page >= model.pages() - 1 ? ' k-disabled' : ''}`, title: 'Go to the last page', 'aria-label': 'Go to the last page', onclick: () => model.go(model.pages() - 1) }, '>|')),
      h('span', { class: 'k-pager-info' }, `${model.view().length} items`));
    host.appendChild(h('div', { class: 'k-grid k-grid-md', 'data-role': 'grid' },
      h('div', { class: 'k-grid-header' }, h('div', { class: 'k-grid-header-wrap' }, h('table', { class: 'k-grid-header-table k-table k-table-md', role: 'presentation' }, head))),
      h('div', { class: 'k-grid-content k-auto-scrollable' }, h('table', { class: 'k-grid-table k-table k-table-md', role: 'grid' }, h('tbody', { class: 'k-table-tbody', role: 'rowgroup' }, rows))),
      pager));
    if (focus) host.querySelector<HTMLInputElement>(`[data-filter-for="${focus}"]`)?.focus();
  };
  model.on(render);
  render();
}

// ------------------------------------------------------------------ DevExtreme dxDataGrid

export function dxGrid(host: HTMLElement, model: GridModel): void {
  const render = () => {
    clear(host);
    const ci = (i: number) => i + 2; // column 1 is the selection command column
    const headerRow = h('tr', { class: 'dx-row dx-column-lines dx-header-row', role: 'row' },
      h('td', { role: 'columnheader', 'aria-colindex': 1, class: 'dx-command-select dx-editor-cell' }, h('div', { class: 'dx-select-checkbox dx-checkbox dx-widget', role: 'checkbox', 'aria-checked': 'false', 'aria-label': 'Select all' }, h('span', { class: 'dx-checkbox-icon' }))),
      COLS.map((c, i) => h('td', {
        role: 'columnheader', 'aria-colindex': ci(i), class: 'dx-datagrid-action dx-cell-focus-disabled', 'aria-label': `Column ${c.title}`,
        'aria-sort': model.dirOf(c.field) === 'asc' ? 'ascending' : model.dirOf(c.field) === 'desc' ? 'descending' : 'none', onclick: () => model.toggleSort(c.field),
      }, h('div', { class: 'dx-column-indicators', role: 'presentation' }, model.dirOf(c.field) ? h('span', { class: `dx-sort ${model.dirOf(c.field) === 'asc' ? 'dx-sort-up' : 'dx-sort-down'}` }) : null),
      h('div', { class: 'dx-datagrid-text-content dx-text-content-alignment-left', role: 'presentation' }, c.title))));
    const filterRow = h('tr', { class: 'dx-row dx-column-lines dx-datagrid-filter-row', role: 'row' }, h('td', { role: 'gridcell', 'aria-colindex': 1 }),
      COLS.map((c, i) => h('td', { role: 'gridcell', 'aria-colindex': ci(i) }, h('div', { class: 'dx-editor-with-menu' }, h('div', { class: 'dx-editor-container' },
        h('div', { class: 'dx-texteditor dx-textbox' }, h('div', { class: 'dx-texteditor-container' }, h('div', { class: 'dx-texteditor-input-container' },
          filterInput(model, c, { class: 'dx-texteditor-input', 'aria-label': 'Filter cell' })))))))));
    const offset = model.page * model.pageSize;
    const rows = model.pageRows().map((o, i) => {
      const sel = model.selected.has(o.id);
      return h('tr', { class: `dx-row dx-data-row dx-column-lines${sel ? ' dx-selection' : ''}`, role: 'row', 'aria-rowindex': offset + i + 1, 'aria-selected': sel ? 'true' : 'false' },
        h('td', { role: 'gridcell', 'aria-colindex': 1, class: 'dx-command-select dx-editor-cell' },
          h('div', { class: `dx-select-checkbox dx-datagrid-checkbox-size dx-checkbox dx-widget${sel ? ' dx-checkbox-checked' : ''}`, role: 'checkbox', 'aria-checked': sel ? 'true' : 'false', onclick: () => model.toggleSelect(o.id) }, h('span', { class: 'dx-checkbox-icon' }))),
        COLS.map((c, k) => {
          const td = h('td', { role: 'gridcell', 'aria-colindex': ci(k) }, show(o, c.field));
          if (c.editable) td.addEventListener('click', () => {
            if (model.editing?.id === o.id) return;
            td.classList.add('dx-editor-cell');
            inlineEditor(td, model, o, c, { class: 'dx-texteditor-input', 'aria-label': c.title }, (inp) => h('div', { class: 'dx-texteditor dx-textbox' }, h('div', { class: 'dx-texteditor-container' }, inp)));
          });
          return td;
        }));
    });
    const btn = (cls: string, label: string, disabled: boolean, go: () => void) => h('div', { class: `dx-navigate-button ${cls}${disabled ? ' dx-button-disable' : ''}`, role: 'button', 'aria-label': label, tabindex: 0, onclick: () => !disabled && go() });
    host.appendChild(h('div', { class: 'dx-widget dx-datagrid-container dx-datagrid dx-gridbase-container', role: 'grid', 'aria-rowcount': model.view().length, 'aria-colcount': COLS.length + 1 },
      h('div', { class: 'dx-datagrid-headers dx-datagrid-nowrap', role: 'presentation' }, h('div', { class: 'dx-datagrid-content dx-datagrid-scroll-container' },
        h('table', { class: 'dx-datagrid-table dx-datagrid-table-fixed', role: 'presentation' }, h('tbody', { role: 'presentation' }, headerRow, filterRow)))),
      h('div', { class: 'dx-datagrid-rowsview dx-datagrid-nowrap dx-scrollable dx-scrollable-both', role: 'presentation' }, h('div', { class: 'dx-scrollable-wrapper' },
        h('div', { class: 'dx-scrollable-container', style: 'max-height: 360px; overflow: auto' }, h('div', { class: 'dx-scrollable-content' }, h('div', { class: 'dx-datagrid-content' },
          h('table', { class: 'dx-datagrid-table dx-datagrid-table-fixed', role: 'presentation' }, h('tbody', { role: 'presentation' }, rows))))))),
      h('div', { class: 'dx-datagrid-pager dx-pager' }, h('div', { class: 'dx-pages' },
        btn('dx-prev-button', 'Previous page', model.page === 0, () => model.go(model.page - 1)),
        h('div', { class: 'dx-page-indexes' }, h('div', { class: 'dx-page dx-selection', role: 'button' }, String(model.page + 1))),
        btn('dx-next-button', 'Next page', model.page >= model.pages() - 1, () => model.go(model.page + 1))))));
  };
  model.on(render);
  render();
}

// ------------------------------------------------------------------ PrimeNG p-table

export function primengTable(host: HTMLElement, model: GridModel): void {
  const render = () => {
    clear(host);
    const sortIcon = (c: Col) => h('span', { class: `p-sortable-column-icon pi ${model.dirOf(c.field) === 'asc' ? 'pi-sort-amount-up-alt' : model.dirOf(c.field) === 'desc' ? 'pi-sort-amount-down' : 'pi-sort-alt'}` });
    const table = h('table', { class: 'p-datatable-table', role: 'table' },
      h('thead', { class: 'p-datatable-thead' },
        h('tr', {}, h('th', { style: 'width: 3rem' }), COLS.map((c) => h('th', {
          psortablecolumn: c.field, class: `p-sortable-column${model.dirOf(c.field) ? ' p-highlight' : ''}`, role: 'columnheader', tabindex: 0,
          'aria-sort': model.dirOf(c.field) === 'asc' ? 'ascending' : model.dirOf(c.field) === 'desc' ? 'descending' : 'none', onclick: () => model.toggleSort(c.field),
        }, c.title, ' ', h('p-sorticon', {}, sortIcon(c))))),
        h('tr', {}, h('th', {}), COLS.map((c) => h('th', {}, h('p-columnfilter', {}, h('div', { class: 'p-column-filter p-column-filter-row' }, filterInput(model, c, { class: 'p-inputtext p-component', pinputtext: '' })))))),
      h('tbody', { class: 'p-datatable-tbody' }, model.pageRows().map((o) => {
        const sel = model.selected.has(o.id);
        return h('tr', { class: `p-selectable-row${sel ? ' p-highlight' : ''}`, tabindex: 0, 'aria-selected': sel ? 'true' : 'false' },
          h('td', {}, h('p-tablecheckbox', {}, h('div', { class: 'p-checkbox p-component' }, h('div', { class: `p-checkbox-box p-component${sel ? ' p-highlight' : ''}`, role: 'checkbox', 'aria-checked': sel ? 'true' : 'false', onclick: () => model.toggleSelect(o.id) })))),
          COLS.map((c) => {
            const td = h('td', c.editable ? { peditablecolumn: '' } : {}, show(o, c.field));
            if (c.editable) td.addEventListener('click', () => {
              if (model.editing?.id === o.id) return;
              td.classList.add('p-editable-column', 'p-cell-editing');
              inlineEditor(td, model, o, c, { class: 'p-inputtext p-component', pinputtext: '' }, (inp) => h('p-celleditor', {}, inp));
            });
            return td;
          }));
      }))));
    const disabledFirst = model.page === 0;
    const disabledLast = model.page >= model.pages() - 1;
    const nav = (cls: string, label: string, disabled: boolean, go: () => void) => h('button', { type: 'button', class: `${cls} p-paginator-element p-link${disabled ? ' p-disabled' : ''}`, 'aria-label': label, disabled, onclick: go });
    host.appendChild(h('div', { class: 'p-datatable p-component p-datatable-gridlines' },
      h('div', { class: 'p-datatable-wrapper' }, table),
      h('p-paginator', {}, h('div', { class: 'p-paginator p-component' },
        nav('p-paginator-first', 'First Page', disabledFirst, () => model.go(0)),
        nav('p-paginator-prev', 'Previous Page', disabledFirst, () => model.go(model.page - 1)),
        h('span', { class: 'p-paginator-pages' }, h('button', { class: 'p-paginator-page p-paginator-element p-link p-highlight' }, String(model.page + 1))),
        nav('p-paginator-next', 'Next Page', disabledLast, () => model.go(model.page + 1)),
        nav('p-paginator-last', 'Last Page', disabledLast, () => model.go(model.pages() - 1))))));
  };
  model.on(render);
  render();
}

// ------------------------------------------------------------------ PrimeFaces DataTable

export function primefacesTable(host: HTMLElement, model: GridModel): void {
  const render = () => {
    clear(host);
    const off = model.page * model.pageSize;
    const icon = (c: Col) => h('span', { class: `ui-sortable-column-icon ui-icon ${model.dirOf(c.field) === 'asc' ? 'ui-icon-triangle-1-n' : model.dirOf(c.field) === 'desc' ? 'ui-icon-triangle-1-s' : 'ui-icon-carat-2-n-s'}` });
    host.appendChild(h('div', { id: 'form:orders', class: 'ui-datatable ui-widget' },
      h('div', { class: 'ui-datatable-tablewrapper' }, h('table', { role: 'grid' },
        h('thead', { id: 'form:orders_head' }, h('tr', { role: 'row' }, COLS.map((c) => h('th', {
          class: 'ui-state-default ui-sortable-column', role: 'columnheader', 'aria-label': c.title, onclick: () => model.toggleSort(c.field),
          'aria-sort': model.dirOf(c.field) === 'asc' ? 'ascending' : model.dirOf(c.field) === 'desc' ? 'descending' : 'other',
        }, h('span', { class: 'ui-column-title' }, c.title), icon(c))))),
        h('tbody', { id: 'form:orders_data', class: 'ui-datatable-data ui-widget-content' }, model.pageRows().map((o, i) =>
          h('tr', { 'data-ri': off + i, 'data-rk': o.id, class: `ui-widget-content ${i % 2 ? 'ui-datatable-odd' : 'ui-datatable-even'} ui-datatable-selectable${model.selected.has(o.id) ? ' ui-state-highlight' : ''}`, role: 'row', 'aria-selected': model.selected.has(o.id) ? 'true' : 'false', onclick: () => model.toggleSelect(o.id) },
            COLS.map((c) => h('td', { role: 'gridcell' }, show(o, c.field)))))))),
      h('div', { class: 'ui-paginator ui-paginator-bottom ui-widget-header', role: 'navigation' },
        h('a', { class: `ui-paginator-first ui-state-default ui-corner-all${model.page === 0 ? ' ui-state-disabled' : ''}`, 'aria-label': 'First Page', tabindex: 0, onclick: () => model.go(0) }, h('span', { class: 'ui-icon ui-icon-seek-first' }, 'F')),
        h('a', { class: `ui-paginator-prev ui-state-default ui-corner-all${model.page === 0 ? ' ui-state-disabled' : ''}`, 'aria-label': 'Previous Page', tabindex: 0, onclick: () => model.go(model.page - 1) }, h('span', { class: 'ui-icon ui-icon-seek-prev' }, 'P')),
        h('span', { class: 'ui-paginator-pages' }, h('a', { class: 'ui-paginator-page ui-state-default ui-state-active ui-corner-all' }, String(model.page + 1))),
        h('a', { class: `ui-paginator-next ui-state-default ui-corner-all${model.page >= model.pages() - 1 ? ' ui-state-disabled' : ''}`, 'aria-label': 'Next Page', tabindex: 0, onclick: () => model.go(model.page + 1) }, h('span', { class: 'ui-icon ui-icon-seek-next' }, 'N')))));
  };
  model.on(render);
  render();
}

// ------------------------------------------------------------------ Angular Material mat-table + mat-sort + mat-paginator

export function matTable(host: HTMLElement, model: GridModel): void {
  const quick = h('input', { class: 'mat-mdc-input-element mat-mdc-form-field-input-control', placeholder: 'Filter', 'aria-label': 'Filter', id: 'mat-input-filter' }) as HTMLInputElement;
  quick.addEventListener('input', () => model.setQuick(quick.value));
  const formField = h('mat-form-field', { class: 'mat-mdc-form-field' }, h('div', { class: 'mat-mdc-text-field-wrapper' }, quick));
  const tableHost = h('div');
  host.appendChild(formField);
  host.appendChild(tableHost);
  const render = () => {
    clear(tableHost);
    const cls = (c: Col) => `cdk-column-${String(c.field)} mat-column-${String(c.field)}`;
    tableHost.appendChild(h('div', { class: 'mat-elevation-z8' },
      h('table', { 'mat-table': '', class: 'mat-mdc-table mdc-data-table__table cdk-table mat-sort', role: 'table' },
        h('thead', { role: 'rowgroup' }, h('tr', { class: 'mat-mdc-header-row mdc-data-table__header-row cdk-header-row', role: 'row' },
          h('th', { class: 'mat-mdc-header-cell mdc-data-table__header-cell cdk-header-cell cdk-column-select mat-column-select', role: 'columnheader' }),
          COLS.map((c) => h('th', {
            class: `mat-mdc-header-cell mdc-data-table__header-cell cdk-header-cell ${cls(c)} mat-sort-header`, role: 'columnheader',
            'aria-sort': model.dirOf(c.field) === 'asc' ? 'ascending' : model.dirOf(c.field) === 'desc' ? 'descending' : 'none',
          }, h('div', { class: 'mat-sort-header-container mat-focus-indicator', role: 'button', tabindex: 0, onclick: () => model.toggleSort(c.field) },
            h('div', { class: 'mat-sort-header-content' }, c.title), h('div', { class: 'mat-sort-header-arrow' })))))),
        h('tbody', { class: 'mdc-data-table__content', role: 'rowgroup' }, model.pageRows().map((o) => {
          const sel = model.selected.has(o.id);
          const cb = h('input', { type: 'checkbox', class: 'mdc-checkbox__native-control', checked: sel, 'aria-label': `Select ${o.id}` }) as HTMLInputElement;
          cb.addEventListener('change', () => model.toggleSelect(o.id));
          return h('tr', { class: `mat-mdc-row mdc-data-table__row cdk-row${sel ? ' ez-selected' : ''}`, role: 'row' },
            h('td', { class: 'mat-mdc-cell mdc-data-table__cell cdk-cell cdk-column-select mat-column-select', role: 'cell' }, h('mat-checkbox', { class: 'mat-mdc-checkbox' }, h('div', { class: 'mdc-checkbox' }, cb))),
            COLS.map((c) => {
              const td = h('td', { class: `mat-mdc-cell mdc-data-table__cell cdk-cell ${cls(c)}`, role: 'cell' }, show(o, c.field));
              if (c.editable) td.addEventListener('click', () => {
                if (model.editing?.id === o.id) return;
                inlineEditor(td, model, o, c, { class: 'mat-mdc-input-element', 'aria-label': c.title });
              });
              return td;
            }));
        }))),
      h('mat-paginator', { class: 'mat-mdc-paginator' }, h('div', { class: 'mat-mdc-paginator-outer-container' }, h('div', { class: 'mat-mdc-paginator-container' },
        h('div', { class: 'mat-mdc-paginator-range-actions' },
          h('div', { class: 'mat-mdc-paginator-range-label' }, `${model.page * model.pageSize + 1} – ${Math.min(model.view().length, (model.page + 1) * model.pageSize)} of ${model.view().length}`),
          h('button', { class: 'mat-mdc-paginator-navigation-first mdc-icon-button mat-mdc-icon-button', 'aria-label': 'First page', disabled: model.page === 0, onclick: () => model.go(0) }, '|<'),
          h('button', { class: 'mat-mdc-paginator-navigation-previous mdc-icon-button mat-mdc-icon-button', 'aria-label': 'Previous page', disabled: model.page === 0, onclick: () => model.go(model.page - 1) }, '<'),
          h('button', { class: 'mat-mdc-paginator-navigation-next mdc-icon-button mat-mdc-icon-button', 'aria-label': 'Next page', disabled: model.page >= model.pages() - 1, onclick: () => model.go(model.page + 1) }, '>')))))));
  };
  model.on(render);
  render();
}

// ------------------------------------------------------------------ Oracle JET oj-table (scrollPolicy: loadMoreOnScroll)

export function jetTable(host: HTMLElement, model: GridModel, fetchSize = 25): void {
  let loaded = fetchSize;
  let loading = false;
  const table = h('oj-table', { class: 'oj-table oj-component oj-complete', 'aria-label': 'Orders', 'scroll-policy': 'loadMoreOnScroll' });
  const scroller = h('div', { class: 'oj-table-scroller', style: 'max-height: 300px; overflow-y: auto' });
  const status = h('div', { class: 'oj-table-status-message', style: 'display: none' }, 'Fetching data...');
  table.appendChild(h('div', { class: 'oj-table-container' }, scroller, status));
  host.appendChild(table);
  const render = () => {
    const top = scroller.scrollTop;
    clear(scroller);
    const rows = model.view().slice(0, loaded);
    scroller.appendChild(h('table', { class: 'oj-table-element oj-component-initnode', role: 'grid' },
      h('thead', { class: 'oj-table-header' }, h('tr', { class: 'oj-table-header-row' }, COLS.map((c) => h('th', {
        class: 'oj-table-column-header-cell oj-sort', role: 'columnheader', 'aria-sort': model.dirOf(c.field) === 'asc' ? 'ascending' : model.dirOf(c.field) === 'desc' ? 'descending' : null,
        onclick: () => model.toggleSort(c.field),
      }, h('div', { class: 'oj-table-column-header' }, h('div', { class: 'oj-table-column-header-text' }, c.title)))))),
      h('tbody', { class: 'oj-table-body' }, rows.map((o) => h('tr', { class: `oj-table-body-row${model.selected.has(o.id) ? ' oj-selected' : ''}`, onclick: () => model.toggleSelect(o.id) },
        COLS.map((c) => h('td', { class: 'oj-table-data-cell oj-form-control-inherit' }, show(o, c.field))))))));
    scroller.scrollTop = top;
  };
  scroller.addEventListener('scroll', () => {
    if (loading || loaded >= model.view().length) return;
    if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 40) return;
    loading = true;
    status.style.display = 'block';
    setTimeout(() => {
      loaded += fetchSize;
      loading = false;
      status.style.display = 'none';
      render();
    }, 250);
  });
  model.on(render);
  render();
}

// ------------------------------------------------------------------ SAP UI5 sap.m.Table (growing)

export function ui5Table(host: HTMLElement, model: GridModel, threshold = 20): void {
  let shown = threshold;
  const search = h('input', { type: 'search', class: 'sapMSFI', placeholder: 'Search' }) as HTMLInputElement;
  search.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') model.setQuick(search.value);
  });
  host.appendChild(h('div', { class: 'sapMTB sapMTBNewFlex' }, h('div', { class: 'sapMSF', role: 'search' }, h('form', { class: 'sapMSFF', onsubmit: (e: Event) => e.preventDefault() }, search))));
  const tableHost = h('div');
  host.appendChild(tableHost);
  const render = () => {
    clear(tableHost);
    const rows = model.view().slice(0, shown);
    const col = (i: number) => `__column${i}`;
    tableHost.appendChild(h('div', { id: '__table0', class: 'sapMList sapMListBGSolid sapMTable' },
      h('div', { class: 'sapMListTblCnt' }, h('table', { id: '__table0-listUl', class: 'sapMListTbl', role: 'grid' },
        h('thead', {}, h('tr', { id: '__table0-tblHeader', class: 'sapMListTblHeader sapMListTblRow', role: 'row' },
          h('th', { class: 'sapMTblCellFocusable sapMListTblSelCol', role: 'presentation' }),
          COLS.map((c, i) => h('th', { class: 'sapMListTblCell sapMListTblHeaderCell', role: 'columnheader', 'data-sap-ui-column': col(i) }, h('div', { class: 'sapMColumnHeader' }, h('span', { class: 'sapMText sapMTextNoWrap' }, c.title)))))),
        h('tbody', { id: '__table0-tblBody' }, rows.map((o) => {
          const sel = model.selected.has(o.id);
          return h('tr', { id: `__item${o.id}`, class: `sapMLIB sapMLIB-CTX sapMLIBShowSeparator sapMLIBTypeInactive sapMListTblRow${sel ? ' sapMLIBSelected' : ''}`, role: 'row', 'aria-selected': sel ? 'true' : 'false' },
            h('td', { class: 'sapMListTblSelCol' }, h('div', { class: 'sapMCb', role: 'checkbox', 'aria-checked': sel ? 'true' : 'false', onclick: () => model.toggleSelect(o.id) }, h('div', { class: `sapMCbBg${sel ? ' sapMCbMarkChecked' : ''}` }))),
            COLS.map((c, i) => h('td', { class: 'sapMListTblCell', 'data-sap-ui-column': col(i) }, h('span', { class: 'sapMText' }, show(o, c.field)))));
        }))),
      shown < model.view().length
        ? h('div', { id: '__table0-trigger', class: 'sapMLIB sapMGrowingListTrigger', role: 'button', tabindex: 0, onclick: () => {
          shown += threshold;
          render();
        } }, h('div', { class: 'sapMSLITitle' }, 'More'), h('div', { class: 'sapMSLIDescription' }, `[ ${Math.min(shown, model.view().length)} / ${model.view().length} ]`))
        : null)));
  };
  model.on(() => {
    shown = threshold;
    render();
  });
  render();
}
