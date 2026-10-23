/**
 * EZTest's own SVG charts for the reports: donut, line (with a hover column
 * per point), column/histogram, horizontal bars, heat map, Gantt timeline and
 * meters. No chart library. Every chart:
 *
 * - is static SVG (it prints, e-mails and renders without script);
 * - has role="img" with a title and a description, and a data-table twin;
 * - colours marks through CSS tokens (status colours are never text colours);
 * - carries `data-tip` on each mark: the report script turns it into a
 *   tooltip on hover and keyboard focus (tooltips enhance, the table gates).
 *
 * Marks follow fixed specs: bars <= 24 px with a 4 px rounded end and square
 * baseline, 2 px lines, >= 8 px markers with a 2 px surface ring, 2 px
 * surface gaps between touching fills, hairline solid grid lines.
 */
import { escapeHtml as e } from './escape.js';

let seq = 0;
const uid = (p: string) => `${p}${(++seq).toString(36)}`;
/** Reset ids (tests compare renders). */
export function resetChartIds(): void {
  seq = 0;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m} min${rs ? ` ${rs} s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export const fmtPct = (r: number, digits = 1) => `${(Number.isFinite(r) ? r * 100 : 0).toFixed(digits)}%`;

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n * 100) / 100);
}

/** Clean axis ticks from 0 to >= max. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

export interface TableTwin {
  caption: string;
  head: string[];
  rows: Array<Array<string | number>>;
}

function table(t: TableTwin): string {
  return `<details class="viz-table"><summary>Data table</summary><table><caption>${e(t.caption)}</caption><thead><tr>${t.head.map((h) => `<th scope="col">${e(h)}</th>`).join('')}</tr></thead><tbody>${t.rows
    .map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${e(c)}</th>` : `<td>${e(c)}</td>`)).join('')}</tr>`)
    .join('')}</tbody></table></details>`;
}

const interactive = (body: string) => /tabindex="0"|<a /.test(body);

function frame(id: string, w: number, h: number, title: string, desc: string, body: string, cls = '', fixed = false): string {
  return `<svg class="viz ${cls}" viewBox="0 0 ${w} ${h}" width="${fixed ? w : '100%'}" style="max-width:100%" preserveAspectRatio="xMidYMid meet" role="${interactive(body) ? 'group' : 'img'}" aria-labelledby="${id}-t ${id}-d" focusable="false"><title id="${id}-t">${e(title)}</title><desc id="${id}-d">${e(desc)}</desc>${body}</svg>`;
}

const tipAttr = (tip: string, focusable: boolean) => ` data-tip="${e(tip)}"${focusable ? ' tabindex="0" role="graphics-symbol" aria-label="' + e(tip) + '"' : ''}`;

/** A bar path with a 4 px rounded data-end and a square baseline. Vertical: grows up from y0. */
function vbar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function hbar(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h / 2, w);
  if (w <= 0) return '';
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

// ------------------------------------------------------------------ donut

export interface Segment {
  key: string;
  label: string;
  value: number;
}

/** Part-to-whole donut (<= 6 segments), legend with counts and shares, centre figure. */
export function donutChart(segs: Segment[], o: { title: string; centre: string; centreLabel: string; size?: number }): string {
  const id = uid('d');
  const size = o.size ?? 180;
  const total = segs.reduce((n, s) => n + s.value, 0);
  const r = size / 2 - 6;
  const inner = r - 22;
  const cx = size / 2;
  const cy = size / 2;
  const shown = segs.filter((s) => s.value > 0);
  let a0 = -Math.PI / 2;
  const gap = shown.length > 1 ? 2 / r : 0; // 2 px surface gap
  const arcs = shown
    .map((s) => {
      const frac = s.value / total;
      const a1 = a0 + frac * Math.PI * 2;
      const start = a0 + gap / 2;
      const end = Math.max(start + 0.0001, a1 - gap / 2);
      a0 = a1;
      const large = end - start > Math.PI ? 1 : 0;
      const p = (rad: number, ang: number) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
      const d = frac >= 0.9999
        ? `M${cx - r},${cy}A${r},${r} 0 1 1 ${cx + r},${cy}A${r},${r} 0 1 1 ${cx - r},${cy}ZM${cx - inner},${cy}A${inner},${inner} 0 1 0 ${cx + inner},${cy}A${inner},${inner} 0 1 0 ${cx - inner},${cy}Z`
        : `M${p(r, start)}A${r},${r} 0 ${large} 1 ${p(r, end)}L${p(inner, end)}A${inner},${inner} 0 ${large} 0 ${p(inner, start)}Z`;
      const tip = `${s.label}: ${s.value} (${fmtPct(s.value / total)})`;
      return `<path class="mark st-${e(s.key)}" d="${d}" fill-rule="evenodd"${tipAttr(tip, true)}/>`;
    })
    .join('');
  const empty = total === 0 ? `<circle cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" class="track" fill="none" stroke-width="22"/>` : '';
  const centre = `<text x="${cx}" y="${cy - 2}" text-anchor="middle" class="viz-hero">${e(o.centre)}</text><text x="${cx}" y="${cy + 18}" text-anchor="middle" class="viz-muted">${e(o.centreLabel)}</text>`;
  const desc = segs.map((s) => `${s.label} ${s.value}`).join(', ');
  const legend = `<ul class="legend">${segs
    .map((s) => `<li><span class="key st-${e(s.key)}" aria-hidden="true"></span><span class="lk">${e(s.label)}</span><span class="lv">${e(s.value)}</span><span class="lp">${total ? e(fmtPct(s.value / total)) : '-'}</span></li>`)
    .join('')}</ul>`;
  return `<div class="donut">${frame(id, size, size, o.title, `${desc}. Total ${total}.`, empty + arcs + centre)}${legend}</div>${table({ caption: o.title, head: ['Outcome', 'Tests', 'Share'], rows: segs.map((s) => [s.label, s.value, total ? fmtPct(s.value / total) : '-']) })}`;
}

// ------------------------------------------------------------------ line

export interface LinePoint {
  label: string;
  value: number;
  /** Tooltip detail lines. */
  detail?: string;
  current?: boolean;
}

/** One series line (2 px) with end-point label, recessive grid, hover column per point. */
export function lineChart(pts: LinePoint[], o: { title: string; yMax?: number; yFormat: (v: number) => string; width?: number; height?: number; series: string; area?: boolean }): string {
  const id = uid('l');
  const W = o.width ?? 560;
  const H = o.height ?? 200;
  const m = { l: 44, r: 56, t: 12, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = o.yMax ?? Math.max(...pts.map((p) => p.value), 0);
  const ticks = o.yMax === 1 ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(max || 1);
  const top = ticks[ticks.length - 1] || 1;
  const x = (i: number) => m.l + (pts.length <= 1 ? iw / 2 : (i * iw) / (pts.length - 1));
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const grid = ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${m.l + iw}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="tick" x="${m.l - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${e(o.yFormat(t))}</text>`).join('');
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = o.area && pts.length > 1 ? `<path class="area ${e(o.series)}" d="${path}L${x(pts.length - 1).toFixed(1)},${m.t + ih}L${x(0).toFixed(1)},${m.t + ih}Z"/>` : '';
  const every = Math.max(1, Math.ceil(pts.length / 6));
  const xl = pts.map((p, i) => (i % every === 0 || i === pts.length - 1 ? `<text class="tick" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${e(p.label)}</text>` : '')).join('');
  const colW = pts.length > 1 ? iw / (pts.length - 1) : iw;
  const hits = pts
    .map((p, i) => {
      const tip = `${p.label}: ${o.yFormat(p.value)}${p.detail ? ` - ${p.detail}` : ''}${p.current ? ' (this run)' : ''}`;
      return `<g class="hit"${tipAttr(tip, pts.length <= 40)}><rect x="${(x(i) - colW / 2).toFixed(1)}" y="${m.t}" width="${Math.max(colW, 24).toFixed(1)}" height="${ih}" fill="transparent"/><line class="guide" x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${m.t}" y2="${m.t + ih}"/></g>`;
    })
    .join('');
  const last = pts[pts.length - 1];
  const markers = pts.map((p, i) => (p.current || i === pts.length - 1 ? `<circle class="dot ${e(o.series)}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4.5"/>` : '')).join('');
  const endLabel = last ? `<text class="endlabel" x="${(x(pts.length - 1) + 8).toFixed(1)}" y="${(y(last.value) + 4).toFixed(1)}">${e(o.yFormat(last.value))}</text>` : '';
  const body = `${grid}<line class="axis" x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/>${area}<path class="line ${e(o.series)}" d="${path}" fill="none"/>${markers}${endLabel}${xl}${hits}`;
  const desc = pts.length ? `${pts.length} runs from ${pts[0].label} to ${last.label}; latest ${o.yFormat(last.value)}; lowest ${o.yFormat(Math.min(...pts.map((p) => p.value)))}; highest ${o.yFormat(Math.max(...pts.map((p) => p.value)))}.` : 'No data.';
  return `${frame(id, W, H, o.title, desc, body, 'linechart')}${table({ caption: o.title, head: ['Run', o.title], rows: pts.map((p) => [p.label + (p.current ? ' (this run)' : ''), o.yFormat(p.value)]) })}`;
}

// ------------------------------------------------------------------ columns (histogram, per-run bars)

export interface Column {
  label: string;
  value: number;
  tip?: string;
  cls?: string;
}

export function columnChart(cols: Column[], o: { title: string; yLabel: string; yFormat?: (v: number) => string; width?: number; height?: number; cls?: string }): string {
  const id = uid('c');
  const W = o.width ?? 560;
  const H = o.height ?? 200;
  const m = { l: 44, r: 12, t: 16, b: 34 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const fmt = o.yFormat ?? ((v: number) => compact(v));
  const ticks = niceTicks(Math.max(...cols.map((c) => c.value), 0) || 1);
  const top = ticks[ticks.length - 1] || 1;
  const band = iw / Math.max(1, cols.length);
  const bw = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const grid = ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${m.l + iw}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="tick" x="${m.l - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${e(fmt(t))}</text>`).join('');
  const every = Math.max(1, Math.ceil(cols.length / (W < 600 ? 7 : 10)));
  const bars = cols
    .map((c, i) => {
      const cx = m.l + band * i + band / 2;
      const h = (c.value / top) * ih;
      const tip = c.tip ?? `${c.label}: ${fmt(c.value)}`;
      return `<g class="hit"${tipAttr(tip, cols.length <= 40)}><rect x="${(cx - band / 2).toFixed(1)}" y="${m.t}" width="${band.toFixed(1)}" height="${ih}" fill="transparent"/>${h > 0 ? `<path class="mark ${e(c.cls ?? o.cls ?? 'series-1')}" d="${vbar(cx - bw / 2, y(c.value), bw, h)}"/>` : ''}</g>${i % every === 0 ? `<text class="tick" x="${cx.toFixed(1)}" y="${H - 18}" text-anchor="middle">${e(c.label)}</text>` : ''}`;
    })
    .join('');
  const body = `${grid}${bars}<line class="axis" x1="${m.l}" x2="${m.l + iw}" y1="${m.t + ih}" y2="${m.t + ih}"/><text class="tick" x="${m.l + iw / 2}" y="${H - 3}" text-anchor="middle">${e(o.yLabel)}</text>`;
  const desc = cols.map((c) => `${c.label}: ${fmt(c.value)}`).join('; ');
  return `${frame(id, W, H, o.title, desc, body, 'colchart')}${table({ caption: o.title, head: [o.yLabel, 'Value'], rows: cols.map((c) => [c.label, fmt(c.value)]) })}`;
}

// ------------------------------------------------------------------ horizontal bars

export interface HBar {
  label: string;
  value: number;
  valueLabel: string;
  cls?: string;
  href?: string;
  tip?: string;
}

export function hbarChart(rows: HBar[], o: { title: string; unit: string; width?: number; labelWidth?: number }): string {
  const id = uid('h');
  const W = o.width ?? 560;
  const lw = o.labelWidth ?? 210;
  const rowH = 28;
  const H = rows.length * rowH + 8;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const iw = W - lw - 78;
  const bars = rows
    .map((r, i) => {
      const y = 4 + i * rowH;
      const w = (r.value / max) * iw;
      const label = r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label;
      const text = `<text class="blabel" x="${lw - 8}" y="${y + 17}" text-anchor="end">${e(label)}</text>`;
      const link = r.href ? `<a href="${e(r.href)}" aria-label="${e(`${r.label}: ${r.valueLabel}`)}">${text}</a>` : text;
      return `<g class="hit"${tipAttr(r.tip ?? `${r.label}: ${r.valueLabel}`, false)}>${link}<rect x="${lw}" y="${y}" width="${iw}" height="${rowH - 2}" fill="transparent"/>${w > 0 ? `<path class="mark ${e(r.cls ?? 'series-1')}" d="${hbar(lw, y + 5, w, 16)}"/>` : ''}<text class="bvalue" x="${(lw + w + 6).toFixed(1)}" y="${y + 17}">${e(r.valueLabel)}</text></g>`;
    })
    .join('');
  const body = `<line class="axis" x1="${lw}" x2="${lw}" y1="2" y2="${H - 2}"/>${bars}`;
  return `${frame(id, W, H, o.title, rows.map((r) => `${r.label}: ${r.valueLabel}`).join('; ') || 'No data.', body, 'hbarchart')}${table({ caption: o.title, head: ['Item', o.unit], rows: rows.map((r) => [r.label, r.valueLabel]) })}`;
}

// ------------------------------------------------------------------ heat map

/** Rows x columns of rates 0..1 (null = no data), one-hue sequential ramp with a scale legend. */
export function heatmap(rowLabels: string[], colLabels: string[], values: Array<Array<{ rate: number; n: number } | null>>, o: { title: string; valueLabel: string; width?: number }): string {
  const id = uid('m');
  const lw = 150;
  const cw = Math.max(14, Math.min(44, ((o.width ?? 560) - lw - 10) / Math.max(1, colLabels.length)));
  const W = Math.max(lw + colLabels.length * cw + 10, lw + 7 * 62 + 70);
  const ch = 22;
  const top = 34;
  const H = top + rowLabels.length * ch + 40;
  const step = (r: number) => (r <= 0 ? 0 : r < 0.1 ? 1 : r < 0.25 ? 2 : r < 0.5 ? 3 : r < 0.75 ? 4 : 5);
  const every = Math.max(1, Math.ceil(colLabels.length / 12));
  const cols = colLabels.map((c, i) => (i % every === 0 ? `<text class="tick" x="${lw + i * cw + cw / 2}" y="${top - 8}" text-anchor="middle">${e(c)}</text>` : '')).join('');
  const cells = rowLabels
    .map((r, ri) => {
      const label = r.length > 22 ? `${r.slice(0, 21)}…` : r;
      const row = values[ri]
        .map((v, ci) => {
          const x = lw + ci * cw;
          const y = top + ri * ch;
          if (!v) return `<rect class="cell none" x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="2"${tipAttr(`${r}, ${colLabels[ci]}: no runs`, false)}/>`;
          return `<rect class="cell q${step(v.rate)}" x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="2"${tipAttr(`${r}, ${colLabels[ci]}: ${o.valueLabel} ${fmtPct(v.rate)} of ${v.n}`, false)}/>`;
        })
        .join('');
      return `<text class="blabel" x="${lw - 8}" y="${top + ri * ch + 15}" text-anchor="end">${e(label)}</text>${row}`;
    })
    .join('');
  const ly = top + rowLabels.length * ch + 14;
  const legend = ['0%', '<10%', '<25%', '<50%', '<75%', '75%+']
    .map((l, i) => `<rect class="cell q${i}" x="${lw + i * 62}" y="${ly}" width="14" height="14" rx="2"/><text class="tick" x="${lw + i * 62 + 18}" y="${ly + 11}">${e(l)}</text>`)
    .join('') + `<rect class="cell none" x="${lw + 6 * 62}" y="${ly}" width="14" height="14" rx="2"/><text class="tick" x="${lw + 6 * 62 + 18}" y="${ly + 11}">no runs</text>`;
  const rowsT = rowLabels.map((r, ri) => [r, ...values[ri].map((v) => (v ? `${fmtPct(v.rate)} (${v.n})` : '-'))]);
  return `${frame(id, W, H, o.title, `${o.valueLabel} for ${rowLabels.length} rows over ${colLabels.length} columns.`, cols + cells + legend, 'heatmap', true)}${table({ caption: o.title, head: ['', ...colLabels], rows: rowsT })}`;
}

// ------------------------------------------------------------------ Gantt timeline

export interface Span {
  id: string;
  label: string;
  start: number;
  end: number;
  cls: string;
  href?: string;
}

/** Lanes of non-overlapping spans (parallel workers inferred from overlap). */
export function assignLanes(spans: Span[]): Span[][] {
  const lanes: Span[][] = [];
  const ends: number[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let li = ends.findIndex((end) => end <= s.start);
    if (li < 0) {
      li = lanes.length;
      lanes.push([]);
      ends.push(0);
    }
    lanes[li].push(s);
    ends[li] = s.end;
  }
  return lanes;
}

export function ganttChart(spans: Span[], o: { title: string; totalMs: number; width?: number; maxLanes?: number }): string {
  const id = uid('g');
  const all = assignLanes(spans);
  const lanes = all.slice(0, o.maxLanes ?? 16);
  const W = o.width ?? 1000;
  const lw = 70;
  const lh = 18;
  const H = lanes.length * (lh + 4) + 36;
  const total = Math.max(o.totalMs, ...spans.map((s) => s.end), 1);
  const iw = W - lw - 12;
  const x = (ms: number) => lw + (ms / total) * iw;
  const ticks = niceTicks(total, 6).filter((t) => t <= total * 1.001);
  const grid = ticks.map((t) => `<line class="grid" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="4" y2="${H - 26}"/><text class="tick" x="${x(t).toFixed(1)}" y="${H - 10}" text-anchor="middle">${e(fmtMs(t))}</text>`).join('');
  const many = spans.length > 300;
  const rows = lanes
    .map((lane, li) => {
      const y = 6 + li * (lh + 4);
      const marks = lane
        .map((s) => {
          const w = Math.max(1, x(s.end) - x(s.start) - 1);
          const r = `<rect class="mark ${e(s.cls)}" x="${x(s.start).toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${lh}" rx="${w > 6 ? 3 : 0}"${many ? '' : tipAttr(`${s.label}: ${fmtMs(s.end - s.start)}`, false)}/>`;
          return s.href && !many ? `<a href="${e(s.href)}" aria-label="${e(`${s.label}, ${fmtMs(s.end - s.start)}`)}">${r}</a>` : r;
        })
        .join('');
      return `<text class="tick" x="${lw - 8}" y="${y + 13}" text-anchor="end">Lane ${li + 1}</text>${marks}`;
    })
    .join('');
  const note = all.length > lanes.length ? ` ${all.length - lanes.length} more lanes not drawn.` : '';
  return frame(id, W, H, o.title, `${spans.length} tests on ${all.length} parallel lanes over ${fmtMs(total)}.${note}`, grid + rows, 'gantt');
}

// ------------------------------------------------------------------ meter

export function meter(ratio: number, o: { label: string; detail: string; tone?: 'good' | 'warn' | 'bad' }): string {
  const pct = Math.max(0, Math.min(1, ratio));
  const tone = o.tone ?? (pct >= 0.9 ? 'good' : pct >= 0.7 ? 'warn' : 'bad');
  return `<div class="meter"><div class="meter-head"><span class="meter-label">${e(o.label)}</span><span class="meter-value">${e(fmtPct(pct))}</span></div><div class="meter-track t-${tone}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct * 100)}" aria-label="${e(`${o.label} ${fmtPct(pct)}`)}"><div class="meter-fill t-${tone}" style="width:${(pct * 100).toFixed(1)}%"></div></div><div class="meter-detail">${e(o.detail)}</div></div>`;
}

/** Duration distribution bins (log-ish edges that read well: <1s, 1-2s, 2-5s, ...). */
export function durationBins(durations: number[]): Column[] {
  const edges = [0, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, Infinity];
  const labels = ['<0.5s', '0.5-1s', '1-2s', '2-5s', '5-10s', '10-30s', '30-60s', '1-2m', '2-5m', '5m+'];
  const counts = new Array(labels.length).fill(0) as number[];
  for (const d of durations) {
    const i = edges.findIndex((x, k) => d >= x && d < edges[k + 1]);
    counts[Math.max(0, i)]++;
  }
  let last = counts.length - 1;
  while (last > 3 && counts[last] === 0) last--;
  return labels.slice(0, last + 1).map((label, i) => ({ label, value: counts[i], tip: `${label}: ${counts[i]} test${counts[i] === 1 ? '' : 's'}` }));
}
