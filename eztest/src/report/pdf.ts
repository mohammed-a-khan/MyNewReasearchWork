/**
 * The PDF report of a run (report.pdf), written by EZTest's own PDF writer -
 * no browser needed, so it is produced on any CI agent. Its sections mirror
 * the HTML report's tabs:
 *
 *   1. Overview: the result counts, the outcome, results by feature, the
 *      slowest tests and the top failure reasons.
 *   2. Failures: failing and flaky tests grouped by cause, with the next step.
 *   3. Tests: each failing test (failing step, error, expected / actual,
 *      screenshot, steps), then every test in one table.
 *   4. Trends (with history), 5. Quality (lenses, requirements),
 *   6. Environment (run context, configuration with secrets masked) and,
 *      only when report.readiness is on, 7. Policy.
 *
 * Branding (company, title, subtitle, logo, colours, footer, hidden
 * sections, white label) comes from the model. Bookmarks lead to each
 * section; test names link to their permalink in report.html.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { STATE_LABEL, TEST_STATES, type ReportModel, type TestModel, type TestState } from './data.js';
import { CATEGORY_LABEL, FAILURE_CATEGORIES, type FailureCategory } from './categorise.js';
import { causeGroups } from './causes.js';
import { fmtMs, fmtPct } from './charts.js';
import { contextRows, failingStepOf, flatSteps, STEP_LABEL } from './export-common.js';
import { PdfDoc, textWidth, wrapText, type FontKey, type Rgb } from './pdf-doc.js';
import { isHidden, labelsOf, productName } from './brand.js';

const INK: Rgb = [22, 24, 29];
const MUTED: Rgb = [91, 97, 107];
const BORDER: Rgb = [226, 229, 234];
const SOFT: Rgb = [245, 246, 248];
const hex = (c: string | undefined): Rgb | undefined => (c && /^#[0-9a-f]{6}$/i.test(c) ? [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)] : undefined);
const DEFAULT_MARK: Record<TestState, string> = { passed: '#1f8a4c', healed: '#6a4fd6', flaky: '#c98a00', failed: '#d1343b', error: '#c2571a', skipped: '#8a8f98' };
const DEFAULT_INK: Record<TestState, string> = { passed: '#176b3a', healed: '#523bb5', flaky: '#7d5600', failed: '#b3262d', error: '#9c4211', skipped: '#5b616b' };
const STEP_STATE: Record<string, TestState> = { P: 'passed', H: 'healed', F: 'failed', S: 'skipped', B: 'error' };

export interface PdfReportOptions {
  /** The run directory: screenshots of failing steps are read from it. */
  runDir?: string;
  /** Where report.html is, relative to the PDF (permalinks). Default report.html. */
  reportHref?: string;
  /** At most this many failing tests get a detail section (default 60). */
  maxFailures?: number;
  /** At most this many screenshots are embedded (default 40). */
  maxImages?: number;
}

/** Render the PDF report. */
export function renderReportPdf(m: ReportModel, o: PdfReportOptions = {}): Buffer {
  const b = m.brand;
  const L = labelsOf(b);
  const product = productName(b);
  const pal = b.palette?.light;
  const STATE_RGB = Object.fromEntries(TEST_STATES.map((s) => [s, hex(pal?.[`st-${s}`]) ?? hex(DEFAULT_MARK[s])!])) as Record<TestState, Rgb>;
  const STATE_INK = Object.fromEntries(TEST_STATES.map((s) => [s, hex(pal?.[`ink-${s}`]) ?? hex(DEFAULT_INK[s])!])) as Record<TestState, Rgb>;
  const CAT_RGB: Record<FailureCategory, Rgb> = { product: STATE_RGB.failed, test: STATE_RGB.healed, environment: STATE_RGB.error, data: STATE_RGB.flaky, flaky: STATE_RGB.flaky, unknown: STATE_RGB.skipped };
  const BRAND = hex(pal?.['brand-btn']) ?? hex(b.color) ?? [59, 91, 219];
  const LINK = hex(pal?.['brand-ink']) ?? [59, 91, 219];
  const doc = new PdfDoc({
    title: `${m.title}${b.subtitle ? ` - ${b.subtitle}` : ''} - ${m.runId}`,
    author: b.preparedBy ?? b.company ?? b.name,
    subject: `Test run ${m.runId}: ${m.kpis.total} ${L.tests}, ${m.kpis.failed + m.kpis.errors} failed`,
    keywords: [b.company, b.name, m.context?.environment].filter(Boolean).join(', '),
    producer: product ? 'EZTest report PDF writer' : `${b.company ?? b.name} report`,
    footer: b.footer ?? `${b.company ? `${b.company} - ` : ''}${m.title}`,
  });
  const href = o.reportHref ?? 'report.html';
  const permalink = (id: string) => `${href}#tests/${encodeURIComponent(id)}`;
  const Lx = doc.margin;
  const W = doc.contentWidth;
  const k = m.kpis;
  const p = m.previous?.kpis;
  const groups = causeGroups(m);

  const heading = (title: string, size = 15) => {
    doc.ensure(size + 40);
    doc.y -= 10;
    doc.bookmark(title);
    doc.y -= size + 2;
    doc.text(Lx, doc.y, title, { size, font: 'B' });
    doc.y -= 7;
    doc.rect(Lx, doc.y, 36, 2.5, { fill: BRAND });
    doc.y -= 10;
  };
  const sub = (title: string) => {
    doc.ensure(34);
    doc.y -= 15;
    doc.text(Lx, doc.y, title, { size: 11, font: 'B' });
    doc.y -= 8;
  };
  const chip = (x: number, y: number, label: string, fill: Rgb, ink: Rgb = [255, 255, 255], size = 8): number => {
    const w = textWidth(label, size, 'B') + 8;
    doc.rect(x, y - 3, w, size + 5, { fill });
    doc.text(x + 4, y, label, { size, font: 'B', color: ink });
    return w;
  };
  const light = (c: Rgb): boolean => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 150;
  const head = b.palette?.header;
  const headBg = hex(head?.bg);
  const headInk = hex(head?.text) ?? INK;
  const headMuted = hex(head?.muted) ?? MUTED;
  doc.setPageHeader((d) => {
    d.rect(0, d.height - 5, d.width, 5, { fill: BRAND });
    d.y = d.height - d.margin + 6;
  });

  // ---------------------------------------------------------------- header
  const logo = (() => {
    const src = b.logo ?? b.mark;
    const mm = src ? /^data:image\/(png|jpeg);base64,(.+)$/.exec(src) : null;
    return mm ? doc.addImage(Buffer.from(mm[2], 'base64'), { maxWidth: 600, maxHeight: 300 }) : undefined;
  })();
  const headH = 78;
  if (headBg) doc.rect(0, doc.height - headH - 18, doc.width, headH + 18, { fill: headBg });
  doc.rect(0, doc.height - 5, doc.width, 5, { fill: BRAND });
  let tx = Lx;
  if (logo) {
    const h = 34;
    const w = Math.min(150, (h * logo.width) / logo.height);
    doc.image(logo, Lx, doc.y - h + 4, w, (w * logo.height) / logo.width);
    tx = Lx + w + 12;
  }
  doc.y -= 4;
  if (b.company) doc.text(tx, doc.y - 6, b.company.toUpperCase(), { size: 8.5, font: 'B', color: headMuted });
  doc.y -= b.company ? 22 : 12;
  doc.text(tx, doc.y, wrapText(m.title, W - (tx - Lx), 17, 'B', 1)[0] ?? m.title, { size: 17, font: 'B', color: headInk });
  doc.y -= 14;
  if (b.subtitle) {
    doc.text(tx, doc.y, b.subtitle, { size: 10, color: headMuted });
    doc.y -= 13;
  }
  const ctx = m.context;
  doc.text(tx, doc.y, [`${b.name}${ctx?.environment ? ` / ${ctx.environment}` : ''}`, `${m.startedAt.replace('T', ' ').slice(0, 16)} UTC`, fmtMs(m.durationMs), ctx?.browsers.length ? ctx.browsers.map((x) => `${x.name}${x.version ? ` ${x.version.split('.')[0]}` : ''}`).join(', ') : undefined].filter(Boolean).join('   |   '), { size: 8.5, color: headMuted });
  doc.y = headBg ? Math.min(doc.y - 8, doc.height - headH - 26) : doc.y - 4;

  // ---------------------------------------------------------------- 1. Overview
  heading(L.tabs.overview);
  const tiles: Array<[string, number, number | undefined, Rgb]> = [
    [k.total === 1 ? L.test : L.tests, k.total, p?.total, BRAND],
    ['passed', k.passed, p?.passed, STATE_RGB.passed],
    ['failed', k.failed + k.errors, p ? p.failed + p.errors : undefined, STATE_RGB.failed],
    ['flaky', k.flaky, p?.flaky, STATE_RGB.flaky],
    ['skipped', k.skipped, p?.skipped, STATE_RGB.skipped],
  ];
  const tw = (W - 4 * 8) / 5;
  doc.ensure(60);
  tiles.forEach(([label, value, prev, c], i) => {
    const x = Lx + i * (tw + 8);
    const yTop = doc.y;
    doc.rect(x, yTop - 48, tw, 48, { stroke: BORDER });
    doc.rect(x, yTop - 3, tw, 3, { fill: c });
    doc.text(x + 10, yTop - 24, String(value), { size: 17, font: 'B' });
    doc.text(x + 10, yTop - 36, label[0].toUpperCase() + label.slice(1), { size: 8.5, color: MUTED });
    if (prev !== undefined && prev !== value) doc.text(x + 10, yTop - 45, `${value > prev ? '+' : '-'}${Math.abs(value - prev)} vs previous`, { size: 6.5, color: MUTED });
  });
  doc.y -= 60;
  // Outcome donut (shares) | results by feature
  doc.ensure(150);
  const chartTop = doc.y;
  const cx = Lx + 58;
  const cy = chartTop - 70;
  const counts: Record<TestState, number> = { passed: k.passed, healed: k.healed, flaky: k.flaky, failed: k.failed, error: k.errors, skipped: k.skipped };
  const totalN = Math.max(1, k.total);
  let a = 0;
  doc.text(Lx, chartTop - 4, L.sections.outcome, { size: 10, font: 'B' });
  for (const s of TEST_STATES) {
    if (!counts[s]) continue;
    const span = (counts[s] / totalN) * Math.PI * 2;
    doc.ringSegment(cx, cy, 50, 34, a, a + span - (span < Math.PI * 2 ? 0.01 : 0), STATE_RGB[s]);
    a += span;
  }
  const centre = fmtPct(k.passRate, 0);
  doc.text(cx - textWidth(centre, 14, 'B') / 2, cy - 2, centre, { size: 14, font: 'B' });
  doc.text(cx - textWidth('pass rate', 7) / 2, cy - 12, 'pass rate', { size: 7, color: MUTED });
  let ly = chartTop - 132;
  const shownStates = TEST_STATES.filter((s) => counts[s]);
  shownStates.forEach((s, i) => {
    const x = Lx + (i % 3) * 60;
    const yy = ly - Math.floor(i / 3) * 11;
    doc.rect(x, yy - 1, 6, 6, { fill: STATE_RGB[s] });
    doc.text(x + 9, yy, `${STATE_LABEL[s]} ${fmtPct(counts[s] / totalN, 0)}`, { size: 7 });
  });
  ly -= Math.ceil(shownStates.length / 3) * 11;
  // results by feature (right column)
  const fx = Lx + 200;
  const fw = W - 200;
  doc.text(fx, chartTop - 4, L.sections.byFeature, { size: 10, font: 'B' });
  const bySuite = new Map<string, TestModel[]>();
  for (const t of m.tests) bySuite.set(t.suite[0] ?? 'Ungrouped', [...(bySuite.get(t.suite[0] ?? 'Ungrouped') ?? []), t]);
  const suites = [...bySuite.entries()].sort((x, y) => y[1].filter((t) => t.state === 'failed' || t.state === 'error').length - x[1].filter((t) => t.state === 'failed' || t.state === 'error').length || y[1].length - x[1].length).slice(0, 9);
  let sy = chartTop - 20;
  for (const [name, tests] of suites) {
    const c: Record<TestState, number> = { passed: 0, healed: 0, flaky: 0, failed: 0, error: 0, skipped: 0 };
    for (const t of tests) c[t.state]++;
    doc.text(fx, sy, wrapText(name, 120, 8.5, 'R', 1)[0] ?? name, { size: 8.5 });
    let bx = fx + 128;
    const bw = fw - 128 - 60;
    for (const s of TEST_STATES) {
      if (!c[s]) continue;
      const w = (bw * c[s]) / tests.length;
      doc.rect(bx, sy - 1, Math.max(0.5, w - 0.6), 7, { fill: STATE_RGB[s] });
      bx += w;
    }
    const failing = c.failed + c.error;
    doc.text(fx + fw - 56, sy, `${tests.length}${failing ? `, ${failing} failing` : ''}`, { size: 7.5, color: failing ? STATE_INK.failed : MUTED });
    sy -= 13;
  }
  doc.y = Math.min(ly - 6, sy - 6, chartTop - 150);
  if (m.slowest.length) {
    sub(L.sections.slowest);
    const max = Math.max(1, ...m.slowest.slice(0, 5).map((s) => s.durationMs));
    for (const s of m.slowest.slice(0, 5)) {
      doc.ensure(14);
      doc.y -= 12;
      const name = wrapText(s.name, 230, 8.5, 'R', 1)[0] ?? s.name;
      doc.text(Lx, doc.y, name, { size: 8.5, color: LINK });
      doc.link(Lx, doc.y - 3, Math.min(230, textWidth(name, 8.5)), 11, permalink(s.id));
      doc.rect(Lx + 240, doc.y - 1, ((W - 300) * s.durationMs) / max, 7, { fill: BRAND });
      doc.text(Lx + W - textWidth(fmtMs(s.durationMs), 8.5), doc.y, fmtMs(s.durationMs), { size: 8.5, color: MUTED });
    }
  }
  if (groups.length) {
    sub(L.sections.topFailures);
    for (const g of groups.slice(0, 6)) {
      doc.ensure(17);
      doc.y -= 15;
      doc.text(Lx, doc.y, String(g.tests.length), { size: 9, font: 'B', color: STATE_INK.failed });
      const cw = chip(Lx + 22, doc.y, CATEGORY_LABEL[g.cat], CAT_RGB[g.cat], light(CAT_RGB[g.cat]) ? INK : [255, 255, 255], 7);
      doc.text(Lx + 28 + cw, doc.y, wrapText(g.message, W - 34 - cw, 8, 'M', 1)[0] ?? '', { size: 8, font: 'M' });
    }
  }

  // ---------------------------------------------------------------- 2. Failures
  if (groups.length && !isHidden(b, 'failures')) {
    doc.addPage();
    heading(L.tabs.failures);
    for (const c of FAILURE_CATEGORIES) {
      const list = groups.filter((g) => g.cat === c);
      if (!list.length) continue;
      doc.ensure(40);
      doc.y -= 14;
      chip(Lx, doc.y, CATEGORY_LABEL[c], CAT_RGB[c], light(CAT_RGB[c]) ? INK : [255, 255, 255], 9);
      doc.y -= 6;
      for (const g of list) {
        const msg = wrapText(g.message, W - 70, 8.5, 'M', 4);
        const fix = g.fix ? wrapText(`Next step: ${g.fix}`, W - 20, 8.5, 'R', 4) : [];
        const names = g.tests.slice(0, 12).map((t) => t.name);
        const h = 14 + msg.length * 11 + fix.length * 11 + names.length * 11 + 14;
        doc.ensure(Math.min(h, 300));
        const top = doc.y - 4;
        doc.rect(Lx, top - h, W, h, { stroke: BORDER });
        doc.rect(Lx, top - h, 3, h, { fill: g.kind === 'flaky' ? STATE_RGB.flaky : STATE_RGB.failed });
        let yy = top - 14;
        msg.forEach((l) => { doc.text(Lx + 10, yy, l, { size: 8.5, font: 'M' }); yy -= 11; });
        const n = `${g.tests.length} ${g.tests.length === 1 ? L.test : L.tests}`;
        doc.text(Lx + W - 8 - textWidth(n, 9, 'B'), top - 14, n, { size: 9, font: 'B', color: g.kind === 'flaky' ? STATE_INK.flaky : STATE_INK.failed });
        if (g.kind === 'failure' && !g.known) chip(Lx + W - 40, top - 28, 'NEW', [255, 255, 255], STATE_INK.failed, 7);
        if (fix.length) {
          doc.rect(Lx + 4, yy - (fix.length - 1) * 11 - 4, W - 8, fix.length * 11 + 4, { fill: SOFT });
          fix.forEach((l) => { doc.text(Lx + 10, yy, l, { size: 8.5 }); yy -= 11; });
        }
        yy -= 3;
        g.tests.slice(0, 12).forEach((t) => {
          doc.rect(Lx + 10, yy - 1, 5, 5, { fill: STATE_RGB[t.state] });
          const line = wrapText(t.name, W - 40, 8.5, 'R', 1)[0] ?? t.name;
          doc.text(Lx + 20, yy, line, { size: 8.5, color: LINK });
          doc.link(Lx + 20, yy - 3, Math.min(W - 40, textWidth(line, 8.5)), 11, permalink(t.id));
          yy -= 11;
        });
        if (g.tests.length > 12) doc.text(Lx + 20, yy, `+${g.tests.length - 12} more`, { size: 8, color: MUTED });
        doc.y = top - h - 8;
      }
    }
  }

  // ---------------------------------------------------------------- 3. Tests: failing tests in detail, then all tests
  const failing = m.tests.filter((t) => t.state === 'failed' || t.state === 'error' || t.state === 'flaky');
  let images = 0;
  const maxImages = o.maxImages ?? 40;
  const shotFor = (t: TestModel): Buffer | undefined => {
    if (!o.runDir || images >= maxImages) return undefined;
    const f = failingStepOf(t);
    for (const id of f?.shots ?? []) {
      const ev = m.evidence[id];
      if (!ev || !ev[1] || m.evidenceKinds[ev[0]] !== 'screenshot') continue;
      const abs = resolve(o.runDir, decodeURIComponent(ev[1]));
      const rel = relative(o.runDir, abs);
      if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(abs)) continue;
      try {
        return readFileSync(abs);
      } catch {
        continue;
      }
    }
    return undefined;
  };
  doc.addPage();
  heading(L.tabs.tests);
  for (const t of failing.slice(0, o.maxFailures ?? 60)) {
    doc.ensure(90);
    doc.y -= 16;
    const sw = chip(Lx, doc.y, STATE_LABEL[t.state].toUpperCase(), STATE_RGB[t.state], light(STATE_RGB[t.state]) ? INK : [255, 255, 255]);
    let cx2 = Lx + sw + 6;
    if (t.cat) cx2 += chip(cx2, doc.y, CATEGORY_LABEL[t.cat.c], CAT_RGB[t.cat.c], light(CAT_RGB[t.cat.c]) ? INK : [255, 255, 255]) + 6;
    const nameLines = wrapText(t.name, Lx + W - cx2, 11, 'B', 2);
    doc.text(cx2, doc.y, nameLines[0], { size: 11, font: 'B', color: LINK });
    doc.link(cx2, doc.y - 3, Math.min(Lx + W - cx2, textWidth(nameLines[0], 11, 'B')), 14, permalink(t.id));
    for (const extra of nameLines.slice(1)) {
      doc.y -= 13;
      doc.text(cx2, doc.y, extra, { size: 11, font: 'B', color: LINK });
    }
    doc.y -= 4;
    doc.paragraph([fmtMs(t.durationMs), t.browser, t.suite.join(' / '), t.attempt > 1 ? `${t.attempt} attempts` : undefined, t.ado?.testCases.length ? `test case ${t.ado.testCases.map((c) => `#${c.id}`).join(', ')}` : undefined, t.row ? `data ${Object.entries(t.row).map(([x, y]) => `${x}=${y}`).join(', ')}` : undefined].filter(Boolean).join('  |  '), { size: 8, color: MUTED });
    if (t.failedStep) doc.paragraph(`Failed at: ${t.failedStep}`, { size: 9, font: 'B', gap: 2 });
    const msg = t.error?.message ?? t.flake?.reason;
    if (msg) {
      const lines = wrapText(msg, W - 16, 8, 'M', 10);
      const h = lines.length * 10 + 8;
      doc.ensure(h + 4);
      doc.rect(Lx, doc.y - h, W, h, { fill: hex(pal?.['soft-failed']) ?? [253, 236, 236] });
      lines.forEach((l, i) => doc.text(Lx + 8, doc.y - 12 - i * 10, l, { size: 8, font: 'M', color: STATE_INK.failed }));
      doc.y -= h + 4;
    }
    const fs = failingStepOf(t)?.step;
    if (fs?.dg) {
      doc.paragraph(`Expected: ${fs.dg.expected}`, { size: 8.5, maxLines: 3 });
      doc.paragraph(`Actual: ${fs.dg.found}`, { size: 8.5, maxLines: 3, color: MUTED });
    }
    const shot = shotFor(t);
    if (shot) {
      const img = doc.addImage(shot, { maxWidth: 900, maxHeight: 2400, skipBlank: true });
      if (img) {
        images++;
        const w = Math.min(W * 0.75, img.width);
        let h = Math.min(300, (w * img.height) / img.width);
        const room = doc.y - doc.margin - 18 - 18;
        if (room >= 150 && room < h) h = room;
        const iw = (h * img.width) / img.height;
        doc.ensure(h + 18);
        doc.y -= 12;
        doc.text(Lx, doc.y, 'Screenshot of the failing step', { size: 8, color: MUTED });
        doc.y -= h + 4;
        doc.rect(Lx - 0.5, doc.y - 0.5, iw + 1, h + 1, { stroke: BORDER });
        doc.image(img, Lx, doc.y, iw, h);
        doc.y -= 4;
      }
    }
    const steps = flatSteps(t);
    const shown = steps.slice(0, 40);
    doc.y -= 4;
    for (const [no, depth, s] of shown) {
      doc.ensure(12);
      doc.y -= 11;
      const st = STEP_STATE[s.s] ?? 'skipped';
      doc.rect(Lx + depth * 10, doc.y, 6, 6, { fill: STATE_RGB[st] });
      const line = wrapText(`${no}. ${s.n}`, W - 120 - depth * 10, 8, 'R', 1)[0];
      doc.text(Lx + 10 + depth * 10, doc.y, line, { size: 8, color: s.s === 'F' || s.s === 'B' ? STATE_INK.failed : INK, font: s.s === 'F' ? 'B' : 'R' });
      doc.text(Lx + W - 100, doc.y, STEP_LABEL[s.s], { size: 8, color: MUTED });
      const d = fmtMs(s.d);
      doc.text(Lx + W - textWidth(d, 8), doc.y, d, { size: 8, color: MUTED });
    }
    if (steps.length > shown.length) doc.paragraph(`+${steps.length - shown.length} more steps in report.html`, { size: 8, color: MUTED });
    doc.y -= 8;
    doc.line(Lx, doc.y, Lx + W, doc.y, { stroke: BORDER });
  }
  if (failing.length > (o.maxFailures ?? 60)) doc.paragraph(`${failing.length - (o.maxFailures ?? 60)} more failing ${L.tests} are in report.html and report.xlsx.`, { size: 9, color: MUTED, gap: 6 });

  const table = (cols: Array<{ label: string; w: number; font?: FontKey }>, rows: Array<{ cells: string[]; state?: TestState; link?: string }>) => {
    const headerRow = () => {
      doc.ensure(30);
      doc.y -= 14;
      doc.rect(Lx, doc.y - 4, W, 15, { fill: [239, 241, 244] });
      let x = Lx + 4;
      for (const c of cols) {
        doc.text(x, doc.y, c.label, { size: 8, font: 'B' });
        x += c.w;
      }
    };
    headerRow();
    for (const r of rows) {
      if (doc.y - 13 < doc.margin + 18) {
        doc.addPage();
        headerRow();
      }
      doc.y -= 12;
      let x = Lx + 4;
      r.cells.forEach((cell, i) => {
        const c = cols[i];
        const txt = wrapText(cell, c.w - 6, 8, c.font ?? 'R', 1)[0] ?? '';
        const isState = i === 0 && r.state;
        if (isState) doc.rect(x, doc.y - 1, 6, 6, { fill: STATE_RGB[r.state!] });
        doc.text(isState ? x + 9 : x, doc.y, txt, { size: 8, font: c.font, color: isState ? STATE_INK[r.state!] : i === 1 && r.link ? LINK : INK });
        if (i === 1 && r.link) doc.link(x, doc.y - 3, Math.min(c.w - 6, textWidth(txt, 8)), 11, r.link);
        x += c.w;
      });
      doc.line(Lx, doc.y - 3, Lx + W, doc.y - 3, { stroke: [239, 241, 244], lineWidth: 0.4 });
    }
  };
  sub(`All ${L.tests}`);
  const SEVERITY: TestState[] = ['failed', 'error', 'flaky', 'healed', 'skipped', 'passed'];
  const order = [...m.tests].sort((x, y) => SEVERITY.indexOf(x.state) - SEVERITY.indexOf(y.state));
  table(
    [{ label: 'Result', w: 58 }, { label: L.test[0].toUpperCase() + L.test.slice(1), w: W - 58 - 130 - 52 - 80 }, { label: 'Feature', w: 130 }, { label: 'Duration', w: 52 }, { label: 'Category', w: 80 }],
    order.map((t) => ({ state: t.state, link: permalink(t.id), cells: [STATE_LABEL[t.state], t.name, t.suite.join(' / '), fmtMs(t.durationMs), t.cat ? CATEGORY_LABEL[t.cat.c] : ''] })),
  );

  // ---------------------------------------------------------------- 4. Trends
  if (m.trend.length >= 2 && !isHidden(b, 'trends')) {
    doc.addPage();
    heading(L.tabs.trends);
    const gTop = doc.y - 6;
    const gH = 110;
    doc.text(Lx, gTop + 2, `Pass rate, last ${m.trend.length} runs`, { size: 9, font: 'B' });
    doc.rect(Lx, gTop - gH - 8, W, gH, { stroke: BORDER });
    const base = gTop - gH - 8;
    for (const f of [0, 0.5, 1]) {
      const yy = base + f * gH;
      doc.line(Lx, yy, Lx + W, yy, { stroke: [232, 234, 238] });
      doc.text(Lx + 3, yy + 2, `${Math.round(f * 100)}%`, { size: 6.5, color: MUTED });
    }
    const pts = m.trend.map((t, i): [number, number] => [Lx + 24 + (i / (m.trend.length - 1)) * (W - 34), base + t.passRate * gH]);
    doc.polyline(pts, { stroke: BRAND, lineWidth: 1.6, fill: [234, 238, 252], baseline: base });
    doc.y = base - 20;
    sub('Duration and flaky per run');
    const max = Math.max(1, ...m.trend.map((t) => t.durationMs));
    for (const t of m.trend) {
      doc.ensure(13);
      doc.y -= 12;
      doc.text(Lx, doc.y, `${t.startedAt.replace('T', ' ').slice(0, 16)}${t.current ? ' (this run)' : ''}`, { size: 8, font: t.current ? 'B' : 'R' });
      doc.rect(Lx + 130, doc.y - 1, ((W - 280) * t.durationMs) / max, 7, { fill: t.current ? BRAND : [169, 187, 245] });
      doc.text(Lx + W - 140, doc.y, fmtMs(t.durationMs), { size: 8, color: MUTED });
      doc.text(Lx + W - 70, doc.y, `${fmtPct(t.passRate, 0)}, ${t.flaky ?? 0} flaky`, { size: 8, color: MUTED });
    }
    const c = m.comparison;
    if (c) {
      sub(`Changes since ${c.baselineStartedAt.replace('T', ' ').slice(0, 16)}`);
      const rows: Array<[string, Array<{ name: string }>]> = [['Newly failing', c.newlyFailing], ['Fixed', c.fixed], ['Slower', c.slower], [`New ${L.tests}`, c.added], ['Removed', c.removed]];
      for (const [label, list] of rows) {
        if (!list.length) continue;
        doc.ensure(14);
        doc.y -= 13;
        doc.text(Lx, doc.y, `${label}: ${list.length}`, { size: 9, font: 'B' });
        const lines = wrapText(list.slice(0, 6).map((x) => x.name).join('; ') + (list.length > 6 ? `; +${list.length - 6} more` : ''), W - 120, 8.5, 'R', 2);
        lines.forEach((l, i) => doc.text(Lx + 110, doc.y - i * 11, l, { size: 8.5, color: MUTED }));
        doc.y -= (lines.length - 1) * 11;
      }
    }
  }

  // ---------------------------------------------------------------- 5. Quality
  const quality = !!(m.lenses || m.coverage.requirements?.items.length);
  if (quality && !isHidden(b, 'quality')) {
    doc.addPage();
    heading(L.tabs.quality);
    if (m.coverage.requirements?.items.length) {
      sub(`Requirements (${m.coverage.requirements.items.length})`);
      const st: Record<string, TestState> = { passing: 'passed', failing: 'failed', 'not-run': 'skipped', uncovered: 'skipped' };
      table([{ label: 'State', w: 70 }, { label: 'Requirement', w: 150 }, { label: L.tests[0].toUpperCase() + L.tests.slice(1), w: W - 220 }], m.coverage.requirements.items.map((r) => ({ state: st[r.state], cells: [r.state, `${r.id}${r.title ? ` ${r.title}` : ''}`, r.tests.join(', ')] })));
    }
    if (m.lenses) {
      sub('Quality lenses');
      const rows: Array<{ cells: string[] }> = [
        ...(m.lenses.a11y?.rules ?? []).slice(0, 40).map((r) => ({ cells: ['Accessibility', `${r.id} (${r.impact})`, `${r.help}; ${r.nodes} element(s) on ${r.pages.length} page(s)`] })),
        ...(m.lenses.security?.findings ?? []).slice(0, 40).map((f) => ({ cells: ['Security', `${f.id} (${f.severity})`, `${f.message}; ${f.pages.length} page(s)`] })),
        ...(m.lenses.perf?.metrics ?? []).map((x) => ({ cells: ['Performance', `${x.metric} (${x.status})`, `worst ${Math.round(x.worst * 1000) / 1000}, budget ${x.warn ?? '-'} / ${x.error ?? '-'}, ${x.samples} sample(s)`] })),
      ];
      if (rows.length) table([{ label: 'Lens', w: 80 }, { label: 'Rule', w: 150 }, { label: 'Finding', w: W - 230 }], rows);
      else doc.paragraph('No findings.', { size: 9 });
    }
  }

  // ---------------------------------------------------------------- 6. Environment
  if (!isHidden(b, 'environment')) {
    doc.addPage();
    heading(L.tabs.environment);
    for (const [kk, vv] of contextRows(m)) {
      doc.ensure(12);
      doc.y -= 12;
      doc.text(Lx, doc.y, kk, { size: 8.5, color: MUTED });
      doc.text(Lx + 110, doc.y, wrapText(vv, W - 110, 8.5, 'R', 1)[0] ?? '', { size: 8.5 });
    }
    if (m.config?.length) {
      sub('Configuration (secrets masked)');
      table([{ label: 'Setting', w: 200, font: 'M' }, { label: 'Value', w: W - 200, font: 'M' }], m.config.map(([kk, vv]) => ({ cells: [kk, vv] })));
    }
  }

  // ---------------------------------------------------------------- 7. Policy (opt-in)
  const v = m.verdict;
  if (v && !isHidden(b, 'policy')) {
    doc.addPage();
    heading(L.tabs.policy);
    doc.paragraph(`Readiness policy: ${v.decision.replace(/_/g, ' ')}${v.score !== undefined ? ` (score ${v.score} / 100)` : ''}`, { size: 12, font: 'B', gap: 6 });
    for (const r of v.reasons) doc.paragraph(`${r.kind.toUpperCase()}: ${r.text}`, { size: 9, gap: 3 });
  }

  doc.y -= 14;
  doc.ensure(30);
  if (b.preparedBy) doc.paragraph(`Prepared by ${b.preparedBy}.`, { size: 8, color: MUTED });
  doc.paragraph(`${product ? `Generated by ${product} ${ctx?.eztestVersion ?? ''}` : 'Generated'} on ${m.generatedAt.replace('T', ' ').slice(0, 16)} UTC. Every ${L.test}, step and piece of evidence is in report.html next to this file.`, { size: 8, color: MUTED });
  return doc.build();
}
