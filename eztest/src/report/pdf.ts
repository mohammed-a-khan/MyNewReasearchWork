/**
 * The PDF report of a run (report.pdf), written by EZTest's own PDF writer -
 * no browser needed, so it is produced on any CI agent:
 *
 *   1. Executive summary: readiness verdict and reasons, key figures against
 *      the previous run, the outcome donut, the pass-rate trend, failure
 *      categories and what needs attention.
 *   2. Failures: each failing and flaky test with its category, the failing
 *      step, the error, the suggested next step, the screenshot of the failing
 *      step and its steps.
 *   3. Every test (state, suite, duration, category), requirements, quality
 *      lens findings, run context and the configuration (secrets masked).
 *
 * Bookmarks lead to each section; test names link to their permalink in
 * report.html.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { attentionOf, STATE_LABEL, TEST_STATES, type ReportModel, type TestModel, type TestState } from './data.js';
import { CATEGORY_LABEL, FAILURE_CATEGORIES, type FailureCategory } from './categorise.js';
import { fmtMs, fmtPct } from './charts.js';
import { contextRows, failingStepOf, firstLine, flatSteps, STEP_LABEL } from './export-common.js';
import { PdfDoc, textWidth, wrapText, type FontKey, type Rgb } from './pdf-doc.js';

const INK: Rgb = [20, 20, 19];
const MUTED: Rgb = [95, 94, 89];
const BORDER: Rgb = [221, 220, 214];
const SOFT: Rgb = [248, 248, 246];
const ACCENT: Rgb = [28, 92, 171];
const STATE_RGB: Record<TestState, Rgb> = { passed: [12, 163, 12], healed: [98, 80, 214], flaky: [250, 178, 25], failed: [208, 59, 59], error: [236, 131, 90], skipped: [137, 135, 129] };
const STATE_INK: Record<TestState, Rgb> = { passed: [10, 106, 10], healed: [74, 58, 167], flaky: [122, 82, 0], failed: [176, 42, 42], error: [154, 64, 16], skipped: [95, 94, 89] };
const CAT_RGB: Record<FailureCategory, Rgb> = { product: STATE_RGB.failed, test: STATE_RGB.healed, environment: STATE_RGB.error, data: STATE_RGB.flaky, flaky: STATE_RGB.flaky, unknown: STATE_RGB.skipped };
const STEP_STATE: Record<string, TestState> = { P: 'passed', H: 'healed', F: 'failed', S: 'skipped', B: 'error' };

const hex = (c: string | undefined): Rgb | undefined => (c && /^#[0-9a-f]{6}$/i.test(c) ? [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)] : undefined);

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
  const doc = new PdfDoc({ title: `${m.title} - ${m.runId}`, author: m.brand.name, subject: `Test run ${m.runId}: ${m.verdict.decision.replace(/_/g, ' ')}` });
  const href = o.reportHref ?? 'report.html';
  const L = doc.margin;
  const W = doc.contentWidth;
  const brand = hex(m.brand.color) ?? ACCENT;
  const k = m.kpis;
  const p = m.previous?.kpis;

  const heading = (title: string, size = 14) => {
    doc.ensure(size + 40);
    doc.y -= 10;
    doc.bookmark(title);
    doc.y -= size + 2;
    doc.text(L, doc.y, title, { size, font: 'B' });
    doc.y -= 6;
    doc.line(L, doc.y, L + W, doc.y, { stroke: BORDER });
    doc.y -= 6;
  };
  const sub = (title: string) => {
    doc.ensure(30);
    doc.y -= 15;
    doc.text(L, doc.y, title, { size: 11, font: 'B' });
    doc.y -= 6;
  };
  const chip = (x: number, y: number, label: string, fill: Rgb, ink: Rgb = [255, 255, 255], size = 8): number => {
    const w = textWidth(label, size, 'B') + 8;
    doc.rect(x, y - 3, w, size + 5, { fill });
    doc.text(x + 4, y, label, { size, font: 'B', color: ink });
    return w;
  };
  doc.setPageHeader((d) => {
    d.rect(0, d.height - 6, d.width, 6, { fill: brand });
    d.y = d.height - d.margin + 6;
  });

  // ---------------------------------------------------------------- 1. Executive summary
  doc.rect(0, doc.height - 6, doc.width, 6, { fill: brand });
  doc.y -= 4;
  doc.text(L, doc.y, m.brand.name.toUpperCase(), { size: 8.5, font: 'B', color: MUTED });
  doc.y -= 4;
  doc.paragraph(m.title, { size: 18, font: 'B', leading: 22 });
  const ctx = m.context;
  doc.paragraph([`Run ${m.runId}`, `${m.startedAt.replace('T', ' ').slice(0, 16)} UTC`, fmtMs(m.durationMs), ctx?.environment, ctx?.baseUrl, ctx?.branch ? `branch ${ctx.branch}${ctx.commit ? ` @ ${ctx.commit.sha.slice(0, 10)}` : ''}` : undefined, ctx?.build ? `${ctx.build.system} ${ctx.build.number ?? ctx.build.id ?? ''}`.trim() : undefined].filter(Boolean).join('  |  '), { size: 9, color: MUTED, gap: 8 });
  heading('Executive summary');

  // Verdict box
  const v = m.verdict;
  const vCol: Rgb = v.decision === 'GO' ? STATE_RGB.passed : v.decision === 'NO_GO' ? STATE_RGB.failed : STATE_RGB.flaky;
  const vInk: Rgb = v.decision === 'GO' ? STATE_INK.passed : v.decision === 'NO_GO' ? STATE_INK.failed : STATE_INK.flaky;
  const rank: Record<string, number> = { violation: 0, risk: 1, waived: 2, 'missing-input': 3, pass: 4, info: 5 };
  const reasons = [...v.reasons].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)).slice(0, 6);
  const reasonLines = reasons.map((r) => wrapText(`${r.kind.toUpperCase()}: ${r.text}`, W - 150, 9, 'R', 3));
  const boxH = Math.max(62, 14 + reasonLines.reduce((n, l) => n + l.length * 12, 0));
  doc.ensure(boxH + 10);
  const top = doc.y;
  doc.rect(L, top - boxH, W, boxH, { fill: SOFT, stroke: BORDER });
  doc.rect(L, top - boxH, 4, boxH, { fill: vCol });
  doc.text(L + 14, top - 18, 'RELEASE READINESS', { size: 7.5, font: 'B', color: MUTED });
  doc.text(L + 14, top - 38, v.decision.replace(/_/g, ' '), { size: 18, font: 'B', color: vInk });
  doc.text(L + 14, top - 52, v.score !== undefined ? `score ${v.score} / 100` : 'built-in rule', { size: 8, color: MUTED });
  let ry = top - 16;
  for (const lines of reasonLines) for (const line of lines) {
    doc.text(L + 140, ry, line, { size: 9 });
    ry -= 12;
  }
  doc.y = top - boxH - 10;

  // KPI tiles (2 rows of 4)
  const tiles: Array<[string, string, string, Rgb]> = [
    ['Total tests', String(k.total), p ? `${k.total - p.total >= 0 ? '+' : ''}${k.total - p.total} vs previous` : 'no previous run', ACCENT],
    ['Passed', String(k.passed), p ? `${k.passed - p.passed >= 0 ? '+' : ''}${k.passed - p.passed} vs previous` : '', STATE_RGB.passed],
    ['Failed', String(k.failed + k.errors), p ? `${k.failed + k.errors - p.failed - p.errors >= 0 ? '+' : ''}${k.failed + k.errors - p.failed - p.errors} vs previous` : '', STATE_RGB.failed],
    ['Flaky', String(k.flaky), p ? `${k.flaky - p.flaky >= 0 ? '+' : ''}${k.flaky - p.flaky} vs previous` : '', STATE_RGB.flaky],
    ['Healed', String(k.healed), '', STATE_RGB.healed],
    ['Skipped', String(k.skipped), '', STATE_RGB.skipped],
    ['Pass rate', fmtPct(k.passRate), p ? `${((k.passRate - p.passRate) * 100 >= 0 ? '+' : '')}${((k.passRate - p.passRate) * 100).toFixed(1)} pp vs previous` : '', ACCENT],
    ['Duration', fmtMs(k.durationMs), p ? `${k.durationMs >= p.durationMs ? '+' : '-'}${fmtMs(Math.abs(k.durationMs - p.durationMs))} vs previous` : '', ACCENT],
  ];
  const tw = (W - 3 * 8) / 4;
  doc.ensure(2 * 52 + 16);
  tiles.forEach(([label, value, delta, c], i) => {
    const x = L + (i % 4) * (tw + 8);
    const yTop = doc.y - Math.floor(i / 4) * 52;
    doc.rect(x, yTop - 46, tw, 46, { stroke: BORDER });
    doc.rect(x, yTop - 46, 3, 46, { fill: c });
    doc.text(x + 10, yTop - 13, label, { size: 8, color: MUTED });
    doc.text(x + 10, yTop - 31, value, { size: 15, font: 'B' });
    if (delta) doc.text(x + 10, yTop - 41, delta, { size: 7, color: MUTED });
  });
  doc.y -= 2 * 52 + 6;

  // Donut + legend | pass-rate trend
  doc.ensure(150);
  const chartTop = doc.y;
  const cx = L + 62;
  const cy = chartTop - 72;
  const counts: Record<TestState, number> = { passed: k.passed, healed: k.healed, flaky: k.flaky, failed: k.failed, error: k.errors, skipped: k.skipped };
  const totalN = Math.max(1, k.total);
  let a = 0;
  doc.text(L, chartTop - 4, 'Outcome', { size: 10, font: 'B' });
  for (const s of TEST_STATES) {
    if (!counts[s]) continue;
    const span = (counts[s] / totalN) * Math.PI * 2;
    doc.ringSegment(cx, cy, 52, 34, a, a + span - (span < Math.PI * 2 ? 0.01 : 0), STATE_RGB[s]);
    a += span;
  }
  const centre = fmtPct(k.passRate, 0);
  doc.text(cx - textWidth(centre, 14, 'B') / 2, cy - 2, centre, { size: 14, font: 'B' });
  doc.text(cx - textWidth('pass rate', 7) / 2, cy - 12, 'pass rate', { size: 7, color: MUTED });
  let ly = chartTop - 26;
  for (const s of TEST_STATES) {
    doc.rect(L + 128, ly - 1, 8, 8, { fill: STATE_RGB[s] });
    doc.text(L + 142, ly, `${STATE_LABEL[s]}  ${counts[s]}`, { size: 8.5 });
    ly -= 14;
  }
  const gx = L + 230;
  const gw = W - 230;
  doc.text(gx, chartTop - 4, `Pass rate, last ${m.trend.length} run(s)`, { size: 10, font: 'B' });
  const gTop = chartTop - 20;
  const gH = 100;
  doc.rect(gx, gTop - gH, gw, gH, { stroke: BORDER });
  for (const f of [0, 0.5, 1]) {
    const yy = gTop - gH + f * gH;
    doc.line(gx, yy, gx + gw, yy, { stroke: [232, 231, 225] });
    doc.text(gx + 3, yy + 2, `${Math.round(f * 100)}%`, { size: 6.5, color: MUTED });
  }
  if (m.trend.length >= 2) {
    const pts = m.trend.map((t, i): [number, number] => [gx + 24 + (i / (m.trend.length - 1)) * (gw - 34), gTop - gH + t.passRate * gH]);
    doc.polyline(pts, { stroke: ACCENT, lineWidth: 1.6, fill: [231, 240, 251], baseline: gTop - gH });
    const last = pts[pts.length - 1];
    doc.rect(last[0] - 2, last[1] - 2, 4, 4, { fill: ACCENT });
  } else doc.text(gx + 12, gTop - gH / 2, 'The trend appears after the second recorded run.', { size: 8, color: MUTED });
  doc.y = chartTop - 150;

  // Failure categories and attention
  if (m.categories && Object.keys(m.categories).length) {
    sub('Failure categories');
    const max = Math.max(...Object.values(m.categories).map((x) => x ?? 0), 1);
    for (const c of FAILURE_CATEGORIES) {
      const n = m.categories[c];
      if (!n) continue;
      doc.ensure(16);
      doc.y -= 15;
      doc.text(L, doc.y + 2, CATEGORY_LABEL[c], { size: 9 });
      doc.rect(L + 100, doc.y, ((W - 160) * n) / max, 10, { fill: CAT_RGB[c] });
      doc.text(L + 104 + ((W - 160) * n) / max, doc.y + 2, `${n} test${n === 1 ? '' : 's'}`, { size: 8.5, color: MUTED });
    }
  }
  const at = attentionOf(m);
  sub('Needs attention');
  const attn: Array<[string, Array<{ id: string; name: string }>]> = [['New failures', at.newFailures], ['Regressions', at.regressions], ['Flaky', at.flaky], ['Fixed', at.fixed], ['Slower', at.slower]];
  for (const [label, list] of attn) {
    doc.ensure(14);
    doc.y -= 13;
    doc.text(L, doc.y, `${label}: ${list.length}`, { size: 9, font: 'B' });
    if (list.length) {
      const names = list.slice(0, 4).map((t) => t.name).join('; ') + (list.length > 4 ? `; +${list.length - 4} more` : '');
      const lines = wrapText(names, W - 110, 8.5, 'R', 2);
      lines.forEach((l, i) => doc.text(L + 100, doc.y - i * 11, l, { size: 8.5, color: MUTED }));
      doc.y -= (lines.length - 1) * 11;
    }
  }

  // ---------------------------------------------------------------- 2. Failures
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
  if (failing.length) {
    doc.addPage();
    heading(`Failures (${failing.length})`);
    for (const t of failing.slice(0, o.maxFailures ?? 60)) {
      doc.ensure(90);
      doc.y -= 16;
      const sw = chip(L, doc.y, STATE_LABEL[t.state].toUpperCase(), STATE_RGB[t.state]);
      let cx2 = L + sw + 6;
      if (t.cat) cx2 += chip(cx2, doc.y, CATEGORY_LABEL[t.cat.c], CAT_RGB[t.cat.c], t.cat.c === 'data' || t.cat.c === 'flaky' ? INK : [255, 255, 255]) + 6;
      if (t.failure && !t.failure.known) cx2 += chip(cx2, doc.y, 'NEW', [255, 255, 255], STATE_INK.failed) + 6;
      const nameLines = wrapText(t.name, L + W - cx2, 11, 'B', 2);
      doc.text(cx2, doc.y, nameLines[0], { size: 11, font: 'B', color: ACCENT });
      doc.link(cx2, doc.y - 3, Math.min(L + W - cx2, textWidth(nameLines[0], 11, 'B')), 14, `${href}#test/${encodeURIComponent(t.id)}`);
      for (const extra of nameLines.slice(1)) {
        doc.y -= 13;
        doc.text(cx2, doc.y, extra, { size: 11, font: 'B', color: ACCENT });
      }
      doc.y -= 4;
      doc.paragraph([t.id, t.browser, t.suite.join(' / '), fmtMs(t.durationMs), t.attempt > 1 ? `attempt ${t.attempt}` : undefined, t.ado?.testCases.length ? `test case ${t.ado.testCases.map((c) => `#${c.id}`).join(', ')}` : undefined, t.requirements.length ? `requirements ${t.requirements.join(', ')}` : undefined, t.row ? `data ${Object.entries(t.row).map(([x, y]) => `${x}=${y}`).join(', ')}` : undefined].filter(Boolean).join('  |  '), { size: 8, color: MUTED });
      if (t.failedStep) doc.paragraph(`Failed at: ${t.failedStep}`, { size: 9, font: 'B', gap: 2 });
      const msg = t.error?.message ?? t.flake?.reason;
      if (msg) {
        const lines = wrapText(msg, W - 16, 8, 'M', 10);
        const h = lines.length * 10 + 8;
        doc.ensure(h + 4);
        doc.rect(L, doc.y - h, W, h, { fill: [251, 234, 234] });
        lines.forEach((l, i) => doc.text(L + 8, doc.y - 12 - i * 10, l, { size: 8, font: 'M', color: STATE_INK.failed }));
        doc.y -= h + 4;
      }
      const fs = failingStepOf(t)?.step;
      if (fs?.dg) {
        doc.paragraph(`Expected: ${fs.dg.expected}`, { size: 8.5, maxLines: 3 });
        doc.paragraph(`Found: ${fs.dg.found}`, { size: 8.5, maxLines: 3, color: MUTED });
      }
      if (t.cat) doc.paragraph(`Suggested next step: ${t.cat.fix}`, { size: 8.5, gap: 3 });
      const shot = shotFor(t);
      if (shot) {
        const img = doc.addImage(shot, { maxWidth: 900, maxHeight: 2400, skipBlank: true });
        if (img) {
          images++;
          const w = Math.min(W * 0.75, img.width);
          let h = Math.min(300, (w * img.height) / img.width);
          // Use the room left on the page when it is enough for a readable image.
          const room = doc.y - doc.margin - 18 - 18;
          if (room >= 150 && room < h) h = room;
          const iw = (h * img.width) / img.height;
          doc.ensure(h + 18);
          doc.y -= 12;
          doc.text(L, doc.y, 'Screenshot of the failing step', { size: 8, color: MUTED });
          doc.y -= h + 4;
          doc.rect(L - 0.5, doc.y - 0.5, iw + 1, h + 1, { stroke: BORDER });
          doc.image(img, L, doc.y, iw, h);
          doc.y -= 4;
        }
      }
      // Steps (status, step, duration)
      const steps = flatSteps(t);
      const shown = steps.slice(0, 40);
      doc.y -= 4;
      for (const [no, depth, s] of shown) {
        doc.ensure(12);
        doc.y -= 11;
        const st = STEP_STATE[s.s] ?? 'skipped';
        doc.rect(L + depth * 10, doc.y, 6, 6, { fill: STATE_RGB[st] });
        const label = `${no}. ${s.n}`;
        const line = wrapText(label, W - 120 - depth * 10, 8, 'R', 1)[0];
        doc.text(L + 10 + depth * 10, doc.y, line, { size: 8, color: s.s === 'F' || s.s === 'B' ? STATE_INK.failed : INK, font: s.s === 'F' ? 'B' : 'R' });
        doc.text(L + W - 100, doc.y, STEP_LABEL[s.s], { size: 8, color: MUTED });
        const d = fmtMs(s.d);
        doc.text(L + W - textWidth(d, 8), doc.y, d, { size: 8, color: MUTED });
      }
      if (steps.length > shown.length) doc.paragraph(`+${steps.length - shown.length} more steps in report.html`, { size: 8, color: MUTED });
      doc.y -= 8;
      doc.line(L, doc.y, L + W, doc.y, { stroke: BORDER });
    }
    if (failing.length > (o.maxFailures ?? 60)) doc.paragraph(`${failing.length - (o.maxFailures ?? 60)} more failing tests are in report.html and report.xlsx.`, { size: 9, color: MUTED, gap: 6 });
  }

  // ---------------------------------------------------------------- 3. Every test
  const table = (cols: Array<{ label: string; w: number; font?: FontKey }>, rows: Array<{ cells: string[]; state?: TestState; link?: string }>) => {
    const headerRow = () => {
      doc.ensure(30);
      doc.y -= 14;
      doc.rect(L, doc.y - 4, W, 15, { fill: [238, 238, 235] });
      let x = L + 4;
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
      let x = L + 4;
      r.cells.forEach((cell, i) => {
        const c = cols[i];
        const txt = wrapText(cell, c.w - 6, 8, c.font ?? 'R', 1)[0] ?? '';
        const isState = i === 0 && r.state;
        if (isState) doc.rect(x, doc.y - 1, 6, 6, { fill: STATE_RGB[r.state!] });
        doc.text(isState ? x + 9 : x, doc.y, txt, { size: 8, font: c.font, color: isState ? STATE_INK[r.state!] : i === 1 && r.link ? ACCENT : INK });
        if (i === 1 && r.link) doc.link(x, doc.y - 3, Math.min(c.w - 6, textWidth(txt, 8)), 11, r.link);
        x += c.w;
      });
      doc.line(L, doc.y - 3, L + W, doc.y - 3, { stroke: [238, 238, 235], lineWidth: 0.4 });
    }
  };
  doc.addPage();
  heading(`All tests (${m.tests.length})`);
  const SEVERITY: TestState[] = ['failed', 'error', 'flaky', 'healed', 'skipped', 'passed'];
  const order = [...m.tests].sort((x, y) => SEVERITY.indexOf(x.state) - SEVERITY.indexOf(y.state));
  table(
    [{ label: 'State', w: 58 }, { label: 'Test', w: W - 58 - 130 - 52 - 80 }, { label: 'Suite', w: 130 }, { label: 'Duration', w: 52 }, { label: 'Category', w: 80 }],
    order.map((t) => ({ state: t.state, link: `${href}#test/${encodeURIComponent(t.id)}`, cells: [STATE_LABEL[t.state], t.name, t.suite.join(' / '), fmtMs(t.durationMs), t.cat ? CATEGORY_LABEL[t.cat.c] : ''] })),
  );

  if (m.coverage.requirements?.items.length) {
    heading(`Requirements (${m.coverage.requirements.items.length})`);
    const st: Record<string, TestState> = { passing: 'passed', failing: 'failed', 'not-run': 'skipped', uncovered: 'skipped' };
    table([{ label: 'State', w: 70 }, { label: 'Requirement', w: 150 }, { label: 'Tests', w: W - 220 }], m.coverage.requirements.items.map((r) => ({ state: st[r.state], cells: [r.state, `${r.id}${r.title ? ` ${r.title}` : ''}`, r.tests.join(', ')] })));
  }

  if (m.lenses) {
    heading('Quality lenses');
    const rows: Array<{ cells: string[] }> = [
      ...(m.lenses.a11y?.rules ?? []).slice(0, 40).map((r) => ({ cells: ['Accessibility', `${r.id} (${r.impact})`, `${r.help}; ${r.nodes} element(s) on ${r.pages.length} page(s)`] })),
      ...(m.lenses.security?.findings ?? []).slice(0, 40).map((f) => ({ cells: ['Security', `${f.id} (${f.severity})`, `${f.message}; ${f.pages.length} page(s)`] })),
      ...(m.lenses.perf?.metrics ?? []).map((x) => ({ cells: ['Performance', `${x.metric} (${x.status})`, `worst ${Math.round(x.worst * 1000) / 1000}, budget ${x.warn ?? '-'} / ${x.error ?? '-'}, ${x.samples} sample(s)`] })),
    ];
    if (rows.length) table([{ label: 'Lens', w: 80 }, { label: 'Rule', w: 150 }, { label: 'Finding', w: W - 230 }], rows);
    else doc.paragraph('No findings.', { size: 9 });
  }

  heading('Run context');
  for (const [kk, vv] of contextRows(m)) {
    doc.ensure(12);
    doc.y -= 12;
    doc.text(L, doc.y, kk, { size: 8.5, color: MUTED });
    doc.text(L + 110, doc.y, wrapText(vv, W - 110, 8.5, 'R', 1)[0] ?? '', { size: 8.5 });
  }
  if (m.config?.length) {
    heading('Configuration (secrets masked)');
    table([{ label: 'Setting', w: 200, font: 'M' }, { label: 'Value', w: W - 200, font: 'M' }], m.config.map(([kk, vv]) => ({ cells: [kk, vv] })));
  }
  doc.y -= 14;
  doc.paragraph(`Generated by EZTest ${ctx?.eztestVersion ?? ''} on ${m.generatedAt.replace('T', ' ').slice(0, 16)} UTC. Every test, step and piece of evidence is in report.html next to this file.`, { size: 8, color: MUTED });
  return doc.build();
}
