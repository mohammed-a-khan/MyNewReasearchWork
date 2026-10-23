/**
 * Hand-written WAI-ARIA widgets (the patterns of the ARIA Authoring Practices
 * Guide): a 10,000-row virtualized grid with aria-rowindex/aria-colindex,
 * column reordering, sorting, a filter row and inline editing; an async
 * combobox; an accordion; a slider; a file drop zone; an infinite feed;
 * editors (plain contenteditable, Quill and CKEditor 5 DOM) and charts that
 * are only inspectable through a data table, a Highcharts-like global, or
 * not at all.
 */
import { MONTHLY_REVENUE, MONTHS, orders, type Order } from '../../data.js';
import { log, page } from '../page.js';
import { ComboController, type ComboSkin } from './combos.js';
import { clear, h, uid } from './dom.js';
import { COLS, show, type Col } from './grids.js';

// ------------------------------------------------------------------ virtualized ARIA grid

export interface AriaGridOptions {
  label: string;
  rows: number;
  /** Markup version for healing scenarios: 2 renames the grid and changes structure and classes. */
  version?: string;
  rowHeight?: number;
  height?: number;
}

export function ariaGrid(host: HTMLElement, o: AriaGridOptions): void {
  const data: Order[] = orders(o.rows);
  const v2 = o.version === '2';
  const rh = o.rowHeight ?? 32;
  const height = o.height ?? 420;
  let cols: Col[] = [...COLS];
  let sort: { field: keyof Order; dir: 'asc' | 'desc' } | null = null;
  const filters: Partial<Record<keyof Order, string>> = {};
  let view: Order[] = data;
  const selected = new Set<number>();
  let editing: { id: number; field: keyof Order } | null = null;

  const recompute = () => {
    view = data.filter((r) => Object.entries(filters).every(([f, t]) => !t || show(r, f as keyof Order).toLowerCase().includes(String(t).toLowerCase())));
    if (sort) {
      const { field, dir } = sort;
      view = [...view].sort((a, b) => {
        const x = a[field];
        const y = b[field];
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return dir === 'asc' ? c : -c;
      });
    }
  };

  const grid = h('div', {
    role: 'grid', 'aria-label': v2 ? 'Customer orders' : o.label, 'aria-rowcount': data.length + 2, 'aria-colcount': cols.length,
    class: v2 ? 'dg2-table' : 'ez-grid', 'data-testid': v2 ? 'orders-table-v2' : 'orders-grid',
  });
  const headerRow = h('div', { role: 'row', 'aria-rowindex': 1, class: v2 ? 'dg2-head' : 'ez-head' });
  const filterRow = h('div', { role: 'row', 'aria-rowindex': 2, class: v2 ? 'dg2-filters' : 'ez-filters' });
  const viewport = h('div', { class: v2 ? 'dg2-body' : 'ez-viewport', style: `height: ${height}px; overflow-y: auto; position: relative` });
  const spacer = h('div', { role: 'rowgroup', style: 'position: relative' });
  viewport.appendChild(spacer);
  grid.append(h('div', { role: 'rowgroup', class: v2 ? 'dg2-thead' : 'ez-header' }, headerRow, filterRow), viewport);
  host.appendChild(grid);

  const cellStyle = 'display: inline-block; width: 140px; padding: 4px; box-sizing: border-box; overflow: hidden; white-space: nowrap';
  const drawHead = () => {
    clear(headerRow);
    clear(filterRow);
    cols.forEach((c, i) => {
      const dir = sort?.field === c.field ? sort.dir : null;
      headerRow.appendChild(h('div', { role: 'columnheader', 'aria-colindex': i + 1, 'aria-sort': dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none', style: cellStyle, 'data-field': c.field },
        h('button', { type: 'button', class: 'sort', onclick: () => {
          sort = !sort || sort.field !== c.field ? { field: c.field, dir: 'asc' } : sort.dir === 'asc' ? { field: c.field, dir: 'desc' } : null;
          recompute();
          drawHead();
          drawRows(true);
        } }, c.title)));
      const fi = h('input', { type: 'text', 'aria-label': `Filter ${c.title}`, value: filters[c.field] ?? '', style: 'width: 120px' }) as HTMLInputElement;
      fi.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          filters[c.field] = fi.value;
          recompute();
          viewport.scrollTop = 0;
          drawRows(true);
        }
      });
      filterRow.appendChild(h('div', { role: 'gridcell', 'aria-colindex': i + 1, style: cellStyle }, fi));
    });
  };

  let lastRange = '';
  const drawRows = (force = false) => {
    spacer.style.height = `${view.length * rh}px`;
    const first = Math.max(0, Math.floor(viewport.scrollTop / rh) - 5);
    const last = Math.min(view.length, Math.ceil((viewport.scrollTop + height) / rh) + 5);
    const range = `${first}:${last}`;
    if (!force && range === lastRange) return;
    lastRange = range;
    clear(spacer);
    for (let i = first; i < last; i++) {
      const r = view[i];
      const sel = selected.has(r.id);
      const row = h('div', { role: 'row', 'aria-rowindex': i + 3, 'aria-selected': sel ? 'true' : 'false', class: sel ? 'selected' : '', style: `position: absolute; top: ${i * rh}px; height: ${rh}px; white-space: nowrap` });
      cols.forEach((c, k) => {
        const cell = h('div', { role: 'gridcell', 'aria-colindex': k + 1, style: cellStyle, tabindex: -1 }, show(r, c.field));
        if (c.editable) cell.addEventListener('dblclick', () => {
          editing = { id: r.id, field: c.field };
          clear(cell);
          const inp = h('input', { type: 'text', value: show(r, c.field), 'aria-label': c.title, style: 'width: 120px' }) as HTMLInputElement;
          const done = (save: boolean) => {
            if (!editing) return;
            editing = null;
            if (save) {
              const n = Number(inp.value);
              if (Number.isFinite(n)) r.amount = n;
              log(`edited ${r.id} amount=${inp.value}`);
            }
            drawRows(true);
          };
          inp.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') done(true);
            if ((e as KeyboardEvent).key === 'Escape') done(false);
          });
          inp.addEventListener('blur', () => done(true));
          cell.appendChild(inp);
          inp.focus();
        });
        else cell.addEventListener('click', () => {
          if (selected.has(r.id)) selected.delete(r.id);
          else selected.add(r.id);
          log(`clicked ${r.id}`);
          drawRows(true);
        });
        row.appendChild(cell);
      });
      spacer.appendChild(row);
    }
  };
  viewport.addEventListener('scroll', () => drawRows());
  recompute();
  drawHead();
  drawRows(true);

  const reorder = h('button', { type: 'button', id: 'reorder-aria', onclick: () => {
    cols = [cols[4], ...cols.filter((_, i) => i !== 4)];
    drawHead();
    drawRows(true);
    log('moved Amount first');
  } }, 'Move Amount first');
  host.insertBefore(h('p', {}, reorder), grid);
}

// ------------------------------------------------------------------ async combobox (APG "list autocomplete")

export function ariaCombobox(host: HTMLElement, label: string): void {
  const id = uid('cb');
  const input = h('input', { id, type: 'text', role: 'combobox', 'aria-autocomplete': 'list', autocomplete: 'off' }) as HTMLInputElement;
  const wrap = h('div', { class: 'combobox combobox-list' }, h('div', { class: 'group' }, input, h('button', { type: 'button', tabindex: -1, 'aria-label': label, class: 'open' }, 'v')));
  host.appendChild(h('label', { for: id }, label));
  host.appendChild(wrap);
  const skin: ComboSkin = {
    popup: (lid) => {
      const list = h('ul', { role: 'listbox', id: lid, 'aria-label': label, 'data-list': '', 'aria-busy': 'false', style: 'background: #fff; border: 1px solid #888; list-style: none; padding: 0; max-height: 200px; overflow: auto' });
      return { shell: h('div', {}, h('div', { 'data-loading': '', class: 'loading', style: 'display: none' }, 'Loading...'), list), list };
    },
    option: (t, sel, i, oid) => h('li', { role: 'option', id: oid, 'aria-selected': sel ? 'true' : 'false' }, t),
  };
  const c = new ComboController(wrap, wrap, skin, { name: label, async: true, onChange: (v) => (input.value = v[0] ?? '') }, input);
  input.addEventListener('input', () => c.filter(input.value));
  wrap.querySelector('.open')!.addEventListener('click', () => (c.isOpen ? c.close() : c.open(input.value)));
}

// ------------------------------------------------------------------ accordion (APG)

export function ariaAccordion(host: HTMLElement, label: string): void {
  host.appendChild(h('div', { class: 'accordion', role: 'region', 'aria-label': label }, ['Shipping', 'Payment', 'Notes'].map((s) => {
    const panelId = uid('acc-panel');
    const panel = h('div', { id: panelId, role: 'region', hidden: true }, `${s} details`);
    const btn = h('button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId, onclick: () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      setTimeout(() => {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        panel.hidden = !open;
      }, 80);
    } }, s);
    return h('div', {}, h('h3', {}, btn), panel);
  })));
}

// ------------------------------------------------------------------ slider (APG)

export function ariaSlider(host: HTMLElement, label: string, min = 0, max = 100, value = 20, step = 5): void {
  const thumb = h('div', { role: 'slider', tabindex: 0, 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-label': label, class: 'thumb', style: 'display: inline-block; width: 16px; height: 16px; background: #36c' });
  const set = (v: number) => {
    const n = Math.max(min, Math.min(max, v));
    thumb.setAttribute('aria-valuenow', String(n));
    thumb.style.marginLeft = `${((n - min) / (max - min)) * 200}px`;
  };
  thumb.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    const now = Number(thumb.getAttribute('aria-valuenow'));
    if (k === 'ArrowRight' || k === 'ArrowUp') set(now + step);
    else if (k === 'ArrowLeft' || k === 'ArrowDown') set(now - step);
    else if (k === 'Home') set(min);
    else if (k === 'End') set(max);
    else return;
    e.preventDefault();
    log(`${label}=${thumb.getAttribute('aria-valuenow')}`);
  });
  set(value);
  host.appendChild(h('div', { class: 'slider-rail', style: 'width: 230px; padding: 6px; background: #eee' }, thumb));
}

// ------------------------------------------------------------------ drop zones

/** A generic drop zone: no file input, only drag-and-drop events. */
export function dropZone(host: HTMLElement, label: string): void {
  const list = h('ul', { class: 'files' });
  const zone = h('div', { role: 'region', 'aria-label': label, class: 'drop-zone', style: 'border: 2px dashed #888; padding: 16px; width: 300px' }, 'Drop files here', list);
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    for (const f of Array.from((e as DragEvent).dataTransfer?.files ?? [])) {
      list.appendChild(h('li', {}, `${f.name} (${f.size} bytes)`));
      log(`dropped ${f.name}`);
    }
  });
  host.appendChild(zone);
}

/** Dropzone.js markup: a hidden file input feeds the previews. */
export function dropzoneJs(host: HTMLElement, label: string): void {
  const input = h('input', { type: 'file', multiple: true, class: 'dz-hidden-input', style: 'visibility: hidden; position: absolute; top: 0; left: 0; height: 0; width: 0' }) as HTMLInputElement;
  const zone = h('form', { class: 'dropzone dz-clickable', 'aria-label': label, style: 'border: 2px dashed #36c; padding: 16px; width: 300px' }, h('div', { class: 'dz-default dz-message' }, h('button', { class: 'dz-button', type: 'button' }, 'Drop files here to upload')));
  const add = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      zone.classList.add('dz-started');
      zone.appendChild(h('div', { class: 'dz-preview dz-file-preview dz-success dz-complete' }, h('div', { class: 'dz-details' }, h('div', { class: 'dz-size' }, h('span', {}, `${f.size} B`)), h('div', { class: 'dz-filename' }, h('span', { 'data-dz-name': '' }, f.name)))));
      log(`uploaded ${f.name}`);
    }
  };
  input.addEventListener('change', () => input.files && add(input.files));
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    add((e as DragEvent).dataTransfer?.files ?? []);
  });
  zone.appendChild(input);
  host.appendChild(zone);
}

// ------------------------------------------------------------------ infinite feed (APG feed pattern)

export function infiniteFeed(host: HTMLElement, label: string, total = 250, batch = 25): void {
  const feed = h('div', { role: 'feed', 'aria-label': label, 'aria-busy': 'false', style: 'height: 300px; overflow-y: auto; border: 1px solid #ccc' });
  let n = 0;
  let loading = false;
  const more = () => {
    if (loading || n >= total) return;
    loading = true;
    feed.setAttribute('aria-busy', 'true');
    setTimeout(() => {
      for (let i = 0; i < batch && n < total; i++) {
        n++;
        feed.appendChild(h('article', { 'aria-posinset': n, 'aria-setsize': total, style: 'height: 40px; border-bottom: 1px solid #eee' }, `Item ${n}`));
      }
      loading = false;
      feed.setAttribute('aria-busy', 'false');
    }, 150);
  };
  feed.addEventListener('scroll', () => {
    if (feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 60) more();
  });
  host.appendChild(feed);
  more();
}

// ------------------------------------------------------------------ editors

export function contentEditable(host: HTMLElement, label: string): void {
  host.appendChild(h('div', { contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label, class: 'plain-editor', style: 'border: 1px solid #888; min-height: 60px; padding: 6px; width: 400px' }));
}

/** Quill's DOM: toolbar + .ql-container > .ql-editor[contenteditable]. */
export function quillEditor(host: HTMLElement): void {
  host.appendChild(h('div', { class: 'ql-toolbar ql-snow' }, h('span', { class: 'ql-formats' }, h('button', { type: 'button', class: 'ql-bold', 'aria-label': 'bold' }, 'B'))));
  const ed = h('div', { class: 'ql-editor ql-blank', contenteditable: 'true', 'data-placeholder': 'Compose...', role: 'textbox', 'aria-multiline': 'true', style: 'min-height: 60px; border: 1px solid #ccc; padding: 6px; width: 400px' }, h('p', {}, h('br', {})));
  ed.addEventListener('input', () => ed.classList.toggle('ql-blank', !ed.textContent));
  host.appendChild(h('div', { class: 'ql-container ql-snow' }, ed, h('div', { class: 'ql-clipboard', contenteditable: 'true', tabindex: -1 })));
}

/** CKEditor 5 classic editor DOM. */
export function ckEditor5(host: HTMLElement, label: string): void {
  const id = uid('cke');
  host.appendChild(h('div', { class: 'ck ck-reset ck-editor ck-rounded-corners', role: 'application', dir: 'ltr', lang: 'en', 'aria-labelledby': `${id}-label` },
    h('label', { class: 'ck ck-label ck-voice-label', id: `${id}-label`, style: 'display: none' }, `Rich Text Editor, ${label}`),
    h('div', { class: 'ck ck-editor__top ck-reset_all', role: 'presentation' }, h('div', { class: 'ck ck-sticky-panel' }, h('div', { class: 'ck ck-toolbar', role: 'toolbar', 'aria-label': 'Editor toolbar' }, h('button', { class: 'ck ck-button', type: 'button' }, 'Bold')))),
    h('div', { class: 'ck ck-editor__main', role: 'presentation' }, h('div', {
      class: 'ck-blurred ck ck-content ck-editor__editable ck-rounded-corners ck-editor__editable_inline', lang: 'en', dir: 'ltr', role: 'textbox', 'aria-label': `Editor editing area: main. Press Alt+0 for help.`,
      contenteditable: 'true', style: 'min-height: 60px; border: 1px solid #ccc; width: 400px',
    }, h('p', {}, h('br', { 'data-cke-filler': 'true' }))))));
}

// ------------------------------------------------------------------ charts

/** A canvas chart whose numbers are only available through an accessible data table. */
export function tableChart(host: HTMLElement, label: string): void {
  const tableId = uid('chart-data');
  const canvas = h('canvas', { width: 400, height: 160, role: 'img', 'aria-label': label, 'aria-describedby': tableId }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (ctx) MONTHLY_REVENUE.slice(0, 6).forEach((v, i) => ctx.fillRect(10 + i * 60, 150 - v / 3, 40, v / 3));
  host.appendChild(canvas);
  host.appendChild(h('details', {}, h('summary', {}, 'Data'), h('table', { id: tableId }, h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Orders'))),
    h('tbody', {}, MONTHS.slice(0, 6).map((m, i) => h('tr', {}, h('td', {}, m), h('td', {}, String(MONTHLY_REVENUE[i]))))))));
}

/** A canvas chart with nothing behind it (no library instance, no table). */
export function opaqueChart(host: HTMLElement, label: string): void {
  const canvas = h('canvas', { width: 300, height: 120, role: 'img', 'aria-label': label }) as HTMLCanvasElement;
  canvas.getContext('2d')?.fillRect(10, 10, 100, 80);
  host.appendChild(canvas);
}

/**
 * A Highcharts-style chart (Highcharts is commercial, so it is emulated): SVG
 * output plus the documented global `Highcharts.charts` array of chart
 * objects with `renderTo`, `xAxis[0].categories` and `series[i].points[j].y`.
 */
export function highchartsLike(host: HTMLElement, label: string): void {
  const container = h('div', { class: 'highcharts-container', 'aria-label': label, role: 'region', style: 'width: 400px; height: 160px' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'highcharts-root');
  svg.setAttribute('width', '400');
  svg.setAttribute('height', '160');
  container.appendChild(svg);
  host.appendChild(container);
  const w = window as unknown as { Highcharts?: { charts: unknown[] } };
  w.Highcharts ??= { charts: [] };
  const values = MONTHLY_REVENUE.map((v) => v * 2);
  w.Highcharts.charts.push({ renderTo: container, xAxis: [{ categories: MONTHS }], series: [{ name: 'Profit', points: values.map((y) => ({ y })) }] });
}

export { page };
