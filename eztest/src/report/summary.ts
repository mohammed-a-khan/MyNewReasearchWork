/**
 * The one-page summary (summary.html): the brand, the result counts, the
 * outcome and pass-rate trend, the top failure causes and where the run was
 * published, laid out for one A4 / Letter page. Static HTML and SVG, no
 * script: print it to PDF, attach it, paste it into a mail. No verdict unless
 * report.readiness is on.
 */
import { escapeHtml as e } from './escape.js';
import type { ReportModel } from './data.js';
import { fmtMs, fmtPct, lineChart } from './charts.js';
import { REPORT_CSS } from './styles.js';
import { causeGroups } from './causes.js';
import { outcomeDonut } from './html.js';
import { isHidden, labelsOf, paletteCss, productName } from './brand.js';
import { CATEGORY_LABEL } from './categorise.js';

const SUMMARY_CSS = `
@page{size:A4;margin:14mm}
body{background:var(--surface)}
.page{max-width:820px;margin:0 auto;padding:24px}
.s-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:3px solid var(--brand);padding-bottom:12px;margin-bottom:14px}
.s-head h1{font-size:20px}.s-head .muted{font-size:12px}
.s-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:12px 0;align-items:center}
.s-kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:12px 0}
.s-kpis div{border:1px solid var(--border);border-top:3px solid var(--brand);border-radius:8px;padding:8px 10px}.s-kpis b{display:block;font-size:20px}
.s-kpis span{font-size:11.5px;color:var(--text-2)}
.viz-table{display:none}
h2{font-size:14px;margin:14px 0 6px}
ul.tight{margin:0;padding-left:18px;font-size:12.5px;line-height:2.1}ul.tight a{display:inline-block;padding:4px 4px;line-height:16px}
@media print{.page{padding:0}}
`;

export function renderSummaryHtml(m: ReportModel): string {
  const k = m.kpis;
  const b = m.brand;
  const L = labelsOf(b);
  const product = productName(b);
  const trend = m.trend.length >= 2 && !isHidden(b, 'trends') ? lineChart(m.trend.map((t) => ({ label: t.startedAt.slice(5, 10), value: t.passRate, current: t.current })), { title: 'Pass rate trend', yMax: 1, yFormat: (x) => fmtPct(x, 0), series: 'series-1', area: true, width: 400, height: 170 }) : '';
  const links: string[] = [];
  const ado = m.integrations.ado;
  if (ado?.publish?.runUrl) links.push(`Azure DevOps test run: <a href="${e(ado.publish.runUrl)}">${e(`Run ${ado.publish.runId}`)}</a> (${e(ado.publish.status)})`);
  if (ado?.build?.url) links.push(`Pipeline build: <a href="${e(ado.build.url)}">${e(ado.build.number ?? ado.build.id ?? 'build')}</a>`);
  else if (m.context?.build?.url) links.push(`Build: <a href="${e(m.context.build.url)}">${e(m.context.build.number ?? m.context.build.id ?? 'build')}</a>`);
  if (m.integrations.pullRequest?.url) links.push(`Pull request: <a href="${e(m.integrations.pullRequest.url)}">#${e(m.integrations.pullRequest.number)}</a>`);
  if (m.integrations.resultsServer) links.push(`Results server: <a href="${e(m.integrations.resultsServer.url)}">open the run</a>`);
  const bugs = [...new Map((ado?.bugs ?? []).map((x) => [x.id, x])).values()];
  if (bugs.length) links.push(`Bugs: ${bugs.slice(0, 8).map((x) => (x.url ? `<a href="${e(x.url)}">${e(x.id)}</a>` : e(x.id))).join(', ')}`);
  if (m.integrations.jira?.bugs.length) links.push(`Jira: ${m.integrations.jira.bugs.slice(0, 8).map((x) => (x.url ? `<a href="${e(x.url)}">${e(x.key)}</a>` : e(x.key))).join(', ')}`);
  const ctx = m.context;
  const groups = isHidden(b, 'failures') ? [] : causeGroups(m);
  const v = m.verdict && !isHidden(b, 'policy') ? m.verdict : undefined;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'">
<title>${e(m.title)} - summary - ${e(m.runId)}</title><style>${REPORT_CSS}${paletteCss(b.palette)}${SUMMARY_CSS}</style></head><body><main class="page">
<div class="s-head"><div>${b.company ? `<div class="brand-name">${e(b.company)}</div>` : ''}<h1>${e(m.title)}${b.subtitle ? ` <span class="muted" style="font-size:15px;font-weight:450">&mdash; ${e(b.subtitle)}</span>` : ''}</h1><div class="muted">${e(b.name)}${ctx?.environment ? ` / ${e(ctx.environment)}` : ''} &middot; ${e(m.startedAt.replace('T', ' ').slice(0, 16))} UTC &middot; ${e(fmtMs(m.durationMs))}${ctx?.branch ? ` &middot; ${e(ctx.branch)}` : ''}${ctx?.commit ? ` @ ${e(ctx.commit.sha.slice(0, 10))}` : ''}</div></div>
${b.logo ? `<img src="${e(b.logo)}" alt="${e(b.company ?? b.name)} logo" style="height:36px">` : ''}</div>
<div class="s-kpis">${[
    [k.total === 1 ? L.test : L.tests, String(k.total)], ['passed', String(k.passed)], ['failed', String(k.failed + k.errors)], ['flaky', String(k.flaky)], ['skipped', String(k.skipped)],
  ].map(([l, x]) => `<div><b>${e(x)}</b><span>${e(l[0].toUpperCase() + l.slice(1))}</span></div>`).join('')}</div>
<div class="s-row"><div>${outcomeDonut(m)}</div><div>${trend}</div></div>
${groups.length ? `<h2>${e(L.sections.topFailures)}</h2><ul class="tight">${groups.slice(0, 6).map((g) => `<li><strong>${e(g.tests.length)}</strong> &middot; ${e(CATEGORY_LABEL[g.cat])}${g.kind === 'failure' && !g.known ? ' <span class="badge b-failed">new</span>' : ''} &middot; ${e(g.message.slice(0, 160))}</li>`).join('')}</ul>` : ''}
${m.comparison && !isHidden(b, 'trends') ? `<h2>Since ${e(m.comparison.baselineStartedAt.replace('T', ' ').slice(0, 16))}</h2><p class="small">${e(m.comparison.newlyFailing.length)} newly failing, ${e(m.comparison.fixed.length)} fixed, ${e(m.comparison.slower.length)} slower, ${e(m.comparison.added.length)} new ${e(L.tests)}.</p>` : ''}
${links.length ? `<h2>Published to</h2><ul class="tight">${links.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''}
${v ? `<h2>Readiness policy</h2><p class="small"><strong>${e(v.decision.replace(/_/g, ' '))}</strong>${v.score !== undefined ? ` (score ${e(v.score)} / 100)` : ''}</p>` : ''}
${b.footer ? `<p class="small" style="margin-top:16px">${e(b.footer)}</p>` : ''}
<p class="muted small" style="margin-top:8px">${b.preparedBy ? `Prepared by ${e(b.preparedBy)}. ` : ''}Full report: report.html in the run directory.${product ? ` Generated by ${e(product)} ${e(ctx?.eztestVersion ?? '')}.` : ''}</p>
</main></body></html>`;
}
