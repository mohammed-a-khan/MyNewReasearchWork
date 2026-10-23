/**
 * Accessible SVG charts for the Quality Center (no chart library, CSP-safe):
 * a multi-series line chart, a stacked column chart and an outcome strip.
 *
 * Design rules (dataviz method): one y-axis per chart; categorical hues in a
 * fixed slot order (CSS tokens --series-N, separately stepped for dark); 2px
 * lines with ringed end markers; 4px rounded column tops and a 2px surface gap
 * between stacked segments; recessive hairline grid; a legend for 2+ series
 * plus a direct label at the line end; a hover/keyboard crosshair with a
 * tooltip; and a "Show as a table" view so nothing depends on colour or
 * pointer alone.
 */
import { h, svg, uid, type Child } from '../../core/dom.js';

export interface Series {
  id: string;
  label: string;
  /** Categorical slot 1..8 (fixed per entity, never by rank). */
  slot: number;
  values: Array<number | undefined>;
}

export interface ChartOpts {
  label: string;
  /** X labels (one per point). */
  x: string[];
  /** Long x labels for tooltips and the table. */
  xLong?: string[];
  format: (v: number) => string;
  /** Fixed y maximum (e.g. 1 for rates); default: nice max of the data. */
  yMax?: number;
  height?: number;
  width?: number;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function table(caption: string, head: string[], rows: Child[][]): HTMLElement {
  const thead = h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col', text: t }))));
  const tbody = h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, c) : h('td', null, c))))));
  const tbl = h('table', { class: 'table compact' }, h('caption', { class: 'sr-only', text: caption }), thead, tbody);
  return h('details', { class: 'q-chart-table' }, h('summary', { text: 'Show as a table' }), h('div', { class: 'q-table-scroll' }, tbl));
}

function legend(series: Array<{ label: string; slot: number }>): HTMLElement | null {
  if (series.length < 2) return null;
  return h('ul', { class: 'q-legend' }, series.map((s) => h('li', null, h('span', { class: `q-key q-s${s.slot}`, 'aria-hidden': 'true' }), h('span', { text: s.label }))));
}

/** Tooltip + crosshair shared by the charts: pointer and arrow keys move it. */
function hoverLayer(root: HTMLElement, plot: SVGSVGElement, n: number, xAt: (i: number) => number, describe: (i: number) => Child, onIndex: (i: number | undefined) => void) {
  const tip = h('div', { class: 'q-tip', role: 'status', hidden: true });
  root.appendChild(tip);
  let idx: number | undefined;
  const show = (i: number | undefined) => {
    idx = i;
    onIndex(i);
    if (i === undefined) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(h('div', null, describe(i)));
    tip.hidden = false;
    const box = plot.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    const vb = plot.viewBox.baseVal;
    const px = box.left - host.left + (xAt(i) / vb.width) * box.width;
    tip.style.left = `${Math.min(Math.max(8, px + 12), host.width - 200)}px`;
    tip.style.top = '8px';
  };
  plot.addEventListener('pointermove', (e) => {
    const box = plot.getBoundingClientRect();
    const vb = plot.viewBox.baseVal;
    const x = ((e.clientX - box.left) / box.width) * vb.width;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(xAt(i) - x) < Math.abs(xAt(best) - x)) best = i;
    show(best);
  });
  plot.addEventListener('pointerleave', () => show(undefined));
  plot.addEventListener('focus', () => show(idx ?? n - 1));
  plot.addEventListener('blur', () => show(undefined));
  plot.addEventListener('keydown', (e) => {
    if (!n) return;
    if (e.key === 'ArrowRight') show(Math.min(n - 1, (idx ?? -1) + 1));
    else if (e.key === 'ArrowLeft') show(Math.max(0, (idx ?? n) - 1));
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(n - 1);
    else if (e.key === 'Escape') show(undefined);
    else return;
    e.preventDefault();
  });
}

export function lineChart(series: Series[], o: ChartOpts): HTMLElement {
  const W = o.width ?? 640;
  const H = o.height ?? 200;
  const pad = { l: 44, r: 96, t: 12, b: 26 };
  const n = o.x.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== undefined));
  const yMax = o.yMax ?? niceMax(Math.max(0, ...all));
  const xAt = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i / (n - 1)) * (W - pad.l - pad.r));
  const yAt = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const desc = series.map((s) => {
    const vs = s.values.filter((v): v is number => v !== undefined);
    return `${s.label}: latest ${vs.length ? o.format(vs[vs.length - 1]) : 'n/a'}, range ${vs.length ? `${o.format(Math.min(...vs))} to ${o.format(Math.max(...vs))}` : 'n/a'}`;
  });
  const summary = `${o.label}, ${n} runs. ${desc.join('. ')}.`;
  // Direct end labels only where they do not collide; the legend and tooltip carry the rest.
  const ends = series
    .map((s) => {
      const i = s.values.map((v, k) => (v === undefined ? -1 : k)).filter((k) => k >= 0).pop();
      return i === undefined ? undefined : { id: s.id, y: yAt(s.values[i]!) };
    })
    .filter((e): e is { id: string; y: number } => !!e)
    .sort((a, b) => a.y - b.y);
  const endLabelled = new Set<string>();
  ends.forEach((e, k) => {
    const prev = ends[k - 1];
    const next = ends[k + 1];
    if ((!prev || e.y - prev.y >= 13) && (!next || next.y - e.y >= 13)) endLabelled.add(e.id);
  });
  const cross = svg('line', { class: 'q-cross', x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
  const hl = svg('g', { class: 'q-hl' });
  const plot = svg(
    'svg',
    { class: 'q-chart', viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': summary, tabindex: '0', preserveAspectRatio: 'xMidYMid meet' },
    svg('title', { text: summary }),
    ticks.map((t) => svg('g', null, svg('line', { class: 'q-grid', x1: pad.l, x2: W - pad.r, y1: yAt(t), y2: yAt(t) }), svg('text', { class: 'q-axis', x: pad.l - 6, y: yAt(t) + 4, 'text-anchor': 'end', text: o.format(t) }))),
    n > 0 ? svg('text', { class: 'q-axis', x: xAt(0), y: H - 8, 'text-anchor': 'start', text: o.x[0] }) : null,
    n > 1 ? svg('text', { class: 'q-axis', x: xAt(n - 1), y: H - 8, 'text-anchor': 'end', text: o.x[n - 1] }) : null,
    series.map((s) => {
      const pts = s.values.map((v, i) => (v === undefined ? undefined : [xAt(i), yAt(v)] as const));
      let d = '';
      let pen = false;
      for (const p of pts) {
        if (!p) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        pen = true;
      }
      const lastI = pts.map((p, i) => (p ? i : -1)).filter((i) => i >= 0).pop();
      const last = lastI !== undefined ? pts[lastI] : undefined;
      return svg(
        'g',
        { class: `q-series q-s${s.slot}` },
        svg('path', { class: 'q-line', d }),
        last ? svg('circle', { class: 'q-dot', cx: last[0], cy: last[1], r: 4 }) : null,
        last && lastI !== undefined && endLabelled.has(s.id) ? svg('text', { class: 'q-endlabel', x: last[0] + 8, y: last[1] + 4, text: `${s.label} ${o.format(s.values[lastI]!)}` }) : null,
      );
    }),
    cross,
    hl,
  );
  const root = h('figure', { class: 'q-figure' });
  root.append(plot);
  hoverLayer(
    root,
    plot,
    n,
    xAt,
    (i) => [h('strong', { text: o.xLong?.[i] ?? o.x[i] }), h('ul', { class: 'q-tip-list' }, series.map((s) => h('li', null, h('span', { class: `q-key q-s${s.slot}`, 'aria-hidden': 'true' }), `${s.label}: ${s.values[i] === undefined ? 'n/a' : o.format(s.values[i]!)}`)))],
    (i) => {
      hl.replaceChildren();
      if (i === undefined) {
        cross.setAttribute('visibility', 'hidden');
        return;
      }
      cross.setAttribute('visibility', 'visible');
      cross.setAttribute('x1', String(xAt(i)));
      cross.setAttribute('x2', String(xAt(i)));
      for (const s of series) {
        const v = s.values[i];
        if (v !== undefined) hl.appendChild(svg('circle', { class: `q-dot q-s${s.slot}`, cx: xAt(i), cy: yAt(v), r: 5 }));
      }
    },
  );
  root.append(
    legend(series) ?? h('span'),
    table(o.label, ['Run', ...series.map((s) => s.label)], o.x.map((x, i) => [o.xLong?.[i] ?? x, ...series.map((s) => (s.values[i] === undefined ? '–' : o.format(s.values[i]!)))])),
  );
  return root;
}

export interface StackRow {
  x: string;
  xLong?: string;
  values: Record<string, number>;
}

/** Stacked columns per run (e.g. failures by classification). */
export function stackedColumns(rows: StackRow[], keys: Array<{ id: string; label: string; slot: number }>, o: { label: string; height?: number; width?: number }): HTMLElement {
  const W = o.width ?? 640;
  const H = o.height ?? 200;
  const pad = { l: 36, r: 8, t: 10, b: 26 };
  const n = rows.length;
  const totals = rows.map((r) => keys.reduce((s, k) => s + (r.values[k.id] ?? 0), 0));
  const yMax = niceMax(Math.max(1, ...totals));
  const band = n ? (W - pad.l - pad.r) / n : 0;
  const bw = Math.min(24, Math.max(3, band * 0.6));
  const xAt = (i: number) => pad.l + band * i + band / 2;
  const yAt = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const totalAll = keys.map((k) => ({ ...k, sum: rows.reduce((s, r) => s + (r.values[k.id] ?? 0), 0) }));
  const summary = `${o.label}, ${n} runs: ${totalAll.map((k) => `${k.label} ${k.sum}`).join(', ')}.`;
  const ticks = [...new Set([0, Math.round(yMax / 2), yMax])];
  const cols = rows.map((r, i) => {
    let base = 0;
    const segs: SVGElement[] = [];
    const present = keys.filter((k) => (r.values[k.id] ?? 0) > 0);
    present.forEach((k, j) => {
      const v = r.values[k.id] ?? 0;
      const y0 = yAt(base);
      const y1 = yAt(base + v);
      base += v;
      const top = j === present.length - 1;
      const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const hh = Math.max(1, y0 - y1 - gap);
      const x = xAt(i) - bw / 2;
      const y = y1;
      // Rounded data end (top) only, square at the baseline.
      const rr = top ? Math.min(4, bw / 2, hh) : 0;
      const d = `M${x},${y + hh} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + bw - rr},${y} Q${x + bw},${y} ${x + bw},${y + rr} L${x + bw},${y + hh} Z`;
      segs.push(svg('path', { class: `q-seg q-s${k.slot}`, d }));
    });
    return svg('g', { class: 'q-col' }, segs);
  });
  const hl = svg('rect', { class: 'q-colhl', x: 0, y: pad.t, width: band, height: H - pad.t - pad.b, visibility: 'hidden' });
  const plot = svg(
    'svg',
    { class: 'q-chart', viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': summary, tabindex: '0' },
    svg('title', { text: summary }),
    hl,
    ticks.map((t) => svg('g', null, svg('line', { class: 'q-grid', x1: pad.l, x2: W - pad.r, y1: yAt(t), y2: yAt(t) }), svg('text', { class: 'q-axis', x: pad.l - 6, y: yAt(t) + 4, 'text-anchor': 'end', text: String(Math.round(t)) }))),
    cols,
    n > 0 ? svg('text', { class: 'q-axis', x: xAt(0), y: H - 8, 'text-anchor': 'start', text: rows[0].x }) : null,
    n > 1 ? svg('text', { class: 'q-axis', x: xAt(n - 1), y: H - 8, 'text-anchor': 'end', text: rows[n - 1].x }) : null,
  );
  const root = h('figure', { class: 'q-figure' }, plot);
  hoverLayer(
    root,
    plot,
    n,
    xAt,
    (i) => [h('strong', { text: rows[i].xLong ?? rows[i].x }), h('ul', { class: 'q-tip-list' }, keys.map((k) => h('li', null, h('span', { class: `q-key q-s${k.slot}`, 'aria-hidden': 'true' }), `${k.label}: ${rows[i].values[k.id] ?? 0}`)))],
    (i) => {
      hl.setAttribute('visibility', i === undefined ? 'hidden' : 'visible');
      if (i !== undefined) hl.setAttribute('x', String(xAt(i) - band / 2));
    },
  );
  root.append(legend(keys) ?? h('span'), table(o.label, ['Run', ...keys.map((k) => k.label), 'Total'], rows.map((r, i) => [r.xLong ?? r.x, ...keys.map((k) => String(r.values[k.id] ?? 0)), String(totals[i])])));
  return root;
}

export interface StripCell {
  status: string;
  label: string;
  href?: string;
}

const STRIP_NAME: Record<string, string> = { passed: 'passed', 'passed-healed': 'passed with healing', failed: 'failed', error: 'error', skipped: 'skipped', 'not-run': 'not run' };

/** Per-run outcome strip as SVG (one square per run, oldest left) with shape cues for failures. */
export function outcomeStripSvg(cells: StripCell[], label: string): SVGSVGElement {
  const size = 12;
  const gap = 3;
  const W = Math.max(1, cells.length * (size + gap) - gap);
  const counts: Record<string, number> = {};
  for (const c of cells) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const summary = `${label}: ${Object.entries(counts).map(([k, v]) => `${v} ${STRIP_NAME[k] ?? k}`).join(', ')} over the last ${cells.length} runs (oldest first)`;
  const id = uid('strip');
  return svg(
    'svg',
    { class: 'q-strip', viewBox: `0 0 ${W} ${size}`, width: W, height: size, role: 'img', 'aria-label': summary, id },
    svg('title', { text: summary }),
    cells.map((c, i) => {
      const x = i * (size + gap);
      const cls = `q-cell q-cell-${c.status.replace(/[^\w-]/g, '')}`;
      return svg(
        'g',
        { class: cls },
        svg('title', { text: `${c.label}: ${STRIP_NAME[c.status] ?? c.status}` }),
        svg('rect', { x, y: 0, width: size, height: size, rx: 2 }),
        c.status === 'failed' || c.status === 'error' ? svg('path', { class: 'q-cell-mark', d: `M${x + 3.5},3.5 L${x + size - 3.5},${size - 3.5} M${x + size - 3.5},3.5 L${x + 3.5},${size - 3.5}` }) : null,
        c.status === 'passed-healed' ? svg('circle', { class: 'q-cell-mark', cx: x + size / 2, cy: size / 2, r: 2 }) : null,
      );
    }),
  );
}

/** Horizontal bars with the value at the tip (slowest journeys / steps). */
export function barList(items: Array<{ label: string; sub?: string; value: number; href?: string }>, o: { label: string; format: (v: number) => string }): HTMLElement {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h(
    'ol',
    { class: 'q-bars', 'aria-label': o.label },
    items.map((it) =>
      h(
        'li',
        { class: 'q-bar-row' },
        h('div', { class: 'q-bar-label' }, it.href ? h('a', { href: it.href, text: it.label }) : h('span', { text: it.label }), it.sub ? h('span', { class: 'muted small', text: it.sub }) : null),
        h('div', { class: 'q-bar-track' }, h('span', { class: 'q-bar q-s1', style: { width: `${Math.max(1, (it.value / max) * 100)}%` } }), h('span', { class: 'q-bar-val', text: o.format(it.value) })),
      ),
    ),
  );
}
