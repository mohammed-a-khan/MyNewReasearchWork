/**
 * Run trend as inline SVG: one stacked bar per run (passed, healed, failed),
 * oldest left. The chart is an image with a text summary for screen readers;
 * each bar has a native tooltip. Colours come from CSS tokens.
 */
import { h, svg } from '../core/dom.js';

export interface TrendPoint {
  runId: string;
  startedAt?: string;
  passed: number;
  healed: number;
  failed: number;
  total: number;
}

export function trendChart(points: TrendPoint[], opts: { width?: number; height?: number; label?: string } = {}): HTMLElement {
  const width = opts.width ?? 320;
  const height = opts.height ?? 64;
  const n = points.length;
  const totals = points.map((p) => Math.max(1, p.passed + p.healed + p.failed));
  const gap = n > 40 ? 1 : 2;
  const bw = n ? Math.max(2, (width - gap * (n - 1)) / n) : 0;
  const sum = points.reduce((a, p) => ({ passed: a.passed + p.passed, healed: a.healed + p.healed, failed: a.failed + p.failed }), { passed: 0, healed: 0, failed: 0 });
  const last = points[n - 1];
  const summary = n
    ? `${opts.label ?? 'Run trend'}: last ${n} run${n === 1 ? '' : 's'}, ${sum.passed} passed, ${sum.healed} healed, ${sum.failed} failed journey results.` +
      (last ? ` Latest run: ${last.passed} passed, ${last.healed} healed, ${last.failed} failed.` : '')
    : 'No runs yet';
  const chart = svg(
    'svg',
    { class: 'trend', viewBox: `0 0 ${width} ${height}`, width: '100%', height, preserveAspectRatio: 'none', role: 'img', 'aria-label': summary },
    svg('title', { text: summary }),
    points.map((p, i) => {
      const x = i * (bw + gap);
      const scale = (height - 2) / totals[i];
      let y = height;
      const seg = (v: number, cls: string) => {
        if (!v) return null;
        const hh = v * scale;
        y -= hh;
        return svg('rect', { class: cls, x: x.toFixed(2), y: y.toFixed(2), width: bw.toFixed(2), height: hh.toFixed(2), rx: Math.min(2, bw / 3) });
      };
      return svg(
        'g',
        { class: 'trend-bar' },
        svg('title', { text: `${p.runId}: ${p.passed} passed, ${p.healed} healed, ${p.failed} failed` }),
        seg(p.passed, 'seg-pass'),
        seg(p.healed, 'seg-heal'),
        seg(p.failed, 'seg-fail'),
      );
    }),
  );
  const legend = h(
    'ul',
    { class: 'legend', 'aria-hidden': 'true' },
    h('li', null, h('span', { class: 'swatch seg-pass' }), 'Passed'),
    h('li', null, h('span', { class: 'swatch seg-heal' }), 'Healed'),
    h('li', null, h('span', { class: 'swatch seg-fail' }), 'Failed'),
  );
  return h('figure', { class: 'trend-figure' }, chart, legend);
}

/** A strip of P/H/F outcomes (e.g. flaky history) with an accessible summary. */
export function outcomeStrip(sequence: string, max = 20): HTMLElement {
  const seq = sequence.slice(-max);
  const names: Record<string, string> = { P: 'passed', H: 'healed', F: 'failed' };
  const label = `Recent outcomes, oldest first: ${[...seq].map((c) => names[c] ?? c).join(', ')}`;
  return h(
    'span',
    { class: 'strip', role: 'img', 'aria-label': label, title: label },
    [...seq].map((c) => h('span', { class: `strip-cell s-${names[c] ?? 'other'}` })),
  );
}
