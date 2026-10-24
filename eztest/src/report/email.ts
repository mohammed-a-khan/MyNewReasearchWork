/**
 * The run summary as an e-mail (email.html, and the `email` publisher's
 * message): table layout with inline styles and bgcolor attributes only - no
 * script, no SVG, no external images, no CSS grid - so it renders the same in
 * desktop and web mail clients, at 640 px and on a phone, in light and dark
 * mode. Bars are table cells; links are http(s) only.
 *
 * Also the subject line and the plain-text alternative of the same message.
 */
import { escapeHtml as e } from './escape.js';
import { attentionOf, STATE_LABEL, TEST_STATES, type ReportModel, type TestModel, type TestState } from './data.js';
import { CATEGORY_LABEL, FAILURE_CATEGORIES, type FailureCategory } from './categorise.js';
import { fmtMs, fmtPct } from './charts.js';
import { safeHttpUrl } from './integrations.js';
import { cardLinks } from './notify.js';
import { firstLine } from './export-common.js';

const C = {
  ink: '#141413', muted: '#5f5e59', border: '#dddcd6', soft: '#f8f8f6', page: '#f4f4f2', card: '#ffffff', link: '#1c5cab', brand: '#1c5cab',
};
const STATE_BG: Record<TestState, string> = { passed: '#0ca30c', healed: '#6250d6', flaky: '#fab219', failed: '#d03b3b', error: '#ec835a', skipped: '#898781' };
const STATE_INK: Record<TestState, string> = { passed: '#0a6a0a', healed: '#4a3aa7', flaky: '#7a5200', failed: '#b02a2a', error: '#9a4010', skipped: '#5f5e59' };
const CAT_BG: Record<FailureCategory, string> = { product: '#fbeaea', test: '#efedfb', environment: '#fcefe8', data: '#fdf4dd', flaky: '#fdf4dd', unknown: '#f0efec' };
const CAT_INK: Record<FailureCategory, string> = { product: '#b02a2a', test: '#4a3aa7', environment: '#9a4010', data: '#7a5200', flaky: '#7a5200', unknown: '#5f5e59' };
const VERDICT = { GO: 'GO', GO_WITH_RISKS: 'GO WITH RISKS', NO_GO: 'NO GO' } as const;
const FONT = 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';

export interface EmailOptions {
  /** Where the full HTML report is reachable (CI artefact, results server, ADO attachment). */
  reportUrl?: string;
  /** Results server run URL. */
  runUrl?: string;
}

function headline(m: ReportModel): string {
  const k = m.kpis;
  const bad = k.failed + k.errors;
  return bad ? `${bad} of ${k.total} tests failed` : k.flaky ? `all ${k.total} tests passed, ${k.flaky} only on retry` : `all ${k.total} tests passed`;
}

/** The subject line: "[NO GO] Shop regression: 3 of 40 tests failed (run-...)". */
export function emailSubject(m: ReportModel): string {
  return `[${VERDICT[m.verdict.decision]}] ${m.title}: ${headline(m)} (${m.runId})`;
}

const permalink = (base: string | undefined, id: string) => (base ? `${base.split('#')[0]}#test/${encodeURIComponent(id)}` : undefined);

/** The plain-text alternative. */
export function renderEmailText(m: ReportModel, o: EmailOptions = {}): string {
  const k = m.kpis;
  const links = cardLinks(m, o);
  const a = attentionOf(m);
  const lines = [
    `${m.title} - ${VERDICT[m.verdict.decision]}`,
    `${headline(m)}. Run ${m.runId}, ${m.startedAt.replace('T', ' ').slice(0, 16)} UTC, ${fmtMs(m.durationMs)}.`,
    '',
    `Passed ${k.passed}, failed ${k.failed + k.errors}, flaky ${k.flaky}, healed ${k.healed}, skipped ${k.skipped}; pass rate ${fmtPct(k.passRate)}.`,
    ...(m.previous ? [`Previous run ${m.previous.runId}: pass rate ${fmtPct(m.previous.kpis.passRate)}, ${fmtMs(m.previous.kpis.durationMs)}.`] : []),
    '',
    ...(a.newFailures.length ? [`New failures: ${a.newFailures.map((t) => t.name).join('; ')}`] : []),
    ...(a.regressions.length ? [`Regressions: ${a.regressions.map((t) => t.name).join('; ')}`] : []),
    ...(a.flaky.length ? [`Flaky: ${a.flaky.map((t) => t.name).join('; ')}`] : []),
    ...(a.fixed.length ? [`Fixed: ${a.fixed.map((t) => t.name).join('; ')}`] : []),
    '',
    ...m.tests.filter((t) => t.state === 'failed' || t.state === 'error').slice(0, 15).flatMap((t) => [
      `- ${t.name}${t.cat ? ` [${CATEGORY_LABEL[t.cat.c]}]` : ''}`,
      ...(t.failedStep ? [`  at: ${t.failedStep}`] : []),
      ...(t.error ? [`  ${firstLine(t.error.message, 240)}`] : []),
      ...(t.cat ? [`  next step: ${t.cat.fix}`] : []),
      ...(permalink(links.report, t.id) ? [`  ${permalink(links.report, t.id)}`] : []),
    ]),
    '',
    ...(links.report ? [`Full report: ${links.report}`] : ['Full report: report.html in the run directory.']),
    ...(links.adoRun ? [`Azure DevOps test run: ${links.adoRun}`] : []),
    ...(links.build ? [`Build: ${links.build}`] : []),
    ...(links.pullRequest ? [`Pull request: ${links.pullRequest}`] : []),
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A cell; fixed-width cells give up their width on a phone (class ez-fixed). */
const td = (content: string, style = '', attrs = '') => `<td${attrs}${/(^|;)width:\d+px/.test(style) ? ' class="ez-fixed"' : ''} style="${FONT};font-size:14px;line-height:20px;color:${C.ink};${style}">${content}</td>`;
const a = (url: string | undefined, label: string, style = '') => {
  const u = safeHttpUrl(url);
  return u ? `<a href="${e(u)}" style="color:${C.link};text-decoration:underline;${style}">${e(label)}</a>` : e(label);
};
const section = (title: string, body: string) => `<tr><td style="padding:18px 24px 6px 24px;${FONT};font-size:15px;line-height:20px;font-weight:700;color:${C.ink}">${e(title)}</td></tr><tr><td style="padding:0 24px 6px 24px">${body}</td></tr>`;
const chip = (label: string, bg: string, ink: string) => `<span class="ez-chip" style="display:inline-block;padding:1px 8px;border-radius:9px;background:${bg};color:${ink};font-size:12px;line-height:18px;font-weight:700;border:1px solid ${ink}">${e(label)}</span>`;
/** A horizontal bar of `parts` (percent widths), as table cells. */
const bar = (parts: Array<{ pct: number; color: string; label: string }>, height = 12) => {
  const shown = parts.filter((p) => p.pct > 0);
  if (!shown.length) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${shown.map((p) => `<td width="${Math.max(1, Math.round(p.pct))}%" bgcolor="${p.color}" style="background:${p.color};height:${height}px;font-size:1px;line-height:${height}px" title="${e(p.label)}">&nbsp;</td>`).join('')}</tr></table>`;
};
const button = (url: string | undefined, label: string, primary = false) => {
  const u = safeHttpUrl(url);
  if (!u) return '';
  const bg = primary ? C.brand : C.card;
  const ink = primary ? '#ffffff' : C.link;
  return `<td class="ez-btn" style="padding:0 8px 8px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${bg}"${primary ? '' : ' class="ez-btn-bg"'} style="background:${bg};border:1px solid ${primary ? bg : C.border};border-radius:6px;padding:9px 16px"><a href="${e(u)}"${primary ? ' class="ez-primary"' : ''} style="${FONT};font-size:14px;font-weight:700;color:${ink};text-decoration:none;display:inline-block">${e(label)}</a></td></tr></table></td>`;
};

/** The e-mail HTML. */
export function renderEmailHtml(m: ReportModel, o: EmailOptions = {}): string {
  const k = m.kpis;
  const v = m.verdict;
  const links = cardLinks(m, o);
  const brand = m.brand.color && /^#[0-9a-f]{6}$/i.test(m.brand.color) ? m.brand.color : C.brand;
  const vBg = v.decision === 'GO' ? STATE_BG.passed : v.decision === 'NO_GO' ? STATE_BG.failed : STATE_BG.flaky;
  const vInk = v.decision === 'GO' ? STATE_INK.passed : v.decision === 'NO_GO' ? STATE_INK.failed : STATE_INK.flaky;
  const p = m.previous?.kpis;
  const delta = (cur: number, prev: number | undefined, f: (n: number) => string = String) => (prev === undefined ? '' : cur === prev ? 'same as previous' : `${cur > prev ? '+' : '-'}${f(Math.abs(cur - prev))} vs previous`);
  const kpis: Array<[string, string, string, string]> = [
    ['Tests', String(k.total), delta(k.total, p?.total), C.brand],
    ['Pass rate', fmtPct(k.passRate), p ? `${k.passRate >= p.passRate ? '+' : '-'}${(Math.abs(k.passRate - p.passRate) * 100).toFixed(1)} pp vs previous` : '', C.brand],
    ['Failed', String(k.failed + k.errors), delta(k.failed + k.errors, p ? p.failed + p.errors : undefined), STATE_BG.failed],
    ['Duration', fmtMs(k.durationMs), delta(k.durationMs, p?.durationMs, fmtMs), C.brand],
    ['Passed', String(k.passed), delta(k.passed, p?.passed), STATE_BG.passed],
    ['Flaky', String(k.flaky), delta(k.flaky, p?.flaky), STATE_BG.flaky],
    ['Healed', String(k.healed), delta(k.healed, p?.healed), STATE_BG.healed],
    ['Skipped', String(k.skipped), delta(k.skipped, p?.skipped), STATE_BG.skipped],
  ];
  const kpiCell = ([label, value, d, c]: [string, string, string, string]) => `<td width="25%" valign="top" style="padding:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid ${C.border};border-left:4px solid ${c};border-radius:6px" bgcolor="${C.card}"><tr>${td(`<div style="font-size:12px;line-height:16px;color:${C.muted}">${e(label)}</div><div style="font-size:22px;line-height:28px;font-weight:700">${e(value)}</div><div style="font-size:11px;line-height:14px;color:${C.muted}">${e(d) || '&nbsp;'}</div>`, 'padding:8px 10px')}</tr></table></td>`;
  const counts: Record<TestState, number> = { passed: k.passed, healed: k.healed, flaky: k.flaky, failed: k.failed, error: k.errors, skipped: k.skipped };
  const outcome = bar(TEST_STATES.map((s) => ({ pct: k.total ? (counts[s] / k.total) * 100 : 0, color: STATE_BG[s], label: `${STATE_LABEL[s]}: ${counts[s]}` })), 14);
  const legend = TEST_STATES.filter((s) => counts[s]).map((s) => `<span style="white-space:nowrap;margin-right:12px"><span style="display:inline-block;width:10px;height:10px;background:${STATE_BG[s]};border-radius:2px"></span> ${e(STATE_LABEL[s])} ${e(counts[s])}</span>`).join(' ');
  const trend = m.trend.slice(-8);
  const trendRows = trend.length >= 2 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${trend.map((t) => `<tr>${td(e(t.startedAt.slice(5, 16).replace('T', ' ')) + (t.current ? ' <strong>(this run)</strong>' : ''), `font-size:12px;color:${C.muted};width:150px;padding:2px 8px 2px 0;white-space:nowrap`)}<td style="padding:2px 0">${bar([{ pct: t.passRate * 100, color: t.current ? brand : '#9ec5f4', label: fmtPct(t.passRate) }, { pct: 100 - t.passRate * 100, color: '#eeeeeb', label: '' }], 10)}</td>${td(e(fmtPct(t.passRate, 0)), 'font-size:12px;width:46px;text-align:right;padding-left:8px')}</tr>`).join('')}</table>` : '';
  const cats = m.categories ?? {};
  const catMax = Math.max(1, ...Object.values(cats).map((x) => x ?? 0));
  const catRows = FAILURE_CATEGORIES.filter((c) => cats[c]).map((c) => `<tr>${td(chip(CATEGORY_LABEL[c], CAT_BG[c], CAT_INK[c]), 'width:150px;padding:3px 8px 3px 0')}<td style="padding:3px 0">${bar([{ pct: (cats[c]! / catMax) * 100, color: CAT_INK[c], label: String(cats[c]) }, { pct: 100 - (cats[c]! / catMax) * 100, color: C.card, label: '' }], 10)}</td>${td(e(cats[c]), 'font-size:13px;width:46px;text-align:right;padding-left:8px')}</tr>`).join('');
  const at = attentionOf(m);
  const attnRow = (label: string, list: Array<{ id: string; name: string }>, color: string) => list.length ? `<tr>${td(`<strong style="color:${color}">${e(list.length)}</strong> ${e(label)}`, 'width:150px;padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap')}${td(list.slice(0, 5).map((t) => a(permalink(links.report, t.id), t.name)).join(', ') + (list.length > 5 ? ` <span style="color:${C.muted}">+${e(list.length - 5)} more</span>` : ''), 'font-size:13px;padding:4px 0')}</tr>` : '';
  const attn = [attnRow('new failures', at.newFailures, STATE_INK.failed), attnRow('regressions', at.regressions, STATE_INK.failed), attnRow('flaky', at.flaky, STATE_INK.flaky), attnRow('fixed', at.fixed, STATE_INK.passed), attnRow('slower', at.slower, C.ink)].join('');
  const failing = m.tests.filter((t) => t.state === 'failed' || t.state === 'error');
  const failRow = (t: TestModel) => `<tr><td style="padding:10px 0;border-top:1px solid ${C.border}">
<div style="${FONT};font-size:14px;line-height:20px;font-weight:700">${a(permalink(links.report, t.id), t.name)} ${t.cat ? chip(CATEGORY_LABEL[t.cat.c], CAT_BG[t.cat.c], CAT_INK[t.cat.c]) : ''}${t.failure && !t.failure.known ? ` ${chip('new', '#ffffff', STATE_INK.failed)}` : ''}</div>
<div style="${FONT};font-size:12px;line-height:16px;color:${C.muted}">${e([t.id, t.browser, t.suite.join(' / '), fmtMs(t.durationMs), t.ado?.testCases.length ? `test case ${t.ado.testCases.map((c) => `#${c.id}`).join(', ')}` : ''].filter(Boolean).join(' | '))}</div>
${t.failedStep ? `<div style="${FONT};font-size:13px;line-height:18px;margin-top:4px">Failed at: <strong>${e(t.failedStep)}</strong></div>` : ''}
${t.error ? `<div class="ez-err" style="font-family:Consolas,Menlo,monospace;font-size:12px;line-height:17px;color:${STATE_INK.failed};background:#fbeaea;padding:6px 8px;margin-top:4px;border-radius:4px;word-break:break-word">${e(firstLine(t.error.message, 400))}</div>` : ''}
${t.cat ? `<div style="${FONT};font-size:13px;line-height:18px;margin-top:4px;color:${C.ink}"><strong>Next step:</strong> ${e(t.cat.fix)}</div>` : ''}
</td></tr>`;
  const ctx = m.context;
  const ctxRows: Array<[string, string]> = [
    ['Environment', ctx?.environment ?? ''], ['Base URL', ctx?.baseUrl ?? ''], ['Browsers', ctx?.browsers.map((b) => `${b.name}${b.version ? ` ${b.version}` : ''}`).join(', ') ?? ''],
    ['Branch', ctx?.branch ? `${ctx.branch}${ctx.commit ? ` @ ${ctx.commit.sha.slice(0, 10)}` : ''}` : ''], ['Build', ctx?.build ? `${ctx.build.system} ${ctx.build.number ?? ctx.build.id ?? ''}`.trim() : 'local run'],
    ['Started', `${m.startedAt.replace('T', ' ').slice(0, 19)} UTC`], ['Run id', m.runId],
  ].filter((r): r is [string, string] => !!r[1]);
  const buttons = [button(links.report, 'Open the full report', true), button(links.adoRun, 'Azure DevOps test run'), button(links.build, 'Build'), button(links.pullRequest, 'Pull request')].filter(Boolean).join('');
  const reasons = [...v.reasons].filter((r) => r.kind !== 'info').slice(0, 4).map((r) => `<div style="${FONT};font-size:13px;line-height:18px;color:${C.ink}">&bull; ${e(r.text)}</div>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${e(emailSubject(m))}</title>
<style>
@media (max-width:620px){.ez-wrap{width:100%!important}.ez-fixed{width:auto!important;white-space:normal!important}.ez-btn{display:inline-block!important}.ez-kpi td[width="25%"]{display:inline-block!important;width:50%!important;box-sizing:border-box}}
@media (prefers-color-scheme:dark){.ez-page{background:#0e0e0d!important}.ez-card{background:#1a1a19!important}.ez-card td,.ez-card div,.ez-card span,.ez-card h1,.ez-card strong{color:#f0efec!important}.ez-card a{color:#8dbcf2!important}.ez-card table[bgcolor="#ffffff"],.ez-card .ez-soft{background:#20201e!important}.ez-card .ez-chip{background:transparent!important}.ez-card .ez-err{background:#341a1a!important;color:#ff8f8a!important}.ez-card a.ez-primary{color:#ffffff!important}.ez-card .ez-btn-bg{background:#20201e!important}.ez-card .ez-v-NO_GO{color:#ff8f8a!important}.ez-card .ez-v-GO{color:#5fd35f!important}.ez-card .ez-v-GO_WITH_RISKS{color:#f5c451!important}}
</style></head>
<body class="ez-page" style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(`${VERDICT[v.decision]}: ${headline(m)}. Pass rate ${fmtPct(k.passRate)}.`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" class="ez-page" style="background:${C.page}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" class="ez-wrap ez-card" bgcolor="${C.card}" style="width:640px;max-width:100%;background:${C.card};border:1px solid ${C.border};border-radius:8px;border-collapse:separate">
<tr><td bgcolor="${brand}" style="background:${brand};height:6px;font-size:1px;line-height:6px;border-radius:8px 8px 0 0">&nbsp;</td></tr>
<tr><td style="padding:18px 24px 4px 24px;${FONT}"><div style="font-size:12px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${C.muted}">${e(m.brand.name)}</div><h1 style="margin:2px 0 0 0;font-size:20px;line-height:26px;color:${C.ink}">${e(m.title)}</h1></td></tr>
<tr><td style="padding:10px 24px 4px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ez-soft" style="border-collapse:separate;border:1px solid ${C.border};border-left:5px solid ${vBg};border-radius:6px" bgcolor="${C.soft}"><tr>${td(`<div style="font-size:11px;line-height:14px;font-weight:700;letter-spacing:.06em;color:${C.muted}">RELEASE READINESS</div><div class="ez-v-${e(v.decision)}" style="font-size:24px;line-height:30px;font-weight:800;color:${vInk}">${e(VERDICT[v.decision])}</div><div style="font-size:12px;color:${C.muted}">${v.score !== undefined ? `score ${e(v.score)} / 100` : 'built-in rule'}</div>`, 'padding:12px 14px;width:170px;vertical-align:top')}${td(`<div style="font-size:15px;line-height:20px;font-weight:700;margin-bottom:4px">${e(headline(m))}</div>${reasons}`, 'padding:12px 14px 12px 0;vertical-align:top')}</tr></table></td></tr>
<tr><td style="padding:8px 20px 0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ez-kpi"><tr>${kpis.slice(0, 4).map(kpiCell).join('')}</tr><tr>${kpis.slice(4).map(kpiCell).join('')}</tr></table></td></tr>
${section('Outcome', `${outcome}<div style="${FONT};font-size:12px;line-height:18px;color:${C.muted};margin-top:6px">${legend}</div>`)}
${trendRows ? section(`Pass rate, last ${trend.length} runs`, trendRows) : ''}
${attn ? section('Needs attention', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${attn}</table>`) : ''}
${catRows ? section('Failure categories', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${catRows}</table>`) : ''}
${failing.length ? section(`Failures (${failing.length})`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${failing.slice(0, 12).map(failRow).join('')}</table>${failing.length > 12 ? `<div style="${FONT};font-size:13px;color:${C.muted};padding-top:6px">+${e(failing.length - 12)} more in the full report.</div>` : ''}`) : section('Failures', `<div style="${FONT};font-size:14px;color:${STATE_INK.passed}">No failures in this run.</div>`)}
${section('Run', `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${ctxRows.map(([kk, vv]) => `<tr>${td(e(kk), `font-size:12px;color:${C.muted};padding:2px 12px 2px 0;white-space:nowrap;vertical-align:top`)}${td(e(vv), 'font-size:13px;padding:2px 0;word-break:break-all')}</tr>`).join('')}</table>`)}
${buttons ? `<tr><td style="padding:14px 24px 8px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${buttons}</tr></table></td></tr>` : `<tr><td style="padding:12px 24px;${FONT};font-size:13px;color:${C.muted}">The full report is report.html in the run directory (and attached to the Azure DevOps test run when the run is published).</td></tr>`}
<tr><td style="padding:12px 24px 18px 24px;${FONT};font-size:11px;line-height:16px;color:${C.muted};border-top:1px solid ${C.border}">Sent by EZTest ${e(ctx?.eztestVersion ?? '')} for run ${e(m.runId)}.</td></tr>
</table></td></tr></table></body></html>`;
}
