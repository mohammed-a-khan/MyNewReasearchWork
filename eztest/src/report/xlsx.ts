/**
 * The Excel workbook of a run (report.xlsx): sheets that mirror the report's
 * tabs - Overview, Tests, Steps, Failures (by cause), Requirements, Trend,
 * Quality, Configuration, Environment and, only when report.readiness is on,
 * Policy - with the brand in the title rows, frozen headers, filters, number
 * formats, status colours and links back to each test's permalink in
 * report.html. Hidden sections (report.brand.hide) are left out. Written with
 * EZTest's own SpreadsheetML writer (xlsx-writer.ts).
 */
import { STATE_LABEL, type ReportModel } from './data.js';
import { CATEGORY_LABEL } from './categorise.js';
import { causeGroups } from './causes.js';
import { isHidden, labelsOf, productName } from './brand.js';
import { contextRows, firstLine, flatSteps, STEP_LABEL, testCaseIds } from './export-common.js';
import { writeXlsx, type XCell, type XSheet, type XStyle } from './xlsx-writer.js';

const STEP_FILL: Record<string, XStyle | undefined> = { P: undefined, H: 'healed', F: 'failed', S: 'skipped', B: 'error' };
const MAX_STEP_ROWS = 500_000;

/** Render the workbook. `reportHref` is the HTML report the permalinks open (default report.html, next to the workbook). */
export function renderReportXlsx(m: ReportModel, o: { reportHref?: string } = {}): Buffer {
  const href = o.reportHref ?? 'report.html';
  const link = (id: string): XCell => ({ v: 'open', link: `${href}#tests/${encodeURIComponent(id)}` });
  const b = m.brand;
  const L = labelsOf(b);
  const Cap = (x: string) => x[0].toUpperCase() + x.slice(1);
  const k = m.kpis;
  const p = m.previous?.kpis;
  const sheets: XSheet[] = [];

  // ---- Overview (the brand, the run, the counts once, the top causes)
  const ctx = m.context;
  const sum: XCell[][] = [
    ...(b.company ? [[{ v: b.company, s: 'muted' }] as XCell[]] : []),
    [{ v: `${m.title}${b.subtitle ? ` - ${b.subtitle}` : ''}`, s: 'title' }],
    [{ v: [`${b.name}${ctx?.environment ? ` / ${ctx.environment}` : ''}`, `${m.startedAt.replace('T', ' ').slice(0, 16)} UTC`, `run ${m.runId}`].join('  |  '), s: 'muted' }],
    ...(b.preparedBy ? [[{ v: `Prepared by ${b.preparedBy}`, s: 'muted' }] as XCell[]] : []),
    [],
    [{ v: 'Result', s: 'bold' }, { v: 'This run', s: 'bold' }, { v: 'Previous run', s: 'bold' }],
    [Cap(L.tests), k.total, p?.total],
    ['Passed', k.passed, p?.passed],
    ['Failed (incl. errors)', k.failed + k.errors, p ? p.failed + p.errors : undefined],
    ['Flaky', k.flaky, p?.flaky],
    ['Healed', k.healed, p?.healed],
    ['Skipped', k.skipped, p?.skipped],
    ['Pass rate', { v: k.passRate, s: 'percent' }, { v: p?.passRate, s: 'percent' }],
    ['Duration (s)', { v: Math.round(k.durationMs / 100) / 10, s: 'decimal' }, { v: p ? Math.round(p.durationMs / 100) / 10 : undefined, s: 'decimal' }],
    [],
  ];
  const groups = causeGroups(m);
  if (groups.length && !isHidden(b, 'failures')) {
    sum.push([{ v: L.sections.topFailures, s: 'bold' }, { v: Cap(L.tests), s: 'bold' }, { v: 'Category', s: 'bold' }]);
    for (const g of groups.slice(0, 8)) sum.push([firstLine(g.message, 200), g.tests.length, CATEGORY_LABEL[g.cat]]);
    sum.push([]);
  }
  sum.push(['Full report', { v: href, link: href }]);
  if (b.footer) sum.push([], [{ v: b.footer, s: 'muted' }]);
  sheets.push({ name: L.tabs.overview.slice(0, 31), widths: [44, 18, 22, 70], rows: sum, gridLines: false });

  // ---- Tests
  const testHead = ['Id', 'Test', 'State', 'Category', 'Suite', 'Browser', 'Duration (s)', 'Attempt', 'Risk', 'Tags', 'Requirements', 'Test cases', 'Owners', 'Failed step', 'Error', 'New or known', 'Suggested next step', 'Data row', 'History', 'Bugs', 'Report'];
  sheets.push({
    name: 'Tests', header: true,
    widths: [34, 46, 10, 15, 26, 10, 12, 8, 6, 26, 16, 12, 18, 34, 60, 12, 60, 28, 14, 14, 10],
    colStyles: [undefined, undefined, undefined, undefined, undefined, undefined, 'decimal'],
    rows: [testHead, ...m.tests.map((t): XCell[] => [
      t.id, t.name, { v: STATE_LABEL[t.state], s: t.state }, t.cat ? CATEGORY_LABEL[t.cat.c] : '', t.suite.join(' / '), t.browser ?? '',
      t.durationMs / 1000, t.attempt, t.risk, t.tags.join(' '), t.requirements.join(', '), testCaseIds(t).join(', '),
      t.owners.join(', '), t.failedStep ?? '', firstLine(t.error?.message, 500), t.failure ? (t.failure.known ? 'known' : { v: 'new', s: 'failed' }) : '',
      t.cat?.fix ?? '', t.row ? Object.entries(t.row).map(([x, y]) => `${x}=${y}`).join(', ') : '', t.history?.sequence.slice(-12) ?? '',
      t.bugs.map((b) => b.id).join(', '), link(t.id),
    ])],
  });

  // ---- Steps
  const steps: XCell[][] = [['Test id', 'Test', 'No', 'Level', 'Step', 'Status', 'Duration (ms)', 'Start (ms)', 'Actor', 'Locator', 'Error', 'Healed from', 'Healed to', 'Evidence']];
  outer: for (const t of m.tests) {
    for (const [no, depth, s] of flatSteps(t)) {
      if (steps.length > MAX_STEP_ROWS) break outer;
      const fill = STEP_FILL[s.s];
      steps.push([t.id, t.name, no, depth, `${'  '.repeat(depth)}${s.n}`, fill ? { v: STEP_LABEL[s.s], s: fill } : STEP_LABEL[s.s], s.d, s.t, s.a ?? '', s.l ?? '', firstLine(s.x?.message, 500), s.h?.from.join(' | ') ?? '', s.h?.to ?? '', s.e?.length ?? 0]);
    }
  }
  sheets.push({ name: 'Steps', header: true, widths: [30, 36, 5, 6, 56, 14, 12, 10, 10, 36, 60, 30, 30, 9], rows: steps });

  // ---- Failures (grouped by cause, as in the report)
  if (groups.length && !isHidden(b, 'failures')) {
    sheets.push({
      name: L.tabs.failures.slice(0, 31), header: true, widths: [15, 70, 7, 12, 26, 70, 60], colStyles: [undefined, 'wrap', undefined, undefined, undefined, 'wrap', 'wrap'],
      rows: [['Category', 'Cause', Cap(L.tests), 'New or known', 'First seen', 'Next step', Cap(L.tests)],
        ...groups.map((g): XCell[] => [CATEGORY_LABEL[g.cat], g.message, g.tests.length, g.kind === 'flaky' ? 'flaky' : g.known ? 'known' : { v: 'new', s: 'failed' }, g.firstSeenRun ?? (g.kind === 'flaky' ? '' : 'this run'), g.fix ?? '', g.tests.map((t) => t.name).join('; ')])],
    });
  }

  // ---- Requirements
  if (m.coverage.requirements && !isHidden(b, 'quality')) {
    const st: Record<string, XStyle> = { passing: 'passed', failing: 'failed', 'not-run': 'skipped', uncovered: 'skipped' };
    sheets.push({
      name: 'Requirements', header: true, widths: [16, 40, 12, 60, 40],
      rows: [['Requirement', 'Title', 'State', 'Tests', 'Link'], ...m.coverage.requirements.items.map((r): XCell[] => [r.id, r.title ?? '', { v: r.state, s: st[r.state] }, r.tests.join(', '), r.url ? { v: r.url, link: r.url } : ''])],
    });
  }

  // ---- Trend
  if (m.trend.length && !isHidden(b, 'trends')) {
    const policy = !!m.verdict && !isHidden(b, 'policy');
    sheets.push({
      name: L.tabs.trends.slice(0, 31), header: true, widths: [34, 24, 8, 8, 8, 10, 12, 14], colStyles: [undefined, undefined, undefined, undefined, undefined, 'percent', 'decimal'],
      rows: [['Run', 'Started', Cap(L.tests), 'Failed', 'Flaky', 'Pass rate', 'Duration (s)', ...(policy ? ['Readiness policy'] : [])], ...m.trend.map((t): XCell[] => [t.current ? { v: `${t.runId} (this run)`, s: 'bold' } : t.runId, t.startedAt, t.total, t.failed, t.flaky ?? '', t.passRate, t.durationMs / 1000, ...(policy ? [(t.readiness ?? '').replace(/_/g, ' ')] : [])])],
    });
  }

  // ---- Quality
  if (m.lenses && !isHidden(b, 'quality')) {
    const rows: XCell[][] = [['Lens', 'Rule or finding', 'Severity', 'What', 'Count', 'Pages', 'Tests']];
    for (const r of m.lenses.a11y?.rules ?? []) rows.push(['accessibility', r.id, r.impact, `${r.help}${r.sc.length ? ` (WCAG ${r.sc.join(', ')})` : ''}`, r.nodes, r.pages.join(', '), r.tests.join(', ')]);
    for (const f of m.lenses.security?.findings ?? []) rows.push(['security', f.id, f.severity, f.message, f.pages.length, f.pages.join(', '), f.tests.join(', ')]);
    for (const x of m.lenses.perf?.metrics ?? []) rows.push(['performance', x.metric, x.status, `worst ${Math.round(x.worst * 1000) / 1000}; budget ${x.warn ?? '-'} / ${x.error ?? '-'}`, x.samples, '', x.tests.join(', ')]);
    sheets.push({ name: 'Quality', header: true, widths: [14, 26, 10, 60, 8, 40, 50], rows });
  }

  // ---- Configuration and environment
  if (!isHidden(b, 'environment')) {
    if (m.config?.length) sheets.push({ name: 'Configuration', header: true, widths: [44, 80], rows: [['Setting', 'Value (secrets masked)'], ...m.config.map(([kk, vv]): XCell[] => [kk, vv])] });
    sheets.push({ name: L.tabs.environment.slice(0, 31), header: true, widths: [22, 80], rows: [['Item', 'Value'], ...contextRows(m).map(([kk, vv]): XCell[] => [kk, vv]), ...Object.entries(m.context?.extra ?? {}).map(([kk, vv]): XCell[] => [kk, vv])] });
  }
  if (m.verdict && !isHidden(b, 'policy')) {
    const v = m.verdict;
    sheets.push({ name: L.tabs.policy.slice(0, 31), widths: [22, 90], gridLines: false, rows: [[{ v: 'Readiness policy', s: 'title' }], [{ v: v.decision.replace(/_/g, ' '), s: v.decision === 'GO' ? 'passed' : v.decision === 'NO_GO' ? 'failed' : 'flaky' }, v.score !== undefined ? `score ${v.score} / 100` : ''], [], ...v.reasons.map((r): XCell[] => [r.kind, r.text])] });
  }

  const product = productName(b);
  return writeXlsx(sheets, { title: `${m.title}${b.subtitle ? ` - ${b.subtitle}` : ''}`, creator: product ? `${product} ${m.context?.eztestVersion ?? ''}`.trim() : (b.preparedBy ?? b.company ?? b.name), created: new Date(m.generatedAt) });
}
