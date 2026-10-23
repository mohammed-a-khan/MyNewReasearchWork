/**
 * The one-page summary (summary.html): the verdict, key figures, outcome and
 * trend charts, top failures and where the run was published, laid out for
 * one A4 / Letter page. Static HTML and SVG, no script: print it to PDF,
 * attach it, paste it into a mail.
 */
import { escapeHtml as e } from './escape.js';
import { STATE_LABEL, TEST_STATES, type ReportModel } from './data.js';
import { donutChart, fmtMs, fmtPct, lineChart } from './charts.js';
import { REPORT_CSS } from './styles.js';

const SUMMARY_CSS = `
@page{size:A4;margin:14mm}
body{background:var(--surface)}
.page{max-width:820px;margin:0 auto;padding:24px}
.s-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid var(--border);padding-bottom:12px;margin-bottom:14px}
.s-head h1{font-size:20px}.s-head .muted{font-size:12px}
.s-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0}
.s-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0}
.s-kpis div{border:1px solid var(--border);border-radius:8px;padding:8px 10px}.s-kpis b{display:block;font-size:20px}
.s-kpis span{font-size:11.5px;color:var(--text-2)}
.viz-table{display:none}
h2{font-size:14px;margin:14px 0 6px}
.s-row .donut{flex-wrap:nowrap;gap:12px}.s-row .donut svg{width:140px}.s-row .legend{min-width:0}
ul.tight{margin:0;padding-left:18px;font-size:12.5px;line-height:2.1}ul.tight a{display:inline-block;padding:4px 4px;line-height:16px}
@media print{.page{padding:0}}
`;

const RANK: Record<string, number> = { violation: 0, risk: 1, waived: 2, 'missing-input': 3, pass: 4, info: 5 };

export function renderSummaryHtml(m: ReportModel): string {
  const k = m.kpis;
  const v = m.verdict;
  const segs = TEST_STATES.map((s) => ({ key: s, label: STATE_LABEL[s], value: s === 'failed' ? k.failed : s === 'error' ? k.errors : s === 'passed' ? k.passed : s === 'healed' ? k.healed : s === 'flaky' ? k.flaky : k.skipped }));
  const trend = m.trend.length >= 2 ? lineChart(m.trend.map((t) => ({ label: t.startedAt.slice(5, 10), value: t.passRate, current: t.current })), { title: 'Pass rate trend', yMax: 1, yFormat: (x) => fmtPct(x, 0), series: 'series-1', area: true, width: 400, height: 170 }) : '<p class="muted small">Trend after two recorded runs.</p>';
  const links: string[] = [];
  const ado = m.integrations.ado;
  if (ado?.publish?.runUrl) links.push(`Azure DevOps test run: <a href="${e(ado.publish.runUrl)}">${e(`Run ${ado.publish.runId}`)}</a> (${e(ado.publish.status)})`);
  if (ado?.build?.url) links.push(`Pipeline build: <a href="${e(ado.build.url)}">${e(ado.build.number ?? ado.build.id ?? 'build')}</a>`);
  else if (m.context?.build?.url) links.push(`Build: <a href="${e(m.context.build.url)}">${e(m.context.build.number ?? m.context.build.id ?? 'build')}</a>`);
  if (m.integrations.pullRequest?.url) links.push(`Pull request: <a href="${e(m.integrations.pullRequest.url)}">#${e(m.integrations.pullRequest.number)}</a>`);
  if (m.integrations.resultsServer) links.push(`Results server: <a href="${e(m.integrations.resultsServer.url)}">open the run</a>`);
  const bugs = [...new Map((ado?.bugs ?? []).map((b) => [b.id, b])).values()];
  if (bugs.length) links.push(`Bugs: ${bugs.slice(0, 8).map((b) => (b.url ? `<a href="${e(b.url)}">${e(b.id)}</a>` : e(b.id))).join(', ')}`);
  if (m.integrations.jira?.bugs.length) links.push(`Jira: ${m.integrations.jira.bugs.slice(0, 8).map((b) => (b.url ? `<a href="${e(b.url)}">${e(b.key)}</a>` : e(b.key))).join(', ')}`);
  const ctx = m.context;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
<title>${e(m.title)} - summary - ${e(m.runId)}</title><style>${REPORT_CSS}${SUMMARY_CSS}</style></head><body><main class="page">
<div class="s-head"><div><div class="brand-name">${e(m.brand.name)}</div><h1>${e(m.title)}</h1><div class="muted">Run ${e(m.runId)} &middot; ${e(m.startedAt.replace('T', ' ').slice(0, 16))} UTC &middot; ${e(fmtMs(m.durationMs))}${ctx?.environment ? ` &middot; ${e(ctx.environment)}` : ''}${ctx?.branch ? ` &middot; ${e(ctx.branch)}` : ''}${ctx?.commit ? ` @ ${e(ctx.commit.sha.slice(0, 10))}` : ''}</div></div>
${m.brand.logo ? `<img src="${e(m.brand.logo)}" alt="${e(m.brand.name)} logo" style="height:36px">` : ''}</div>
<div class="card verdict v-${e(v.decision)}" style="grid-template-columns:auto 1fr"><div><div class="v-label">Release readiness</div><div class="v-decision">${e(v.decision.replace(/_/g, ' '))}</div>${v.score !== undefined ? `<div class="v-score">score ${e(v.score)} / 100</div>` : ''}</div>
<ul class="reasons">${[...v.reasons].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9)).slice(0, 6).map((r) => `<li><span class="rk ${e(r.kind)}">${e(r.kind)}</span><span>${e(r.text)}</span></li>`).join('')}</ul></div>
<div class="s-kpis">${[
    ['Tests', String(k.total)], ['Pass rate', fmtPct(k.passRate)], ['Failed', String(k.failed + k.errors)], ['Flaky', String(k.flaky)],
    ['Passed', String(k.passed)], ['Healed', String(k.healed)], ['Skipped', String(k.skipped)], ['Duration', fmtMs(k.durationMs)],
  ].map(([l, x]) => `<div><span>${e(l)}</span><b>${e(x)}</b></div>`).join('')}</div>
<div class="s-row"><div>${donutChart(segs, { title: 'Outcome', centre: fmtPct(k.passRate, 0), centreLabel: 'pass rate', size: 150 })}</div><div>${trend}</div></div>
<h2>Top failures</h2>${m.failureGroups.length ? `<ul class="tight">${m.failureGroups.slice(0, 6).map((g) => `<li><strong>${e(g.tests.length)} test(s)</strong>${g.known ? '' : ' <span class="badge b-failed">new</span>'} ${e(g.message.slice(0, 160))}</li>`).join('')}</ul>` : '<p class="small">No failures.</p>'}
${m.comparison ? `<h2>Against baseline ${e(m.comparison.baselineRunId)}</h2><p class="small">${e(m.comparison.newlyFailing.length)} newly failing, ${e(m.comparison.fixed.length)} fixed, ${e(m.comparison.slower.length)} slower, ${e(m.comparison.added.length)} new tests.</p>` : ''}
${links.length ? `<h2>Published to</h2><ul class="tight">${links.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
<p class="muted small" style="margin-top:16px">Full report: report.html in the run directory. Generated by EZTest ${e(ctx?.eztestVersion ?? '')}.</p>
</main></body></html>`;
}
