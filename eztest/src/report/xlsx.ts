/**
 * The Excel workbook of a run (report.xlsx): one sheet per view - Summary,
 * Tests, Steps, Failures, Requirements, Trend, Quality, Configuration and
 * Environment - with frozen headers, filters, number formats, status
 * colours and links back to each test's permalink in report.html. Written
 * with EZTest's own SpreadsheetML writer (xlsx-writer.ts).
 */
import { attentionOf, STATE_LABEL, type ReportModel } from './data.js';
import { CATEGORY_LABEL, FAILURE_CATEGORIES } from './categorise.js';
import { contextRows, firstLine, flatSteps, STEP_LABEL, testCaseIds } from './export-common.js';
import { writeXlsx, type XCell, type XSheet, type XStyle } from './xlsx-writer.js';

const STEP_FILL: Record<string, XStyle | undefined> = { P: undefined, H: 'healed', F: 'failed', S: 'skipped', B: 'error' };
const MAX_STEP_ROWS = 500_000;

/** Render the workbook. `reportHref` is the HTML report the permalinks open (default report.html, next to the workbook). */
export function renderReportXlsx(m: ReportModel, o: { reportHref?: string } = {}): Buffer {
  const href = o.reportHref ?? 'report.html';
  const link = (id: string): XCell => ({ v: 'open', link: `${href}#test/${encodeURIComponent(id)}` });
  const k = m.kpis;
  const p = m.previous?.kpis;
  const sheets: XSheet[] = [];

  // ---- Summary
  const a = attentionOf(m);
  const vStyle: XStyle = m.verdict.decision === 'GO' ? 'passed' : m.verdict.decision === 'NO_GO' ? 'failed' : 'flaky';
  const sum: XCell[][] = [
    [{ v: m.title, s: 'title' }],
    [{ v: `${m.brand.name} - run ${m.runId}`, s: 'muted' }],
    [],
    [{ v: 'Release readiness', s: 'bold' }, { v: m.verdict.decision.replace(/_/g, ' '), s: vStyle }, m.verdict.score !== undefined ? `score ${m.verdict.score} / 100` : 'built-in rule'],
    ...m.verdict.reasons.slice(0, 8).map((r): XCell[] => ['', r.kind, '', r.text]),
    [],
    [{ v: 'Key figure', s: 'bold' }, { v: 'This run', s: 'bold' }, { v: 'Previous run', s: 'bold' }],
    ['Total tests', k.total, p?.total],
    ['Passed', k.passed, p?.passed],
    ['Failed (incl. errors)', k.failed + k.errors, p ? p.failed + p.errors : undefined],
    ['Flaky', k.flaky, p?.flaky],
    ['Healed', k.healed, p?.healed],
    ['Skipped', k.skipped, p?.skipped],
    ['Pass rate', { v: k.passRate, s: 'percent' }, { v: p?.passRate, s: 'percent' }],
    ['Duration (s)', { v: Math.round(k.durationMs / 100) / 10, s: 'decimal' }, { v: p ? Math.round(p.durationMs / 100) / 10 : undefined, s: 'decimal' }],
    [],
  ];
  if (m.categories && Object.keys(m.categories).length) {
    sum.push([{ v: 'Failure category', s: 'bold' }, { v: 'Tests', s: 'bold' }]);
    for (const c of FAILURE_CATEGORIES) if (m.categories[c]) sum.push([CATEGORY_LABEL[c], m.categories[c]]);
    sum.push([]);
  }
  sum.push(
    [{ v: 'Needs attention', s: 'bold' }, { v: 'Tests', s: 'bold' }],
    ['New failures', a.newFailures.length, '', a.newFailures.slice(0, 10).map((t) => t.name).join('; ')],
    ['Regressions (passed in baseline)', a.regressions.length, '', a.regressions.slice(0, 10).map((t) => t.name).join('; ')],
    ['Flaky', a.flaky.length, '', a.flaky.slice(0, 10).map((t) => t.name).join('; ')],
    ['Fixed', a.fixed.length, '', a.fixed.slice(0, 10).map((t) => t.name).join('; ')],
    [],
    ['Full report', { v: href, link: href }],
  );
  sheets.push({ name: 'Summary', widths: [32, 22, 22, 70], rows: sum, gridLines: false });

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

  // ---- Failures
  sheets.push({
    name: 'Failures', header: true, widths: [70, 7, 12, 26, 15, 70, 18, 50], colStyles: [ 'wrap', undefined, undefined, undefined, undefined, 'wrap' ],
    rows: [['Error', 'Tests', 'New or known', 'First seen', 'Category', 'Suggested next step', 'Signature', 'Tests sharing it'],
      ...m.failureGroups.map((g): XCell[] => [g.message, g.tests.length, g.known ? 'known' : { v: 'new', s: 'failed' }, g.firstSeenRun ?? 'this run', g.cat ? CATEGORY_LABEL[g.cat] : g.category ?? '', g.fix ?? '', g.signature, g.tests.join(', ')])],
  });

  // ---- Requirements
  if (m.coverage.requirements) {
    const st: Record<string, XStyle> = { passing: 'passed', failing: 'failed', 'not-run': 'skipped', uncovered: 'skipped' };
    sheets.push({
      name: 'Requirements', header: true, widths: [16, 40, 12, 60, 40],
      rows: [['Requirement', 'Title', 'State', 'Tests', 'Link'], ...m.coverage.requirements.items.map((r): XCell[] => [r.id, r.title ?? '', { v: r.state, s: st[r.state] }, r.tests.join(', '), r.url ? { v: r.url, link: r.url } : ''])],
    });
  }

  // ---- Trend
  if (m.trend.length) {
    sheets.push({
      name: 'Trend', header: true, widths: [34, 24, 8, 8, 10, 12, 14], colStyles: [undefined, undefined, undefined, undefined, 'percent', 'decimal'],
      rows: [['Run', 'Started', 'Tests', 'Failed', 'Pass rate', 'Duration (s)', 'Readiness'], ...m.trend.map((t): XCell[] => [t.current ? { v: `${t.runId} (this run)`, s: 'bold' } : t.runId, t.startedAt, t.total, t.failed, t.passRate, t.durationMs / 1000, (t.readiness ?? '').replace(/_/g, ' ')])],
    });
  }

  // ---- Quality
  if (m.lenses) {
    const rows: XCell[][] = [['Lens', 'Rule or finding', 'Severity', 'What', 'Count', 'Pages', 'Tests']];
    for (const r of m.lenses.a11y?.rules ?? []) rows.push(['accessibility', r.id, r.impact, `${r.help}${r.sc.length ? ` (WCAG ${r.sc.join(', ')})` : ''}`, r.nodes, r.pages.join(', '), r.tests.join(', ')]);
    for (const f of m.lenses.security?.findings ?? []) rows.push(['security', f.id, f.severity, f.message, f.pages.length, f.pages.join(', '), f.tests.join(', ')]);
    for (const x of m.lenses.perf?.metrics ?? []) rows.push(['performance', x.metric, x.status, `worst ${Math.round(x.worst * 1000) / 1000}; budget ${x.warn ?? '-'} / ${x.error ?? '-'}`, x.samples, '', x.tests.join(', ')]);
    sheets.push({ name: 'Quality', header: true, widths: [14, 26, 10, 60, 8, 40, 50], rows });
  }

  // ---- Configuration and environment
  if (m.config?.length) sheets.push({ name: 'Configuration', header: true, widths: [44, 80], rows: [['Setting', 'Value (secrets masked)'], ...m.config.map(([kk, vv]): XCell[] => [kk, vv])] });
  sheets.push({ name: 'Environment', header: true, widths: [22, 80], rows: [['Item', 'Value'], ...contextRows(m).map(([kk, vv]): XCell[] => [kk, vv]), ...Object.entries(m.context?.extra ?? {}).map(([kk, vv]): XCell[] => [kk, vv])] });

  return writeXlsx(sheets, { title: m.title, creator: `EZTest ${m.context?.eztestVersion ?? ''}`.trim(), created: new Date(m.generatedAt) });
}
