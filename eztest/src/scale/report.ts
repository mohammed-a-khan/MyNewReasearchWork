/**
 * The HTML report for large runs (thousands of journeys). The regular report
 * renders every journey, step and evidence row as HTML, which reaches tens of
 * megabytes at 5,000 journeys. This one stays small and fast:
 *
 * - journeys and steps are embedded once as compact JSON (strings interned),
 *   and the journey list is virtualised: only the rows in view are in the DOM;
 * - a journey's steps, errors, heal and evidence links are built on demand
 *   when it is opened (DOM APIs and textContent only, never innerHTML of data);
 * - the static part (summary, readiness, triage counts, failures) is plain
 *   HTML, so the page prints as an executive summary without any script.
 *
 * It keeps the report contract: one self-contained file, inline script/style
 * only (it works under the Studio's report CSP and from file://), relative
 * evidence links only.
 */
import type { EvidenceRef, JourneyResult, RunResult, StepResult } from '../core/index.js';
import type { ReportInsights } from '../report/model.js';
import { escapeHtml as e, safeRelativeUrl } from '../report/escape.js';

/** Runs with more journeys than this get the large-run report (EZTEST_REPORT_LARGE_THRESHOLD overrides). */
export const LARGE_REPORT_THRESHOLD = 1000;

export function largeReportThreshold(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.EZTEST_REPORT_LARGE_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : LARGE_REPORT_THRESHOLD;
}

const STATUS = ['passed', 'passed-healed', 'failed', 'skipped', 'error', 'blocked'] as const;
const LABEL: Record<string, string> = { passed: 'Passed', 'passed-healed': 'Passed (healed)', failed: 'Failed', skipped: 'Skipped', error: 'Error', blocked: 'Blocked' };

class Interner {
  readonly list: string[] = [];
  private readonly map = new Map<string, number>();
  id(s: string): number {
    let i = this.map.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.map.set(s, i);
    }
    return i;
  }
}

/** Embed JSON safely inside a <script type="application/json"> element. */
export function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function compactSteps(steps: StepResult[], s: Interner, depth = 0): unknown[][] {
  return steps.flatMap((st): unknown[][] => {
    const row: unknown[] = [s.id(st.intent), STATUS.indexOf(st.status as (typeof STATUS)[number]), Math.round(st.durationMs), st.evidence.map((x) => s.id(x)), depth];
    const extra: Record<string, unknown> = {};
    if (st.error) extra.e = s.id(st.error.message.slice(0, 2000));
    if (st.heal) extra.h = [st.heal.tier, Math.round(st.heal.confidence * 100), st.heal.verified ? 1 : 0, `${st.heal.healed.strategy}=${st.heal.healed.value}${st.heal.healed.name ? ` [${st.heal.healed.name}]` : ''}`];
    if (st.soft) extra.s = 1;
    if (Object.keys(extra).length) row.push(extra);
    return st.children?.length ? [row, ...compactSteps(st.children, s, depth + 1)] : [row];
  });
}

export function renderLargeHtmlReport(run: RunResult, opts: ReportInsights & { title?: string } = {}): string {
  const s = new Interner();
  const evidence = new Map((opts.evidence ?? []).map((r) => [r.id, r]));
  const triage = new Map((opts.triage?.verdicts ?? []).map((v) => [v.journeyId, v]));
  const flaky = new Map((opts.flaky ?? []).map((f) => [f.journeyId, f]));
  const journeys = run.journeys.map((j: JourneyResult) => [
    j.journeyId, j.name, STATUS.indexOf(j.status as (typeof STATUS)[number]), Math.round(j.durationMs), j.risk, j.attempt,
    j.tags.map((t) => s.id(t)), j.requirements.map((r) => s.id(r)), j.error ? s.id(j.error.message.slice(0, 2000)) : -1,
    triage.get(j.journeyId) ? s.id(`${triage.get(j.journeyId)!.category} (${Math.round(triage.get(j.journeyId)!.confidence * 100)}%): ${triage.get(j.journeyId)!.reasons[0] ?? ''}`) : -1,
    flaky.get(j.journeyId)?.state === 'flaky' ? 1 : 0,
    compactSteps(j.steps, s),
  ]);
  // Evidence: only what journeys reference, as id -> [kind, relative URL].
  const ev: Record<string, [string, string]> = {};
  for (const ref of evidence.values()) {
    const url = safeRelativeUrl(ref.path);
    if (url) ev[ref.id] = [ref.kind, url];
  }
  const data = { status: STATUS, labels: LABEL, strings: s.list, journeys, evidence: ev };

  const sum = run.summary;
  const title = opts.title ?? `EZTest report - ${run.runId}`;
  const r = opts.readiness;
  const failures = run.journeys.filter((j) => j.status === 'failed' || j.status === 'error');
  const byCategory = new Map<string, number>();
  for (const v of opts.triage?.verdicts ?? []) byCategory.set(v.category, (byCategory.get(v.category) ?? 0) + 1);
  const heals = run.journeys.reduce((n, j) => n + j.steps.filter((x) => x.heal).length, 0);
  const evidenceKinds = new Map<string, number>();
  for (const ref of opts.evidence ?? []) evidenceKinds.set(ref.kind, (evidenceKinds.get(ref.kind) ?? 0) + 1);

  const readiness = r
    ? `<section class="decision d-${e(r.decision)}" aria-labelledby="rd-h"><h2 id="rd-h">Release readiness: ${e(r.decision.replace(/_/g, ' '))} <small>(score ${e(r.score)}/100)</small></h2><ul>${r.rationale.slice(0, 60).map((it) => `<li><span class="badge">${e(it.kind)}</span> ${e(it.text)}</li>`).join('')}${r.rationale.length > 60 ? `<li>...and ${r.rationale.length - 60} more (see report.json)</li>` : ''}</ul></section>`
    : '';
  const failRows = failures.slice(0, 500).map((j) => `<tr><td><code>${e(j.journeyId)}</code></td><td>${e(j.name)}</td><td>${e(LABEL[j.status])}</td><td>${e(triage.get(j.journeyId)?.category ?? '')}</td><td>${e((j.error?.message ?? j.steps.find((x) => x.status === 'failed')?.error?.message ?? '').slice(0, 300))}</td></tr>`).join('');
  const failTable = failures.length
    ? `<table class="static"><caption>${e(failures.length)} failed or errored journeys${failures.length > 500 ? ' (first 500 shown; all are in the list below and in report.json)' : ''}</caption><thead><tr><th scope="col">Id</th><th scope="col">Journey</th><th scope="col">Status</th><th scope="col">Triage</th><th scope="col">Error</th></tr></thead><tbody>${failRows}</tbody></table>`
    : '<p>No failures.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${e(title)}</title><style>${CSS}</style></head>
<body><a class="skip" href="#list-h">Skip to journeys</a>
<header><h1>${e(title)}</h1>
<p class="meta">Started ${e(run.startedAt)} &middot; duration ${e((run.durationMs / 1000).toFixed(1))} s${Object.entries(run.environment).map(([k, v]) => ` &middot; ${e(k)}: ${e(v)}`).join('')}</p>
<ul class="summary" aria-label="Summary"><li><strong>${e(sum.total)}</strong>Total</li><li class="s-passed"><strong>${e(sum.passed)}</strong>Passed</li>
<li class="s-passed-healed"><strong>${e(sum.passedHealed)}</strong>Passed (healed)</li><li class="s-failed"><strong>${e(sum.failed + sum.errors)}</strong>Failed</li><li class="s-skipped"><strong>${e(sum.skipped)}</strong>Skipped</li></ul></header>
<main>${readiness}
<section aria-labelledby="tr-h"><h2 id="tr-h">Triage</h2>${byCategory.size ? `<ul class="cats">${[...byCategory].sort((a, b) => b[1] - a[1]).map(([c, n]) => `<li><strong>${e(n)}</strong> ${e(c)}</li>`).join('')}</ul>` : '<p>No failures to triage.</p>'}
${failTable}</section>
<section aria-labelledby="ov-h"><h2 id="ov-h">Heals and evidence</h2><p>${e(heals)} healed step(s) (see heal-proposals.json). ${e((opts.evidence ?? []).length)} evidence artifacts${run.evidenceHead ? `, manifest head <code>${e(run.evidenceHead.slice(0, 16))}</code>` : ''}: ${[...evidenceKinds].map(([k, n]) => `${e(n)} ${e(k)}`).join(', ')}.</p></section>
<section aria-labelledby="list-h" class="interactive"><h2 id="list-h">Journeys</h2>
<noscript><p>The journey list needs JavaScript; the failures above and report.json have the details.</p></noscript>
<div class="filters" role="group" aria-label="Filter journeys"><label>Status <select id="f-status"><option value="">All</option>${STATUS.map((x) => `<option value="${e(x)}">${e(LABEL[x])}</option>`).join('')}</select></label>
<label>Search <input type="search" id="f-q" placeholder="id, name, tag or requirement"></label> <span id="f-count" aria-live="polite"></span></div>
<div class="grid-head" aria-hidden="true"><span>Journey</span><span>Status</span><span>Duration</span><span>Risk</span><span>Triage</span></div>
<div id="vlist" class="vlist" role="list" aria-label="Journeys (scroll to load more)" tabindex="0"><div id="vspace"></div></div>
<section id="detail" class="detail" aria-live="polite" hidden></section></section>
</main>
<script type="application/json" id="ez-data">${scriptJson(data)}</script>
<script>${SCRIPT}</script></body></html>`;
}

const CSS = `:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--card:#f6f8fa;--pass:#1a7f37;--heal:#9a6700;--fail:#d1242f;--skip:#59636e;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--card:#151b23;--pass:#3fb950;--heal:#d29922;--fail:#f85149;--skip:#9198a1;--accent:#4493f8}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header,main{max-width:1280px;margin:0 auto;padding:12px 20px}h1{font-size:1.5rem;margin:.3em 0}h2{font-size:1.15rem;margin:1.2em 0 .4em}.meta{color:var(--muted);font-size:.85rem}
.skip{position:absolute;left:-999px}.skip:focus{left:8px;top:8px;background:var(--bg);padding:6px}
.summary,.cats{display:flex;gap:10px;list-style:none;padding:0;flex-wrap:wrap}.summary li,.cats li{border:1px solid var(--line);border-radius:8px;padding:8px 14px;background:var(--card)}
.summary strong{display:block;font-size:1.4rem}.s-passed strong{color:var(--pass)}.s-passed-healed strong{color:var(--heal)}.s-failed strong{color:var(--fail)}.s-skipped strong{color:var(--skip)}
.badge{border:1px solid var(--line);border-radius:10px;padding:0 6px;font-size:.75rem}.decision{border-left:4px solid var(--accent);padding:4px 12px;background:var(--card)}
.d-GO{border-color:var(--pass)}.d-GO_WITH_RISKS{border-color:var(--heal)}.d-NO_GO{border-color:var(--fail)}
table{border-collapse:collapse;width:100%}caption{text-align:left;color:var(--muted)}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.filters{display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin:8px 0}input,select{font:inherit;padding:4px 6px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px}
.grid-head,.row{display:grid;grid-template-columns:minmax(0,1fr) 130px 90px 50px minmax(0,.8fr);gap:8px;align-items:center}
.grid-head{font-weight:600;padding:4px 8px;border-bottom:2px solid var(--line)}
.vlist{position:relative;height:60vh;overflow-y:auto;border:1px solid var(--line);border-radius:6px}.vlist:focus-visible{outline:3px solid var(--accent)}
.row{position:absolute;left:0;right:0;height:32px;padding:0 8px;border-bottom:1px solid var(--line);cursor:pointer;background:var(--bg);color:inherit;border-width:0 0 1px 0;font:inherit;text-align:left}
.row:hover,.row:focus-visible{background:var(--card);outline:2px solid var(--accent);outline-offset:-2px}.row span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.st-passed{color:var(--pass)}.st-passed-healed{color:var(--heal)}.st-failed,.st-error,.st-blocked{color:var(--fail)}.st-skipped{color:var(--skip)}
.detail{margin-top:12px;border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--card)}.detail ol{padding-left:20px}.detail li{margin:4px 0}.err{color:var(--fail);white-space:pre-wrap}
.detail a{color:var(--accent);margin-right:6px}
@media print{.interactive,.skip{display:none}body{font-size:10pt;background:#fff;color:#000}.summary li,.cats li,.decision{background:#fff}tr{page-break-inside:avoid}header,main{max-width:none;padding:0}}`;

// Plain ES5 so it runs in any browser the report is opened in. Data is rendered with textContent only.
const SCRIPT = `(function(){
var D=JSON.parse(document.getElementById('ez-data').textContent);var S=D.strings,J=D.journeys,ST=D.status,L=D.labels,EV=D.evidence;
var list=document.getElementById('vlist'),space=document.getElementById('vspace'),det=document.getElementById('detail'),fs=document.getElementById('f-status'),fq=document.getElementById('f-q'),cnt=document.getElementById('f-count');
var H=32,view=[],pool={};
function el(t,c,txt){var x=document.createElement(t);if(c)x.className=c;if(txt!==undefined)x.textContent=txt;return x}
function dur(ms){return ms>=60000?(ms/60000).toFixed(1)+' min':(ms/1000).toFixed(1)+' s'}
function hay(j){var t=j[0]+' '+j[1];for(var i=0;i<j[6].length;i++)t+=' @'+S[j[6][i]];for(i=0;i<j[7].length;i++)t+=' '+S[j[7][i]];return t.toLowerCase()}
var HAY=J.map(hay);
function filter(){var s=fs.value,q=fq.value.trim().toLowerCase();view=[];for(var i=0;i<J.length;i++){if(s&&ST[J[i][2]]!==s)continue;if(q&&HAY[i].indexOf(q)<0)continue;view.push(i)}
space.style.height=(view.length*H)+'px';cnt.textContent=view.length+' of '+J.length+' journeys';for(var k in pool){pool[k].remove()}pool={};draw()}
function row(vi){var j=J[view[vi]];var b=el('button','row');b.type='button';b.setAttribute('role','listitem');b.style.top=(vi*H)+'px';
b.appendChild(el('span','',j[1]+' ('+j[0]+')'));var st=ST[j[2]];b.appendChild(el('span','st-'+st,L[st]+(j[10]?' / flaky':'')+(j[5]>1?' / attempt '+j[5]:'')));
b.appendChild(el('span','',dur(j[3])));b.appendChild(el('span','',String(j[4])));b.appendChild(el('span','',j[9]>=0?S[j[9]]:''));
b.addEventListener('click',function(){open(view[vi])});return b}
function draw(){var top=list.scrollTop,h=list.clientHeight||600;var a=Math.max(0,Math.floor(top/H)-10),z=Math.min(view.length,Math.ceil((top+h)/H)+10);
for(var k in pool){var n=+k;if(n<a||n>=z){pool[k].remove();delete pool[k]}}for(var i=a;i<z;i++){if(!pool[i]){pool[i]=row(i);list.appendChild(pool[i])}}}
function evLinks(ids,into){for(var i=0;i<ids.length;i++){var id=S[ids[i]],r=EV[id];if(!r){into.appendChild(el('span','',id+' '));continue}var a=el('a','',id+' '+r[0]);a.href=r[1];into.appendChild(a)}}
function open(i){var j=J[i];det.hidden=false;det.textContent='';det.appendChild(el('h3','',j[1]));
var m=el('p','',j[0]+' - '+L[ST[j[2]]]+' - '+dur(j[3])+' - risk '+j[4]+(j[6].length?' - tags '+j[6].map(function(t){return '@'+S[t]}).join(' '):'')+(j[7].length?' - requirements '+j[7].map(function(t){return S[t]}).join(', '):''));det.appendChild(m);
if(j[8]>=0)det.appendChild(el('p','err',S[j[8]]));if(j[9]>=0)det.appendChild(el('p','','Triage: '+S[j[9]]));
var ol=el('ol');var steps=j[11];for(var k=0;k<steps.length;k++){var s=steps[k],x=s[5]||{};var li=el('li');li.style.marginLeft=(s[4]*18)+'px';
li.appendChild(el('span','st-'+ST[s[1]],'['+L[ST[s[1]]]+'] '));li.appendChild(el('span','',S[s[0]]+' ('+s[2]+' ms) '));evLinks(s[3],li);
if(x.h){li.appendChild(el('div','','healed via '+x.h[0]+' ('+x.h[1]+'%, '+(x.h[2]?'verified':'NOT verified')+') -> '+x.h[3]))}if(x.e!==undefined)li.appendChild(el('div','err',S[x.e]));ol.appendChild(li)}
det.appendChild(ol);det.scrollIntoView({block:'nearest'})}
list.addEventListener('scroll',function(){window.requestAnimationFrame(draw)});fs.addEventListener('change',filter);fq.addEventListener('input',filter);
list.addEventListener('keydown',function(ev){if(ev.key==='PageDown'||ev.key==='PageUp'){/* native */}});
filter();
})();`;
