/**
 * The run summary as an e-mail (email.html, and the `email` publisher's
 * message): table layout with inline styles and bgcolor attributes only - no
 * script, no SVG, no external images, no CSS grid - so it renders the same in
 * desktop and web mail clients, at 640 px and on a phone, in light and dark
 * mode. Bars are table cells; links are http(s) only.
 *
 * Also the subject line and the plain-text alternative of the same message.
 * The sections mirror the report's tabs (results, failures by cause, trend,
 * environment) and carry the brand; there is no verdict unless the readiness
 * policy is switched on for the report (report.readiness).
 */
import { escapeHtml as e } from './escape.js';
import { STATE_LABEL, TEST_STATES, type ReportModel, type TestState } from './data.js';
import { CATEGORY_LABEL, type FailureCategory } from './categorise.js';
import { causeGroups, type CauseGroup } from './causes.js';
import { isHidden, labelsOf, productName, readableOn } from './brand.js';
import { fmtMs, fmtPct } from './charts.js';
import { safeHttpUrl } from './integrations.js';
import { cardLinks } from './notify.js';
import { firstLine } from './export-common.js';

const C = {
  ink: '#16181d', muted: '#5b616b', border: '#e2e5ea', soft: '#f5f6f8', page: '#f5f6f8', card: '#ffffff', link: '#3b5bdb', brand: '#3b5bdb',
};
const STATE_BG: Record<TestState, string> = { passed: '#1f8a4c', healed: '#6a4fd6', flaky: '#c98a00', failed: '#d1343b', error: '#c2571a', skipped: '#8a8f98' };
const STATE_INK: Record<TestState, string> = { passed: '#176b3a', healed: '#523bb5', flaky: '#7d5600', failed: '#b3262d', error: '#9c4211', skipped: '#5b616b' };
const CAT_BG: Record<FailureCategory, string> = { product: '#fdecec', test: '#f0edfc', environment: '#fcefe6', data: '#fdf5e0', flaky: '#fdf5e0', unknown: '#f1f2f4' };
const CAT_INK: Record<FailureCategory, string> = { product: '#b3262d', test: '#523bb5', environment: '#9c4211', data: '#7d5600', flaky: '#7d5600', unknown: '#5b616b' };
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
  const L = labelsOf(m.brand);
  const bad = k.failed + k.errors;
  return bad ? `${bad} of ${k.total} ${L.tests} failed` : k.flaky ? `all ${k.total} ${L.tests} passed, ${k.flaky} only on retry` : `all ${k.total} ${L.tests} passed`;
}

/** The subject line: "Shop regression: 3 of 40 tests failed (run-...)"; the policy's decision leads only when report.readiness is on. */
export function emailSubject(m: ReportModel): string {
  return `${m.verdict ? `[${VERDICT[m.verdict.decision]}] ` : ''}${m.title}: ${headline(m)} (${m.runId})`;
}

const permalink = (base: string | undefined, id: string) => (base ? `${base.split('#')[0]}#tests/${encodeURIComponent(id)}` : undefined);

/** The plain-text alternative. */
export function renderEmailText(m: ReportModel, o: EmailOptions = {}): string {
  const k = m.kpis;
  const L = labelsOf(m.brand);
  const links = cardLinks(m, o);
  const groups = isHidden(m.brand, 'failures') ? [] : causeGroups(m);
  const product = productName(m.brand);
  const lines = [
    `${m.brand.company ? `${m.brand.company} - ` : ''}${m.title}${m.brand.subtitle ? ` - ${m.brand.subtitle}` : ''}`,
    `${headline(m)}. ${m.brand.name}${m.context?.environment ? ` / ${m.context.environment}` : ''}, ${m.startedAt.replace('T', ' ').slice(0, 16)} UTC, ${fmtMs(m.durationMs)}.`,
    '',
    `${k.total} ${L.tests}: ${k.passed} passed, ${k.failed + k.errors} failed, ${k.flaky} flaky, ${k.skipped} skipped${k.healed ? `, ${k.healed} healed` : ''}; pass rate ${fmtPct(k.passRate)}.`,
    ...(m.verdict && !isHidden(m.brand, 'policy') ? ['', `Readiness policy: ${VERDICT[m.verdict.decision]}${m.verdict.score !== undefined ? ` (score ${m.verdict.score})` : ''}`] : []),
    '',
    ...(groups.length ? ['Failures by cause:'] : []),
    ...groups.slice(0, 10).flatMap((g) => [
      `- ${g.tests.length} x ${firstLine(g.message, 200)} [${CATEGORY_LABEL[g.cat]}${g.kind === 'failure' && !g.known ? ', new' : ''}]`,
      ...(g.fix ? [`  next step: ${g.fix}`] : []),
      ...g.tests.slice(0, 5).map((t) => `  * ${t.name}${permalink(links.report, t.id) ? ` ${permalink(links.report, t.id)}` : ''}`),
    ]),
    '',
    ...(links.report ? [`Full report: ${links.report}`] : ['Full report: report.html in the run directory.']),
    ...(links.adoRun ? [`Azure DevOps test run: ${links.adoRun}`] : []),
    ...(links.build ? [`Build: ${links.build}`] : []),
    ...(links.pullRequest ? [`Pull request: ${links.pullRequest}`] : []),
    ...(m.brand.footer ? ['', m.brand.footer] : []),
    ...(m.brand.preparedBy ? [`Prepared by ${m.brand.preparedBy}`] : []),
    product ? `Sent by ${product} for run ${m.runId}.` : `Run ${m.runId}.`,
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** A cell; fixed-width cells give up their width on a phone (class ez-fixed). */
const td = (content: string, style = '', attrs = '') => `<td${attrs}${/(^|;)width:\d+px/.test(style) ? ' class="ez-fixed"' : ''} style="${FONT};font-size:14px;line-height:20px;color:${C.ink};${style}">${content}</td>`;
const section = (title: string, body: string) => `<tr><td style="padding:18px 24px 6px 24px;${FONT};font-size:15px;line-height:20px;font-weight:700;color:${C.ink}">${e(title)}</td></tr><tr><td style="padding:0 24px 6px 24px">${body}</td></tr>`;
const chip = (label: string, bg: string, ink: string) => `<span class="ez-chip" style="display:inline-block;padding:1px 8px;border-radius:9px;background:${bg};color:${ink};font-size:12px;line-height:18px;font-weight:700;border:1px solid ${ink}">${e(label)}</span>`;
/** A horizontal bar of `parts` (percent widths), as table cells. */
const bar = (parts: Array<{ pct: number; color: string; label: string }>, height = 12) => {
  const shown = parts.filter((p) => p.pct > 0);
  if (!shown.length) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${shown.map((p) => `<td width="${Math.max(1, Math.round(p.pct))}%" bgcolor="${p.color}" style="background:${p.color};height:${height}px;font-size:1px;line-height:${height}px" title="${e(p.label)}">&nbsp;</td>`).join('')}</tr></table>`;
};
const button = (url: string | undefined, label: string, primary: boolean, brandBg: string, onBrand: string, link: string) => {
  const u = safeHttpUrl(url);
  if (!u) return '';
  const bg = primary ? brandBg : C.card;
  const ink = primary ? onBrand : link;
  return `<td class="ez-btn" style="padding:0 8px 8px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${bg}"${primary ? '' : ' class="ez-btn-bg"'} style="background:${bg};border:1px solid ${primary ? bg : C.border};border-radius:6px;padding:9px 16px"><a href="${e(u)}"${primary ? ' class="ez-primary"' : ''} style="${FONT};font-size:14px;font-weight:700;color:${ink};text-decoration:none;display:inline-block">${e(label)}</a></td></tr></table></td>`;
};

/** The e-mail HTML. */
export function renderEmailHtml(m: ReportModel, o: EmailOptions = {}): string {
  const k = m.kpis;
  const L = labelsOf(m.brand);
  const b = m.brand;
  const links = cardLinks(m, o);
  const brand = b.palette?.light['brand-btn'] ?? C.brand;
  const onBrand = b.palette?.light['on-brand'] ?? readableOn(brand);
  const link = b.palette?.light['brand-ink'] ?? C.link;
  const headBg = b.palette?.header?.bg;
  const headInk = b.palette?.header?.text ?? C.ink;
  const headMuted = b.palette?.header?.muted ?? C.muted;
  const product = productName(b);
  const p = m.previous?.kpis;
  const a = (url: string | undefined, label: string) => {
    const u = safeHttpUrl(url);
    return u ? `<a href="${e(u)}" style="color:${link};text-decoration:underline">${e(label)}</a>` : e(label);
  };
  const delta = (cur: number, prev: number | undefined) => (prev === undefined || cur === prev ? '' : `${cur > prev ? '+' : '-'}${Math.abs(cur - prev)} vs previous`);
  const counts: Record<TestState, number> = { passed: k.passed, healed: k.healed, flaky: k.flaky, failed: k.failed, error: k.errors, skipped: k.skipped };
  const tiles: Array<[string, number, string, string]> = [
    [k.total === 1 ? L.test : L.tests, k.total, delta(k.total, p?.total), brand],
    ['passed', k.passed, delta(k.passed, p?.passed), STATE_BG.passed],
    ['failed', k.failed + k.errors, delta(k.failed + k.errors, p ? p.failed + p.errors : undefined), STATE_BG.failed],
    ['flaky', k.flaky, delta(k.flaky, p?.flaky), STATE_BG.flaky],
    ['skipped', k.skipped, delta(k.skipped, p?.skipped), STATE_BG.skipped],
  ];
  const tile = ([label, value, d, c]: [string, number, string, string]) => `<td width="20%" valign="top" style="padding:4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid ${C.border};border-top:3px solid ${c};border-radius:6px" bgcolor="${C.card}"><tr>${td(`<div style="font-size:22px;line-height:28px;font-weight:700">${e(value)}</div><div style="font-size:12px;line-height:16px;color:${C.muted}">${e(label[0].toUpperCase() + label.slice(1))}</div><div style="font-size:11px;line-height:14px;color:${C.muted}">${e(d) || '&nbsp;'}</div>`, 'padding:8px 10px')}</tr></table></td>`;
  const outcome = bar(TEST_STATES.map((s) => ({ pct: k.total ? (counts[s] / k.total) * 100 : 0, color: STATE_BG[s], label: `${STATE_LABEL[s]}: ${counts[s]}` })), 12);
  const legend = TEST_STATES.filter((s) => counts[s]).map((s) => `<span style="white-space:nowrap;margin-right:12px"><span style="display:inline-block;width:10px;height:10px;background:${STATE_BG[s]};border-radius:2px"></span> ${e(STATE_LABEL[s])} ${e(fmtPct(counts[s] / Math.max(1, k.total), 0))}</span>`).join(' ');
  const trend = m.trend.slice(-8);
  const trendRows = trend.length >= 2 && !isHidden(b, 'trends') ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${trend.map((t) => `<tr>${td(e(t.startedAt.slice(5, 16).replace('T', ' ')) + (t.current ? ' <strong>(this run)</strong>' : ''), `font-size:12px;color:${C.muted};width:150px;padding:2px 8px 2px 0;white-space:nowrap`)}<td style="padding:2px 0">${bar([{ pct: t.passRate * 100, color: t.current ? brand : '#a9bbf5', label: fmtPct(t.passRate) }, { pct: 100 - t.passRate * 100, color: '#eff1f4', label: '' }], 10)}</td>${td(e(fmtPct(t.passRate, 0)), 'font-size:12px;width:46px;text-align:right;padding-left:8px')}</tr>`).join('')}</table>` : '';
  const groups = isHidden(b, 'failures') ? [] : causeGroups(m);
  const groupRow = (g: CauseGroup) => `<tr><td style="padding:10px 0;border-top:1px solid ${C.border}">
<div style="${FONT};font-size:14px;line-height:20px"><strong style="color:${g.kind === 'flaky' ? STATE_INK.flaky : STATE_INK.failed}">${e(g.tests.length)} &times;</strong> ${chip(CATEGORY_LABEL[g.cat], CAT_BG[g.cat], CAT_INK[g.cat])}${g.kind === 'failure' && !g.known ? ` ${chip('new', '#ffffff', STATE_INK.failed)}` : ''}</div>
<div class="ez-err" style="font-family:Consolas,Menlo,monospace;font-size:12px;line-height:17px;color:${C.ink};background:${C.soft};padding:6px 8px;margin-top:4px;border-radius:4px;word-break:break-word">${e(firstLine(g.message, 300))}</div>
${g.fix ? `<div style="${FONT};font-size:13px;line-height:18px;margin-top:4px;color:${C.ink}"><strong>Next step:</strong> ${e(g.fix)}</div>` : ''}
<div style="${FONT};font-size:13px;line-height:19px;margin-top:4px">${g.tests.slice(0, 6).map((t) => a(permalink(links.report, t.id), t.name)).join(' &middot; ')}${g.tests.length > 6 ? ` <span style="color:${C.muted}">+${e(g.tests.length - 6)} more</span>` : ''}</div>
</td></tr>`;
  const ctx = m.context;
  const ctxRows: Array<[string, string]> = [
    ['Base URL', ctx?.baseUrl ?? ''], ['Browsers', ctx?.browsers.map((x) => `${x.name}${x.version ? ` ${x.version}` : ''}`).join(', ') ?? ''],
    ['Branch', ctx?.branch ? `${ctx.branch}${ctx.commit ? ` @ ${ctx.commit.sha.slice(0, 10)}` : ''}` : ''], ['Build', ctx?.build ? `${ctx.build.system} ${ctx.build.number ?? ctx.build.id ?? ''}`.trim() : 'local run'],
    ['Run id', m.runId],
  ].filter((r): r is [string, string] => !!r[1]);
  const buttons = [button(links.report, 'Open the full report', true, brand, onBrand, link), button(links.adoRun, 'Azure DevOps test run', false, brand, onBrand, link), button(links.build, 'Build', false, brand, onBrand, link), button(links.pullRequest, 'Pull request', false, brand, onBrand, link)].filter(Boolean).join('');
  const v = m.verdict && !isHidden(b, 'policy') ? m.verdict : undefined;
  const policy = v ? section('Readiness policy', `<div style="${FONT};font-size:14px;line-height:20px"><strong>${e(VERDICT[v.decision])}</strong>${v.score !== undefined ? ` <span style="color:${C.muted}">score ${e(v.score)} / 100</span>` : ''}</div>${v.reasons.filter((r) => r.kind !== 'info').slice(0, 4).map((r) => `<div style="${FONT};font-size:13px;line-height:18px;color:${C.ink}">&bull; ${e(r.text)}</div>`).join('')}`) : '';
  const metaLine = `${b.name}${ctx?.environment ? ` / ${ctx.environment}` : ''} · ${m.startedAt.replace('T', ' ').slice(0, 16)} UTC · ${fmtMs(m.durationMs)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${e(emailSubject(m))}</title>
<style>
@media (max-width:620px){.ez-wrap{width:100%!important}.ez-fixed{width:auto!important;white-space:normal!important}.ez-btn{display:inline-block!important}.ez-kpi td[width="20%"]{display:inline-block!important;width:33%!important;box-sizing:border-box}}
@media (prefers-color-scheme:dark){.ez-page{background:#111317!important}.ez-card{background:#1b1d22!important}.ez-card td,.ez-card div,.ez-card span,.ez-card h1,.ez-card strong{color:#eceef2!important}.ez-card a{color:#9db1f3!important}.ez-card table[bgcolor="#ffffff"],.ez-card .ez-soft{background:#202329!important}.ez-card .ez-chip{background:transparent!important}.ez-card .ez-err{background:#16181c!important}.ez-card a.ez-primary{color:${onBrand}!important}.ez-card .ez-btn-bg{background:#202329!important}}
</style></head>
<body class="ez-page" style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(`${headline(m)}. Pass rate ${fmtPct(k.passRate)}.`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" class="ez-page" style="background:${C.page}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" class="ez-wrap ez-card" bgcolor="${C.card}" style="width:640px;max-width:100%;background:${C.card};border:1px solid ${C.border};border-radius:8px;border-collapse:separate">
<tr><td bgcolor="${brand}" style="background:${brand};height:5px;font-size:1px;line-height:5px;border-radius:8px 8px 0 0">&nbsp;</td></tr>
<tr><td${headBg ? ` bgcolor="${headBg}"` : ''} style="padding:18px 24px 10px 24px;${FONT};${headBg ? `background:${headBg};` : ''}">${b.company ? `<div style="font-size:12px;line-height:16px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:${headMuted}">${e(b.company)}</div>` : ''}<h1 style="margin:2px 0 0 0;font-size:20px;line-height:26px;color:${headInk}">${e(m.title)}${b.subtitle ? ` <span style="font-weight:400;color:${headMuted}">&mdash; ${e(b.subtitle)}</span>` : ''}</h1><div style="font-size:13px;line-height:18px;color:${headMuted};margin-top:4px">${e(metaLine)}</div></td></tr>
<tr><td style="padding:10px 20px 0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ez-kpi"><tr>${tiles.map(tile).join('')}</tr></table></td></tr>
${section(`Outcome · ${fmtPct(k.passRate)} pass rate`, `${outcome}<div style="${FONT};font-size:12px;line-height:18px;color:${C.muted};margin-top:6px">${legend}</div>`)}
${isHidden(b, 'failures') ? '' : groups.length ? section('Failures by cause', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${groups.slice(0, 8).map(groupRow).join('')}</table>${groups.length > 8 ? `<div style="${FONT};font-size:13px;color:${C.muted};padding-top:6px">${e(groups.length - 8)} more causes in the full report.</div>` : ''}`) : section('Failures', `<div style="${FONT};font-size:14px;color:${STATE_INK.passed}">No failures in this run.</div>`)}
${trendRows ? section(`Pass rate, last ${trend.length} runs`, trendRows) : ''}
${isHidden(b, 'environment') ? '' : section('Environment', `<table role="presentation" cellpadding="0" cellspacing="0" border="0">${ctxRows.map(([kk, vv]) => `<tr>${td(e(kk), `font-size:12px;color:${C.muted};padding:2px 12px 2px 0;white-space:nowrap;vertical-align:top`)}${td(e(vv), 'font-size:13px;padding:2px 0;word-break:break-all')}</tr>`).join('')}</table>`)}
${policy}
${buttons ? `<tr><td style="padding:14px 24px 8px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${buttons}</tr></table></td></tr>` : `<tr><td style="padding:12px 24px;${FONT};font-size:13px;color:${C.muted}">The full report is report.html in the run directory.</td></tr>`}
<tr><td style="padding:12px 24px 18px 24px;${FONT};font-size:11px;line-height:16px;color:${C.muted};border-top:1px solid ${C.border}">${b.footer ? `<div style="color:${C.ink};margin-bottom:4px">${e(b.footer)}</div>` : ''}${b.preparedBy ? `<div>Prepared by ${e(b.preparedBy)}</div>` : ''}${product ? `Sent by ${e(product)} ${e(ctx?.eztestVersion ?? '')} for run ${e(m.runId)}.` : `Run ${e(m.runId)}.`}</td></tr>
</table></td></tr></table></body></html>`;
}
