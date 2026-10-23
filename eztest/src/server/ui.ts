/**
 * The results server's read-only dashboards: server-rendered, script-free HTML
 * (the CSP allows no scripts at all), one stylesheet, semantic tables with
 * captions, a skip link, text next to every colour cue, and print styles.
 * Charts are inline SVG with presentation attributes and a text alternative.
 */
import { can, roleFor, type Principal } from './auth.js';
import { checkName, type ResultsService, type RunRow } from './service.js';

export interface UiContext {
  who: Principal;
  csrf?: string;
  oidc: boolean;
  service: ResultsService;
  params: string[];
  query: URLSearchParams;
  path: string;
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const enc = encodeURIComponent;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const dur = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
const when = (iso?: string) => (iso ? esc(iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z')) : '');

const STATUS: Record<string, string> = { passed: 'Passed', 'passed-healed': 'Passed (healed)', failed: 'Failed', skipped: 'Skipped', error: 'Error', GO: 'GO', GO_WITH_RISKS: 'GO with risks', NO_GO: 'NO GO' };
const badge = (s?: string) => (s ? `<span class="badge b-${esc(s.toLowerCase().replace(/_/g, '-'))}">${esc(STATUS[s] ?? s)}</span>` : '<span class="muted">none</span>');

function layout(ctx: UiContext, title: string, body: string, crumbs: Array<[string, string?]> = []): string {
  const who = ctx.who.kind === 'anonymous'
    ? `<a href="/login">Sign in</a>`
    : `<span>${esc(ctx.who.name)}</span>${ctx.csrf && ctx.who.kind === 'user' ? `<form method="post" action="/auth/logout" class="inline"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button type="submit" class="link">Sign out</button></form>` : ''}`;
  const nav = crumbs.length
    ? `<nav aria-label="Breadcrumb" class="crumbs"><ol>${crumbs.map(([label, href]) => `<li>${href ? `<a href="${esc(href)}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`}</li>`).join('')}</ol></nav>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - EZTest results</title><link rel="stylesheet" href="/static/server.css"></head>
<body><a class="skip" href="#main">Skip to content</a>
<header class="top"><a class="brand" href="/ui">EZTest results</a><div class="who">${who}</div></header>
<main id="main">${nav}<h1>${esc(title)}</h1>${body}</main>
<footer class="foot">Read-only dashboards. Evidence is hash-chained; actions are recorded in the audit log.</footer></body></html>`;
}

function table(caption: string, head: string[], rows: string[][], o: { empty?: string; numeric?: number[] } = {}): string {
  if (!rows.length) return `<p class="muted">${esc(o.empty ?? 'Nothing yet.')}</p>`;
  const num = new Set(o.numeric ?? []);
  return `<div class="tablewrap"><table><caption>${esc(caption)}</caption><thead><tr>${head.map((h, i) => `<th scope="col"${num.has(i) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${num.has(i) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** Stacked bars per run (passed / healed / failed+errors), oldest left; with a text alternative. */
function trendChart(runs: RunRow[]): string {
  const data = [...runs].reverse().slice(-30);
  if (!data.length) return '';
  const w = 640;
  const h = 140;
  const bw = Math.max(4, Math.floor(w / data.length) - 4);
  const bars = data.map((r, i) => {
    const s = r.summary;
    const total = s.total || 1;
    const x = i * (bw + 4) + 2;
    const parts: Array<[number, string]> = [[s.passed / total, 'var-pass'], [s.passedHealed / total, 'var-heal'], [(s.failed + s.errors) / total, 'var-fail']];
    let y = h;
    return parts.map(([f, cls]) => {
      const bh = Math.round(f * (h - 10));
      y -= bh;
      return bh > 0 ? `<rect class="${cls}" x="${x}" y="${y}" width="${bw}" height="${bh}"><title>${esc(r.runId)}: ${s.passed} passed, ${s.passedHealed} healed, ${s.failed + s.errors} failed</title></rect>` : '';
    }).join('');
  }).join('');
  return `<figure class="chart"><svg role="img" aria-labelledby="trend-t" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"><title id="trend-t">Pass, heal and failure share of the last ${data.length} runs, oldest first</title>${bars}</svg>
<figcaption><span class="key k-pass">passed</span> <span class="key k-heal">passed (healed)</span> <span class="key k-fail">failed or error</span></figcaption></figure>`;
}

async function projectsPage(ctx: UiContext): Promise<string> {
  const ps = (await ctx.service.projects()).filter((p) => can(ctx.who, p.project, 'read'));
  const rows = ps.map((p) => [`<a href="/ui/p/${enc(p.project)}">${esc(p.project)}</a>`, String(p.runs), when(p.lastRunAt), esc(roleFor(ctx.who, p.project) ?? ''), p.retentionDays ? `${p.retentionDays} days` : 'default']);
  return layout(ctx, 'Projects', table('Projects you can see', ['Project', 'Runs', 'Last run', 'Your role', 'Evidence retention'], rows, { empty: 'No projects yet. Publish a run with eztest run --publish or eztest publish <runDir>.', numeric: [1] }));
}

async function projectPage(ctx: UiContext): Promise<string | { status: number; message: string }> {
  const p = checkName('project', ctx.params[0]);
  if (!can(ctx.who, p, 'read')) return { status: 403, message: 'You cannot see this project' };
  const pageNo = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const perPage = 25;
  const runs = await ctx.service.listRuns(p, perPage + 1, (pageNo - 1) * perPage);
  const recent = pageNo === 1 ? runs : await ctx.service.listRuns(p, 30);
  const latest = recent[0];
  const flaky = await ctx.service.flaky(p);
  const flakyNow = flaky.scores.filter((s) => s.state === 'flaky' || s.state === 'broken');
  const decisions = ((await ctx.service.getState(p, 'heal-decisions')).data.decisions as Array<Record<string, unknown>> | undefined) ?? [];
  const quarantine = ((await ctx.service.getState(p, 'quarantine')).data.entries as Array<Record<string, unknown>> | undefined) ?? [];
  const trace = await ctx.service.traceability(p);
  const signed = recent.filter((r) => r.signed);

  const s = latest?.summary;
  const tiles = latest
    ? `<ul class="tiles" aria-label="Latest run">
<li><span class="t-label">Latest run</span><span class="t-value">${s ? pct(s.total ? (s.passed + s.passedHealed) / s.total : 0) : ''}</span><span class="t-sub">passed of ${s?.total ?? 0} journeys</span></li>
<li><span class="t-label">Readiness</span><span class="t-value">${badge(latest.readiness)}</span><span class="t-sub">${latest.readinessScore !== undefined ? `score ${latest.readinessScore}` : 'no policy'}</span></li>
<li><span class="t-label">Flaky or broken</span><span class="t-value">${flakyNow.length}</span><span class="t-sub">of ${flaky.scores.length} journeys tracked</span></li>
<li><span class="t-label">Quarantined</span><span class="t-value">${quarantine.length}</span><span class="t-sub">journeys</span></li>
<li><span class="t-label">Evidence</span><span class="t-value">${latest.verified ? 'Verified' : 'NOT verified'}</span><span class="t-sub">hash chain of the latest run</span></li></ul>`
    : '<p class="muted">No runs published yet.</p>';

  const runRows = runs.slice(0, perPage).map((r) => [
    `<a href="/ui/p/${enc(p)}/runs/${enc(r.runId)}">${esc(r.runId)}</a>`, when(r.startedAt), String(r.summary.total), String(r.summary.passed), String(r.summary.passedHealed),
    String(r.summary.failed + r.summary.errors), dur(r.durationMs), badge(r.readiness), r.verified ? 'yes' : '<strong>no</strong>', r.signed ? `signed by ${esc(r.signedBy)}` : '', r.evidenceDeletedAt ? 'expired' : 'kept',
  ]);
  const pager = `<nav class="pager" aria-label="Run history pages">${pageNo > 1 ? `<a href="?page=${pageNo - 1}">Newer runs</a>` : ''}${runs.length > perPage ? `<a href="?page=${pageNo + 1}">Older runs</a>` : ''}</nav>`;
  const flakyRows = flakyNow.slice(0, 15).map((f) => [esc(f.journeyId), esc(f.state), `${f.failures} of ${f.samples}`, String(f.healedPasses)]);
  const trendRows = flaky.trend.slice(-10).reverse().map((t) => [esc(t.runId), when(t.startedAt), pct(t.passRate), pct(t.healRate), String(t.flaky)]);
  const decisionRows = [...decisions].reverse().slice(0, 15).map((d) => [esc(d.journeyId), esc(d.stepId), esc(d.decision), esc(d.tier), esc(d.reviewer), when(String(d.decidedAt ?? ''))]);
  const signedRows = signed.map((r) => [`<a href="/ui/p/${enc(p)}/runs/${enc(r.runId)}">${esc(r.runId)}</a>`, badge(r.readiness), esc(r.signedBy), when(r.signedAt)]);
  const traceRows = trace.slice(0, 50).map((t) => [esc(t.requirement), t.journeys.map((j) => `${esc(j.journeyId)} ${badge(j.status)}`).join('<br>'), t.covered ? 'covered' : '<strong>not covered</strong>']);

  return layout(ctx, p, `${tiles}
<section aria-labelledby="h-trend"><h2 id="h-trend">Run history</h2>${trendChart(recent)}
${table('Published runs, newest first', ['Run', 'Started', 'Journeys', 'Passed', 'Healed', 'Failed', 'Duration', 'Readiness', 'Evidence verified', 'Sign-off', 'Evidence'], runRows, { numeric: [2, 3, 4, 5] })}${pager}
<p><a href="/api/projects/${enc(p)}/trends.csv" download>Download trends as CSV</a></p></section>
<section aria-labelledby="h-flaky"><h2 id="h-flaky">Flaky trends</h2>
${table('Pass, heal and flaky counts over the last runs', ['Run', 'Started', 'Pass rate', 'Heal rate', 'Flaky journeys'], trendRows, { numeric: [2, 3, 4] })}
${table('Journeys currently flaky or broken', ['Journey', 'State', 'Failures', 'Healed passes'], flakyRows, { empty: 'No flaky or broken journeys.', numeric: [3] })}</section>
<section aria-labelledby="h-heal"><h2 id="h-heal">Heal decisions</h2>${table('Latest reviewer decisions (shared by the team)', ['Journey', 'Step', 'Decision', 'Tier', 'Reviewer', 'When'], decisionRows, { empty: 'No heal decisions yet.' })}</section>
<section aria-labelledby="h-ready"><h2 id="h-ready">Readiness sign-offs</h2>${table('Signed readiness decisions', ['Run', 'Decision', 'Signed by', 'When'], signedRows, { empty: 'No signed readiness decisions.' })}</section>
<section aria-labelledby="h-trace"><h2 id="h-trace">Traceability</h2>${table('Requirements covered by the latest run', ['Requirement', 'Journeys', 'Coverage'], traceRows, { empty: 'No requirements cited by journeys.' })}</section>`, [['Projects', '/ui'], [p]]);
}

async function runPage(ctx: UiContext): Promise<string | { status: number; message: string }> {
  const p = checkName('project', ctx.params[0]);
  const id = checkName('run id', ctx.params[1]);
  if (!can(ctx.who, p, 'read')) return { status: 403, message: 'You cannot see this project' };
  const run = await ctx.service.getRun(p, id);
  if (!run) return { status: 404, message: 'Unknown run' };
  const perPage = 100;
  const pageNo = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const statusFilter = ctx.query.get('status') ?? '';
  let js = await ctx.service.runJourneys(p, id, 100_000);
  if (statusFilter) js = js.filter((j) => j.status === statusFilter);
  const slice = js.slice((pageNo - 1) * perPage, pageNo * perPage);
  const s = run.summary;
  const rows = slice.map((j) => [esc(j.journeyId), esc(j.name), badge(String(j.status)), dur(Number(j.durationMs)), String(j.risk), String(j.attempt)]);
  const filters = ['', 'failed', 'error', 'passed-healed', 'passed', 'skipped'].map((f) => (f === statusFilter ? `<strong>${esc(f || 'all')}</strong>` : `<a href="?status=${enc(f)}">${esc(f || 'all')}</a>`)).join(' | ');
  const pages = Math.max(1, Math.ceil(js.length / perPage));
  const pager = pages > 1 ? `<nav class="pager" aria-label="Journey pages">${pageNo > 1 ? `<a href="?status=${enc(statusFilter)}&amp;page=${pageNo - 1}">Previous</a>` : ''} page ${pageNo} of ${pages} ${pageNo < pages ? `<a href="?status=${enc(statusFilter)}&amp;page=${pageNo + 1}">Next</a>` : ''}</nav>` : '';
  const files = run.evidenceDeletedAt
    ? `<p>Evidence files were removed by the retention policy on ${when(run.evidenceDeletedAt)}.</p>`
    : `<p><a href="/api/projects/${enc(p)}/runs/${enc(id)}/files?path=report.html">Open the full HTML report</a></p>`;
  const meta = [
    ['Started', when(run.startedAt)], ['Duration', dur(run.durationMs)], ['Journeys', `${s.total}: ${s.passed} passed, ${s.passedHealed} healed, ${s.failed} failed, ${s.errors} errors, ${s.skipped} skipped`],
    ['Readiness', `${badge(run.readiness)}${run.readinessScore !== undefined ? ` score ${run.readinessScore}` : ''}`], ['Evidence chain', run.verified ? `verified, head <code>${esc(run.evidenceHead?.slice(0, 16))}</code>` : '<strong>not verified</strong>'],
    ['Sign-off', run.signed ? `signed by ${esc(run.signedBy)} at ${when(run.signedAt)}` : 'not signed'], ['Published by', `${esc(run.uploadedBy)} at ${when(run.uploadedAt)}`],
    ['Source', `${esc(run.branch ?? '')} ${esc(run.commit?.slice(0, 12) ?? '')}`],
  ];
  return layout(ctx, `Run ${id}`, `<dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>${files}
<p class="filters">Show: ${filters}</p>${table(`Journeys (${js.length})`, ['Journey', 'Name', 'Status', 'Duration', 'Risk', 'Attempt'], rows, { numeric: [3, 4, 5] })}${pager}`, [['Projects', '/ui'], [p, `/ui/p/${enc(p)}`], [id]]);
}

async function auditPage(ctx: UiContext): Promise<string | { status: number; message: string }> {
  if (!can(ctx.who, '*', 'audit.read')) return { status: 403, message: 'The audit log needs the approver or admin role on all projects' };
  const [entries, v] = await Promise.all([ctx.service.audit.list({ limit: 200 }), ctx.service.audit.verify()]);
  const rows = entries.map((e) => [String(e.seq), when(e.at), esc(e.actor), esc(e.action), esc(e.project ?? ''), esc(e.target ?? ''), `<code>${esc(e.hash.slice(0, 12))}</code>`]);
  return layout(ctx, 'Audit log', `<p>${v.ok ? `Chain intact: ${v.entries} entries, head <code>${esc(v.head.slice(0, 16))}</code>.` : `<strong>Chain BROKEN</strong>: ${esc(v.problems.slice(0, 3).join('; '))}`}</p>
${table('Latest 200 entries, newest first', ['#', 'When', 'Actor', 'Action', 'Project', 'Target', 'Hash'], rows, { numeric: [0] })}`, [['Projects', '/ui'], ['Audit log']]);
}

function loginPage(ctx: UiContext): string {
  const next = ctx.query.get('next') ?? '/ui';
  const sso = ctx.oidc ? `<p><a class="button" href="/auth/login?next=${enc(next)}">Sign in with your organisation account</a></p>` : '';
  return layout(ctx, 'Sign in', `${sso}
<form method="post" action="/auth/token" class="card"><h2>Sign in with an API token</h2>
<input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="next" value="${esc(next)}">
<label for="token">API token</label><input id="token" name="token" type="password" autocomplete="off" required>
<button type="submit">Sign in</button></form>`);
}

export async function renderPage(route: string, ctx: UiContext): Promise<string | { status: number; message: string } | undefined> {
  switch (route) {
    case '/login': return loginPage(ctx);
    case '/ui': return projectsPage(ctx);
    case '/ui/p/:p': return projectPage(ctx);
    case '/ui/p/:p/runs/:id': return runPage(ctx);
    case '/ui/audit': return auditPage(ctx);
    default: return undefined;
  }
}

export const SERVER_CSS = `:root{--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--card:#f6f8fa;--accent:#0b5cad;--pass:#1a7f37;--heal:#9a6700;--fail:#cf222e;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--card:#161b22;--accent:#58a6ff;--pass:#3fb950;--heal:#d29922;--fail:#f85149}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:var(--bg);padding:8px;z-index:2}
.top{display:flex;justify-content:space-between;align-items:center;padding:10px 20px;border-bottom:1px solid var(--line)}.brand{font-weight:700;text-decoration:none;color:var(--fg)}
.who{display:flex;gap:12px;align-items:center}.inline{display:inline}button.link{background:none;border:0;color:var(--accent);cursor:pointer;font:inherit;text-decoration:underline;padding:0}
main{max-width:1200px;margin:0 auto;padding:16px 20px}h1{font-size:1.6rem;margin:.4em 0}h2{font-size:1.2rem;margin:1.6em 0 .5em}
.crumbs ol{list-style:none;display:flex;gap:6px;padding:0;margin:0;color:var(--muted)}.crumbs li+li::before{content:"/";margin-right:6px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;list-style:none;padding:0}
.tiles li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-direction:column}
.t-label{color:var(--muted);font-size:.85rem}.t-value{font-size:1.5rem;font-weight:650}.t-sub{color:var(--muted);font-size:.8rem}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:8px 0}caption{text-align:left;color:var(--muted);padding:4px 0}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{font-weight:600;background:var(--card)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{display:inline-block;border:1px solid currentColor;border-radius:10px;padding:0 8px;font-size:.8rem;white-space:nowrap}
.b-passed,.b-go{color:var(--pass)}.b-passed-healed,.b-go-with-risks{color:var(--heal)}.b-failed,.b-error,.b-no-go{color:var(--fail)}.b-skipped{color:var(--muted)}
.muted{color:var(--muted)}.pager{display:flex;gap:16px;margin:8px 0}.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}.meta dt{color:var(--muted)}.meta dd{margin:0}
.chart{margin:8px 0}.chart svg{background:var(--card);border:1px solid var(--line);border-radius:6px}
.var-pass,.k-pass::before{fill:var(--pass);background:var(--pass)}.var-heal,.k-heal::before{fill:var(--heal);background:var(--heal)}.var-fail,.k-fail::before{fill:var(--fail);background:var(--fail)}
.key::before{content:"";display:inline-block;width:10px;height:10px;margin-right:4px;border-radius:2px}figcaption{font-size:.85rem;color:var(--muted);display:flex;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;max-width:420px;display:flex;flex-direction:column;gap:8px}
input{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button,.button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
.foot{color:var(--muted);font-size:.8rem;text-align:center;padding:24px}
@media print{.top,.skip,.pager,.foot,form,.filters{display:none}body{background:#fff;color:#000;font-size:11pt}a{color:#000;text-decoration:none}
.tiles li,th{background:#fff}table{page-break-inside:auto}tr{page-break-inside:avoid}.chart svg{border:0}main{max-width:none;padding:0}}`;
