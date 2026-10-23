/**
 * Building blocks shared by the Assurance, Workbench and Project pages:
 * section pages with their own sub-navigation, loading / error / empty
 * states, run pickers, tables, downloads, uploads and small SVG charts.
 */
import { api } from '../core/api.js';
import { clear, h, svg, uid, type Child } from '../core/dom.js';
import { dateTime, relTime } from '../core/format.js';
import { registerCommand, registerPage } from '../core/registry.js';
import { link, navigate, type Route } from '../core/router.js';
import { button, emptyState } from '../ui/badge.js';
import { icon, type IconName } from '../ui/icons.js';

// ------------------------------------------------------------------ section pages

export interface SubInstance {
  /** Called when the sub-page becomes visible or its route changes (segments after the sub-page id). */
  show(segments: string[], query: URLSearchParams): void;
  hide?(): void;
  focus?(): void;
}

export interface SubPageDef {
  id: string;
  title: string;
  icon: IconName;
  /** One line under the title in the section navigation. */
  description: string;
  mount(el: HTMLElement): SubInstance;
}

export interface SectionDef {
  id: string;
  title: string;
  icon: IconName;
  order: number;
  group?: 'primary' | 'secondary';
  sections: SubPageDef[];
}

/** A page with its own section navigation (e.g. Assurance › Visual diff), deep-linkable as `#/<page>/<section>/...`. */
export function registerSectionPage(def: SectionDef): void {
  registerPage({
    id: def.id,
    title: def.title,
    icon: def.icon,
    route: def.id,
    group: def.group ?? 'primary',
    order: def.order,
    mount(ctx) {
      ctx.root.classList.add('page-section', `page-${def.id}`);
      const list = h('ul', { class: 'section-list' });
      const nav = h('nav', { class: 'section-nav', 'aria-label': `${def.title} sections` }, h('p', { class: 'section-nav-title', text: def.title }), list);
      const content = h('div', { class: 'section-content' });
      ctx.root.append(nav, content);
      const mounted = new Map<string, { root: HTMLElement; inst: SubInstance }>();
      let current: string | undefined;
      const links = new Map<string, HTMLAnchorElement>();
      for (const s of def.sections) {
        const a = h('a', { class: 'section-link', href: link(def.id, s.id), dataset: { section: s.id } }, icon(s.icon, { size: 16 }), h('span', { class: 'section-link-text' }, h('span', { class: 'section-link-title', text: s.title }), h('span', { class: 'section-link-desc', text: s.description })));
        links.set(s.id, a);
        list.appendChild(h('li', null, a));
      }
      const show = (r: Route) => {
        const [sub = def.sections[0].id, ...rest] = r.segments;
        const s = def.sections.find((x) => x.id === sub) ?? def.sections[0];
        let m = mounted.get(s.id);
        if (!m) {
          const root = h('section', { class: 'section-page', id: `${def.id}-${s.id}`, 'aria-label': s.title });
          content.appendChild(root);
          m = { root, inst: s.mount(root) };
          mounted.set(s.id, m);
        }
        const changed = current !== s.id;
        if (changed && current) {
          const prev = mounted.get(current)!;
          prev.root.hidden = true;
          prev.inst.hide?.();
        }
        current = s.id;
        m.root.hidden = false;
        for (const [id, a] of links) {
          if (id === s.id) a.setAttribute('aria-current', 'page');
          else a.removeAttribute('aria-current');
        }
        ctx.setTitle(`${s.title} · ${def.title}`);
        m.inst.show(s.id === sub ? rest : [], r.query);
        if (changed) setTimeout(() => (m!.inst.focus ? m!.inst.focus() : m!.root.querySelector<HTMLElement>('h1')?.focus()), 0);
      };
      return {
        show,
        hide: () => (current ? mounted.get(current)?.inst.hide?.() : undefined),
        focus: () => (current ? mounted.get(current)?.root.querySelector<HTMLElement>('h1')?.focus() : undefined),
      };
    },
  });
  for (const s of def.sections) {
    registerCommand({ id: `${def.id}.${s.id}`, title: `${def.title}: ${s.title}`, group: 'Navigate', icon: s.icon, keywords: [s.description], run: () => navigate(link(def.id, s.id)) });
  }
}

/** The standard header of a section page: h1 (focus target), description and actions. */
export function pageHeader(title: string, description: string, actions?: Child): HTMLElement {
  return h(
    'header',
    { class: 'page-head row-between' },
    h('div', null, h('h1', { class: 'page-title', tabindex: '-1', text: title }), h('p', { class: 'muted', text: description })),
    actions ? h('div', { class: 'row wrap' }, actions) : null,
  );
}

// ------------------------------------------------------------------ states

export function loadingState(text = 'Loading…'): HTMLElement {
  return h('p', { class: 'loading-state', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text }));
}

export function errorState(e: unknown, retry?: () => void): HTMLElement {
  const msg = e instanceof Error ? e.message : String(e);
  return h(
    'div',
    { class: 'error-state', role: 'alert' },
    icon('alert', { size: 18 }),
    h('div', { class: 'grow' }, h('p', { class: 'error-title', text: 'Something went wrong' }), h('p', { class: 'error-text', text: msg })),
    retry ? button('Try again', { small: true, icon: 'refresh', onclick: retry }) : null,
  );
}

export { emptyState };

/** Run `load` into `el` with loading and error states; returns the value (or undefined on error). */
const generations = new WeakMap<HTMLElement, number>();

/**
 * Run `load` into `el` with loading and error states; returns the value (or
 * undefined on error). When a newer load starts on the same element, the
 * older one resolves to undefined, so overlapping reloads never render twice.
 */
export async function withStates<T>(el: HTMLElement, load: () => Promise<T>, opts: { loading?: string; retry?: () => void } = {}): Promise<T | undefined> {
  const gen = (generations.get(el) ?? 0) + 1;
  generations.set(el, gen);
  clear(el).appendChild(loadingState(opts.loading));
  el.setAttribute('aria-busy', 'true');
  try {
    const v = await load();
    if (generations.get(el) !== gen) return undefined;
    clear(el);
    el.removeAttribute('aria-busy');
    return v;
  } catch (e) {
    if (generations.get(el) !== gen) return undefined;
    clear(el).appendChild(errorState(e, opts.retry));
    el.removeAttribute('aria-busy');
    return undefined;
  }
}

// ------------------------------------------------------------------ runs

export interface AssuranceRun {
  runId: string;
  startedAt?: string;
  summary?: { total: number; passed: number; passedHealed: number; failed: number; errors: number };
  lenses: string[];
}

let runsCache: Promise<AssuranceRun[]> | undefined;

export function assuranceRuns(fresh = false): Promise<AssuranceRun[]> {
  if (fresh || !runsCache) runsCache = api.get<{ runs: AssuranceRun[] }>('/api/assurance/runs').then((r) => r.runs);
  runsCache.catch(() => (runsCache = undefined));
  return runsCache;
}

/** A labelled select of recent runs that hold data for `lens` (or all runs). */
export function runPicker(opts: { label: string; lens?: string; onChange(runId: string): void }): { el: HTMLElement; set(runId: string | undefined): Promise<string | undefined>; refresh(): Promise<string | undefined> } {
  const id = uid('run-pick');
  const select = h('select', { id, class: 'input input-sm run-select', onchange: () => opts.onChange(select.value) });
  const el = h('div', { class: 'field inline-field' }, h('label', { for: id, text: opts.label }), select);
  let wanted: string | undefined;
  const fill = async (fresh: boolean) => {
    const runs = (await assuranceRuns(fresh)).filter((r) => !opts.lens || r.lenses.includes(opts.lens));
    clear(select);
    if (!runs.length) select.appendChild(h('option', { value: '', text: 'No runs with this data yet' }));
    for (const r of runs) {
      const s = r.summary;
      const outcome = s ? (s.failed + s.errors > 0 ? 'failed' : 'passed') : '';
      select.appendChild(h('option', { value: r.runId, text: `${r.startedAt ? `${dateTime(r.startedAt)} · ` : ''}${r.runId}${outcome ? ` · ${outcome}` : ''}` }));
    }
    const pick = wanted && runs.some((r) => r.runId === wanted) ? wanted : runs[0]?.runId;
    select.value = pick ?? '';
    select.disabled = !runs.length;
    return pick;
  };
  return {
    el,
    async set(runId) {
      wanted = runId;
      return fill(false);
    },
    refresh: () => fill(true),
  };
}

export function runLabel(r: { runId: string; startedAt?: string }): string {
  return r.startedAt ? `${relTime(r.startedAt)} (${r.runId})` : r.runId;
}

// ------------------------------------------------------------------ tables

export interface Col<T> {
  title: string;
  render(row: T): Child;
  class?: string;
  /** Visually hidden header (e.g. actions). */
  srOnly?: boolean;
}

export function dataTable<T>(opts: { caption: string; columns: Array<Col<T>>; rows: T[]; rowAttrs?(row: T, i: number): Record<string, unknown>; empty?: string; class?: string }): HTMLElement {
  if (!opts.rows.length) return h('p', { class: 'muted empty-row', text: opts.empty ?? 'Nothing to show.' });
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: ['table', 'compact', opts.class] },
      h('caption', { class: 'sr-only', text: opts.caption }),
      h('thead', null, h('tr', null, opts.columns.map((c) => h('th', { scope: 'col', class: c.class }, c.srOnly ? h('span', { class: 'sr-only', text: c.title }) : c.title)))),
      h('tbody', null, opts.rows.map((r, i) => h('tr', (opts.rowAttrs?.(r, i) ?? null) as never, opts.columns.map((c) => h('td', { class: c.class }, c.render(r)))))),
    ),
  );
}

export function kvList(entries: Array<[string, Child]>): HTMLElement {
  return h('dl', { class: 'kv' }, entries.map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]));
}

export function sevBadge(sev: string, label?: string): HTMLElement {
  const s = sev.toLowerCase();
  const tone = ['critical', 'high', 'error', 'serious', 'fail', 'failed', 'down', 'vulnerable', 'mismatch'].includes(s) ? 'bad' : ['moderate', 'medium', 'warning', 'warn', 'degraded', 'drift'].includes(s) ? 'warn' : ['ok', 'pass', 'passed', 'up', 'protected', 'match', 'info', 'minor', 'low'].includes(s) ? (['info', 'minor', 'low'].includes(s) ? 'info' : 'ok') : 'neutral';
  return h('span', { class: `sev sev-${tone}`, dataset: { sev: s } }, label ?? sev);
}

export function codeBlock(text: string, opts: { label?: string; tall?: boolean; id?: string } = {}): HTMLElement {
  return h('pre', { class: ['code-preview', 'code-block', opts.tall && 'tall'], tabindex: '0', id: opts.id, 'aria-label': opts.label, text });
}

// ------------------------------------------------------------------ files

/** Save text or bytes as a file in the browser (Blob URL; nothing leaves the machine). */
export function download(name: string, data: string | Blob, type = 'application/octet-stream'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  // Not attached to the document: the click alone starts the download.
  const a = h('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

/** An accessible file input styled as a button. */
export function filePicker(opts: { label: string; accept: string; onFile(f: File): void; id?: string }): HTMLElement {
  const id = opts.id ?? uid('file');
  const input = h('input', { type: 'file', id, accept: opts.accept, class: 'file-input', onchange: () => input.files?.[0] && opts.onFile(input.files[0]) });
  return h('span', { class: 'file-pick' }, input, h('label', { for: id, class: 'btn btn-sm' }, icon('upload'), h('span', { text: opts.label })));
}

// ------------------------------------------------------------------ charts

/** A line chart (inline SVG) with an accessible summary; values in `unit`. */
export function lineChart(points: Array<{ x: string; y: number | null }>, opts: { label: string; unit?: string; height?: number; width?: number; threshold?: number }): HTMLElement {
  const width = opts.width ?? 520;
  const height = opts.height ?? 120;
  const pad = 22;
  const ys = points.map((p) => p.y).filter((v): v is number => typeof v === 'number');
  const max = Math.max(1, ...ys, opts.threshold ?? 0) * 1.1;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => (p.y === null ? null : [pad + i * step, height - pad - (p.y / max) * (height - pad * 2)] as const));
  const d = coords.reduce((acc, c, i) => (c ? `${acc}${acc && coords[i - 1] ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}` : acc), '');
  const unit = opts.unit ?? '';
  const summary = ys.length ? `${opts.label}: ${ys.length} points, min ${Math.round(Math.min(...ys))}${unit}, max ${Math.round(Math.max(...ys))}${unit}, latest ${Math.round(ys[ys.length - 1])}${unit}` : `${opts.label}: no data`;
  return h(
    'figure',
    { class: 'chart' },
    svg(
      'svg',
      { class: 'line-chart', viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': summary, preserveAspectRatio: 'none' },
      svg('title', { text: summary }),
      svg('line', { class: 'axis', x1: pad, y1: height - pad, x2: width - pad, y2: height - pad }),
      opts.threshold !== undefined ? svg('line', { class: 'threshold', x1: pad, x2: width - pad, y1: height - pad - (opts.threshold / max) * (height - pad * 2), y2: height - pad - (opts.threshold / max) * (height - pad * 2) }) : null,
      svg('path', { class: 'series', d }),
      coords.map((c, i) => (c ? svg('circle', { class: 'dot', cx: c[0], cy: c[1], r: 2.5 }, svg('title', { text: `${points[i].x}: ${Math.round(points[i].y!)}${unit}` })) : null)),
      svg('text', { class: 'tick', x: 2, y: pad, text: `${Math.round(max)}${unit}` }),
    ),
    h('figcaption', { class: 'sr-only', text: summary }),
  );
}

/** Up/down strip: one cell per result (oldest left). */
export function statusStrip(results: Array<{ at: string; ok: boolean }>, label: string): HTMLElement {
  const up = results.filter((r) => r.ok).length;
  const summary = `${label}: ${up} of ${results.length} checks passed`;
  return h('div', { class: 'status-strip', role: 'img', 'aria-label': summary, title: summary }, results.slice(-60).map((r) => h('span', { class: ['strip-cell', r.ok ? 's-passed' : 's-failed'], title: `${dateTime(r.at)}: ${r.ok ? 'up' : 'down'}` })));
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A segmented control (aria-pressed buttons). */
export function segmented<T extends string>(opts: { label: string; options: Array<{ value: T; label: string; icon?: IconName }>; value: T; onChange(v: T): void }): { el: HTMLElement; set(v: T): void } {
  const buttons = opts.options.map((o) =>
    h('button', { type: 'button', class: 'seg', 'aria-pressed': String(o.value === opts.value), dataset: { value: o.value }, onclick: () => set(o.value, true) }, o.icon ? icon(o.icon, { size: 14 }) : null, h('span', { text: o.label })),
  );
  const el = h('div', { class: 'segmented', role: 'group', 'aria-label': opts.label }, buttons);
  const set = (v: T, notify = false) => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === v));
    if (notify) opts.onChange(v);
  };
  return { el, set: (v) => set(v) };
}

/** A labelled form field around a control. */
export function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const id = control.id || uid('f');
  control.id = id;
  const helpId = help ? uid('help') : undefined;
  if (helpId) control.setAttribute('aria-describedby', helpId);
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, help ? h('p', { class: 'help', id: helpId, text: help }) : null);
}
