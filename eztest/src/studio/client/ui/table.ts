/**
 * Virtualized data table (ARIA grid): only the visible rows exist in the DOM,
 * so thousands of runs or steps scroll smoothly. Click a header to sort
 * (aria-sort), filter with `setFilter`, move with the arrow keys, PageUp/Down,
 * Home/End, and activate a row with Enter or a click.
 */
import { clear, h, type Child } from '../core/dom.js';
import { icon } from './icons.js';

export interface Column<T> {
  id: string;
  title: string;
  /** CSS grid track, e.g. "minmax(10rem, 2fr)" or "6rem". Default "1fr". */
  width?: string;
  /** Sort/filter value. */
  value?(row: T): string | number | undefined;
  render?(row: T): Child;
  sortable?: boolean;
  align?: 'start' | 'end' | 'center';
  /** Visually hidden header text (e.g. an actions column). */
  srOnlyTitle?: boolean;
}

export interface TableOptions<T> {
  label: string;
  columns: Array<Column<T>>;
  rows?: T[];
  key(row: T): string;
  rowHeight?: number;
  onActivate?(row: T): void;
  onSelect?(row: T): void;
  /** Text for an empty (or fully filtered) table. */
  empty?: string;
  /** Custom filter; default: case-insensitive match on every column value. */
  filter?(row: T, query: string): boolean;
  rowClass?(row: T): string | undefined;
  sort?: { id: string; dir: 'asc' | 'desc' };
  class?: string;
}

export interface TableHandle<T> {
  el: HTMLElement;
  setRows(rows: T[]): void;
  setFilter(q: string): void;
  select(key: string | undefined, opts?: { focus?: boolean; scroll?: boolean }): void;
  readonly visibleRows: T[];
  focus(): void;
}

const OVERSCAN = 8;

export function createTable<T>(o: TableOptions<T>): TableHandle<T> {
  const rh = o.rowHeight ?? 34;
  let all: T[] = o.rows ?? [];
  let view: T[] = [];
  let query = '';
  let sort = o.sort;
  let selectedKey: string | undefined;
  let focusIndex = 0;
  const template = o.columns.map((c) => c.width ?? '1fr').join(' ');

  const headRow = h('div', { class: 'vt-row vt-head', role: 'row', 'aria-rowindex': '1' });
  headRow.style.gridTemplateColumns = template;
  const spacer = h('div', { class: 'vt-spacer' });
  const body = h('div', { class: 'vt-body', role: 'rowgroup' }, spacer);
  // A grid may only own rows (WAI-ARIA 1.2), so the empty state is a row with one cell.
  const emptyEl = h('div', { class: 'vt-empty', role: 'row' }, h('div', { role: 'gridcell', text: o.empty ?? 'Nothing to show' }));
  const el = h('div', { class: ['vtable', o.class], role: 'grid', 'aria-label': o.label }, h('div', { class: 'vt-headgroup', role: 'rowgroup' }, headRow), body, emptyEl);

  const valueOf = (c: Column<T>, r: T) => (c.value ? c.value(r) : undefined);

  const renderHead = () => {
    clear(headRow);
    for (const c of o.columns) {
      const dir = sort?.id === c.id ? sort.dir : undefined;
      const cell = h('div', {
        class: ['vt-cell', 'vt-th', c.align && `align-${c.align}`],
        role: 'columnheader',
        'aria-sort': c.sortable ? (dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none') : undefined,
      });
      if (c.sortable) {
        cell.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: 'vt-sort',
              onclick: () => {
                sort = { id: c.id, dir: sort?.id === c.id && sort.dir === 'asc' ? 'desc' : 'asc' };
                recompute();
              },
            },
            h('span', { text: c.title }),
            dir ? icon(dir === 'asc' ? 'chevronUp' : 'chevronDown', { size: 12 }) : null,
          ),
        );
      } else cell.appendChild(h('span', { class: c.srOnlyTitle ? 'sr-only' : undefined, text: c.title }));
      headRow.appendChild(cell);
    }
  };

  const recompute = () => {
    const q = query.trim().toLowerCase();
    view = q
      ? all.filter((r) => (o.filter ? o.filter(r, q) : o.columns.some((c) => String(valueOf(c, r) ?? '').toLowerCase().includes(q))))
      : [...all];
    const col = sort && o.columns.find((c) => c.id === sort!.id);
    if (col) {
      const m = sort!.dir === 'asc' ? 1 : -1;
      view.sort((a, b) => {
        const x = valueOf(col, a);
        const y = valueOf(col, b);
        if (x === y) return 0;
        if (x === undefined) return 1;
        if (y === undefined) return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * m;
      });
    }
    el.setAttribute('aria-rowcount', String(view.length + 1));
    spacer.style.height = `${view.length * rh}px`;
    emptyEl.hidden = view.length > 0;
    const sel = selectedKey !== undefined ? view.findIndex((r) => o.key(r) === selectedKey) : -1;
    focusIndex = sel >= 0 ? sel : Math.min(focusIndex, Math.max(0, view.length - 1));
    renderHead();
    renderRows();
  };

  const renderRows = () => {
    const height = body.clientHeight || 600;
    const start = Math.max(0, Math.floor(body.scrollTop / rh) - OVERSCAN);
    const end = Math.min(view.length, Math.ceil((body.scrollTop + height) / rh) + OVERSCAN);
    const hadFocus = body.contains(document.activeElement);
    for (const r of [...spacer.children]) r.remove();
    for (let i = start; i < end; i++) {
      const row = view[i];
      const key = o.key(row);
      const rowEl = h(
        'div',
        {
          class: ['vt-row', o.rowClass?.(row), key === selectedKey && 'selected'],
          role: 'row',
          'aria-rowindex': String(i + 2),
          'aria-selected': String(key === selectedKey),
          tabindex: i === focusIndex ? '0' : '-1',
          dataset: { key, index: i },
          onclick: () => {
            focusIndex = i;
            selectRow(i, true);
            o.onActivate?.(row);
          },
        },
        o.columns.map((c) => h('div', { class: ['vt-cell', c.align && `align-${c.align}`], role: 'gridcell' }, c.render ? c.render(row) : String(valueOf(c, row) ?? ''))),
      );
      rowEl.style.gridTemplateColumns = template;
      rowEl.style.transform = `translateY(${i * rh}px)`;
      rowEl.style.height = `${rh}px`;
      spacer.appendChild(rowEl);
    }
    if (hadFocus) spacer.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`)?.focus({ preventScroll: true });
  };

  const scrollTo = (i: number) => {
    const top = i * rh;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + rh > body.scrollTop + body.clientHeight) body.scrollTop = top + rh - body.clientHeight;
  };

  const selectRow = (i: number, notify: boolean) => {
    const row = view[i];
    if (!row) return;
    selectedKey = o.key(row);
    focusIndex = i;
    renderRows();
    if (notify) o.onSelect?.(row);
  };

  body.addEventListener('scroll', () => renderRows(), { passive: true });
  body.addEventListener('keydown', (e) => {
    const page = Math.max(1, Math.floor(body.clientHeight / rh) - 1);
    let n = focusIndex;
    if (e.key === 'ArrowDown') n++;
    else if (e.key === 'ArrowUp') n--;
    else if (e.key === 'PageDown') n += page;
    else if (e.key === 'PageUp') n -= page;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = view.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const row = view[focusIndex];
      if (row) {
        selectRow(focusIndex, true);
        o.onActivate?.(row);
      }
      return;
    } else return;
    e.preventDefault();
    n = Math.max(0, Math.min(view.length - 1, n));
    focusIndex = n;
    scrollTo(n);
    selectRow(n, true);
    spacer.querySelector<HTMLElement>(`[data-index="${n}"]`)?.focus();
  });
  new ResizeObserver(() => renderRows()).observe(body);
  recompute();

  return {
    el,
    setRows(rows) {
      all = rows;
      recompute();
    },
    setFilter(q) {
      query = q;
      recompute();
    },
    select(key, opts = {}) {
      selectedKey = key;
      const i = key === undefined ? -1 : view.findIndex((r) => o.key(r) === key);
      if (i >= 0) {
        focusIndex = i;
        if (opts.scroll !== false) scrollTo(i);
      }
      renderRows();
      if (opts.focus) spacer.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`)?.focus();
    },
    get visibleRows() {
      return view;
    },
    focus() {
      (spacer.querySelector<HTMLElement>('[tabindex="0"]') ?? body).focus();
    },
  };
}
