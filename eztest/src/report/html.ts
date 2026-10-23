/**
 * Single-file HTML report: no CDN, no external assets except relative links
 * to screenshots inside the run directory. Every dynamic value is escaped;
 * the inline script contains no data, it only toggles DOM state.
 */
import { apiCoverageHtml } from '../contracts/coverage.js';
import type { EvidenceRef, JourneyResult, RunResult, StepResult } from '../core/index.js';
import { EzTestError, flattenStepResults } from '../core/index.js';
import type { FlakyScore, TriageVerdict } from '../insights/index.js';
import { escapeHtml as e, safeRelativeUrl } from './escape.js';
import { healProposals, formatLocator, type ReportInsights } from './model.js';
import { bddHierarchy, type BddScenarioEntry } from './bdd.js';

const STATUS_LABEL: Record<string, string> = {
  passed: 'Passed',
  'passed-healed': 'Passed (healed)',
  failed: 'Failed',
  skipped: 'Skipped',
  error: 'Error',
  blocked: 'Blocked',
};

const badge = (status: string) => `<span class="badge s-${e(status)}">${e(STATUS_LABEL[status] ?? status)}</span>`;
const domId = (prefix: string, ...parts: string[]) => `${prefix}-${parts.map((p) => p.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)).join('--')}`;

function evLink(id: string, evMap: Map<string, EvidenceRef>): string {
  const ref = evMap.get(id);
  if (!ref) return `<span class="ev missing" title="not in evidence manifest">${e(id)}</span>`;
  const url = safeRelativeUrl(ref.path);
  const label = `${e(id)} <small>${e(ref.kind)}</small>`;
  return url ? `<a class="ev" href="${e(url)}" title="${e(ref.path)}">${label}</a>` : `<span class="ev" title="${e(ref.path)}">${label}</span>`;
}

const evList = (ids: string[], evMap: Map<string, EvidenceRef>) =>
  ids.length ? `<span class="evs">${ids.map((i) => evLink(i, evMap)).join(' ')}</span>` : '<span class="muted">none</span>';

function stepPanel(j: JourneyResult, s: StepResult, idx: number, evMap: Map<string, EvidenceRef>, selected: boolean, key = s.stepId, depth = 0): string {
  const pid = domId('panel', j.journeyId, key);
  const tid = domId('tab', j.journeyId, key);
  const shots = s.evidence.map((id) => evMap.get(id)).filter((r): r is EvidenceRef => !!r && r.kind === 'screenshot');
  const heal = s.heal
    ? `<div class="heal"><h5>Healed</h5>
<span class="badge healed">${e(s.heal.tier)}</span>
<span class="badge ${s.heal.verified ? 's-passed' : 's-failed'}">${s.heal.verified ? 'verified' : 'NOT verified'}</span>
<span>confidence ${e((s.heal.confidence * 100).toFixed(0))}%</span>
<p><code>${e(s.heal.original.map(formatLocator).join(' | '))}</code> &rarr; <code>${e(formatLocator(s.heal.healed))}</code></p>
<p>${e(s.heal.reason)}</p><p>Evidence: ${evList(s.heal.evidence, evMap)}</p></div>`
    : '';
  const conds = s.conditions.length
    ? `<table class="conds"><caption>Post-conditions</caption><thead><tr><th scope="col">Condition</th><th scope="col">Result</th><th scope="col">Actual</th></tr></thead><tbody>${s.conditions
        .map(
          (c) =>
            `<tr><td><code>${e(c.condition.type)}</code> ${e(JSON.stringify(c.condition).slice(0, 200))}</td><td>${c.passed ? '<span class="ok">held</span>' : '<span class="bad">failed</span>'}</td><td>${e(c.actual ?? c.message ?? '')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">No post-conditions.</p>';
  const images = shots
    .map((r) => {
      const url = safeRelativeUrl(r.path);
      return url
        ? `<figure><img src="${e(url)}" alt="${e(`Screenshot ${r.id} after step ${s.stepId}: ${s.intent}`)}" loading="lazy"><figcaption>${e(r.id)} ${e(r.description ?? '')}</figcaption></figure>`
        : '';
    })
    .join('');
  return `<div class="panel" role="tabpanel" id="${pid}" aria-labelledby="${tid}" tabindex="0"${selected ? '' : ' hidden'}>
<h4>Step ${idx + 1}: ${e(s.intent)} ${badge(s.status)}${depth ? ` <span class="muted">(nested level ${depth}${s.iteration ? `, iteration ${e(s.iteration)}` : ''}${s.branch && s.branch !== 'body' ? `, ${e(s.branch)} branch` : ''})</span>` : ''}</h4>
${s.warnings?.length ? `<ul class="warnings">${s.warnings.map((w) => `<li>${e(w)}</li>`).join('')}</ul>` : ''}
<p class="meta">id <code>${e(s.stepId)}</code>${s.actor ? ` &middot; as <strong class="actor">${e(s.actor)}</strong>` : ''} &middot; ${e(s.durationMs)} ms &middot; started ${e(s.startedAt)}${s.usedLocator ? ` &middot; locator <code>${e(formatLocator(s.usedLocator))}</code>` : ''}</p>
${heal}${conds}
${s.error ? `<div class="error" role="alert"><h5>${e(s.error.name ?? 'Error')}</h5><pre>${e(s.error.message)}</pre></div>` : ''}
${images || '<p class="muted">No screenshot for this step.</p>'}
<p>Evidence: ${evList(s.evidence, evMap)}</p></div>`;
}

function triageCard(v: TriageVerdict, evMap: Map<string, EvidenceRef>): string {
  return `<article class="card triage t-${e(v.category)}" aria-label="${e(`Triage for ${v.journeyName}`)}">
<h4>${e(v.journeyName)} <span class="badge cat">${e(v.category)}</span> <span class="badge ${v.status === 'decided' ? 's-passed' : 's-skipped'}">${e(v.status)}</span></h4>
<p>Confidence ${e((v.confidence * 100).toFixed(0))}%${v.stepId ? ` &middot; step <code>${e(v.stepId)}</code>` : ''}${v.signature ? ` &middot; signature <code>${e(v.signature)}</code>` : ''}</p>
<ul>${v.reasons.map((r) => `<li>${e(r)}</li>`).join('')}</ul>
<p>Evidence: ${evList(v.evidence, evMap)}</p></article>`;
}

/** The video player with per-step chapter navigation (G24): the WebM has burned-in overlays; the WebVTT track drives the chapter list. */
function videoPlayer(j: JourneyResult, evMap: Map<string, EvidenceRef>): string {
  const ids = j.evidence ?? [];
  const video = ids.map((id) => evMap.get(id)).find((r): r is EvidenceRef => !!r && r.kind === 'video');
  if (!video) return '';
  const vurl = safeRelativeUrl(video.path);
  if (!vurl) return '';
  const chapters = ids.map((id) => evMap.get(id)).find((r): r is EvidenceRef => !!r && r.kind === 'video-chapters');
  const curl = chapters ? safeRelativeUrl(chapters.path) : undefined;
  const pid = domId('video', j.journeyId);
  const track = curl ? `<track kind="chapters" default src="${e(curl)}" srclang="en" label="Steps">` : '';
  return `<details class="videobox"><summary>Video with step chapters</summary>
<div class="videowrap" id="${pid}"><video controls preload="metadata" playsinline crossorigin="anonymous" src="${e(vurl)}">${track}</video>
<ol class="chapters" aria-label="${e(`Steps in the video of ${j.name}`)}"></ol></div></details>`;
}

function journeySection(j: JourneyResult, evMap: Map<string, EvidenceRef>, flaky?: FlakyScore, triage?: TriageVerdict): string {
  const sid = domId('j', j.journeyId);
  // Block steps (if/loops/try/frame blocks/sub-journeys) list their children indented beneath them.
  const flat = flattenStepResults(j.steps);
  const keyOf = (s: StepResult, i: number) => (flat.length === j.steps.length ? s.stepId : `${s.stepId}-${i}`);
  const firstBad = Math.max(0, flat.findIndex(({ result: s }) => (s.status === 'failed' && !s.children?.length) || s.status === 'blocked' || (s.status === 'passed-healed' && !s.children?.length)));
  const tabs = flat
    .map(({ result: s, depth }, i) => {
      const tid = domId('tab', j.journeyId, keyOf(s, i));
      const pid = domId('panel', j.journeyId, keyOf(s, i));
      const nest = depth ? ` style="margin-left:${depth * 1.2}rem" data-depth="${depth}"` : '';
      const iter = s.iteration ? ` <span class="badge" title="iteration">#${e(s.iteration)}</span>` : '';
      const actor = s.actor ? ` <span class="badge actor" title="actor">${e(s.actor)}</span>` : '';
      return `<li role="presentation"${nest}><button type="button" role="tab" id="${tid}" aria-controls="${pid}" aria-selected="${i === firstBad}" tabindex="${i === firstBad ? 0 : -1}" class="step s-${e(s.status)}"><span class="num">${i + 1}</span> ${e(s.intent)}${iter}${actor} ${badge(s.status)}${s.heal ? ' <span class="badge healed" title="healed">&#x2695;</span>' : ''}</button></li>`;
    })
    .join('');
  const flakyBadge = flaky && flaky.state !== 'stable' ? ` <span class="badge flaky f-${e(flaky.state)}" title="${e(flaky.reasons.join('; '))}">${e(flaky.state)}</span>` : '';
  return `<section class="journey" id="${sid}" data-status="${e(j.status)}" data-name="${e(`${j.name} ${j.journeyId} ${j.tags.join(' ')}`.toLowerCase())}" aria-labelledby="${sid}-h">
<details${j.status === 'failed' || j.status === 'error' ? ' open' : ''}><summary><h3 id="${sid}-h">${badge(j.status)} ${e(j.name)}${flakyBadge}</h3>
<span class="meta">${e(j.journeyId)}${j.browser ? ` &middot; ${e(j.browser)}` : ''} &middot; ${e((j.durationMs / 1000).toFixed(2))} s &middot; risk ${e(j.risk)} &middot; attempt ${e(j.attempt)}${j.tags.length ? ` &middot; ${j.tags.map((t) => `<span class="tag">${e(t)}</span>`).join(' ')}` : ''}</span></summary>
${j.error ? `<div class="error" role="alert"><pre>${e(j.error.message)}</pre></div>` : ''}
${triage ? triageCard(triage, evMap) : ''}
${videoPlayer(j, evMap)}
<div class="viewer"><ol class="steps" role="tablist" aria-label="${e(`Steps of ${j.name}`)}" aria-orientation="vertical">${tabs}</ol>
<div class="panels">${flat.map(({ result: s, depth }, i) => stepPanel(j, s, i, evMap, i === firstBad, keyOf(s, i), depth)).join('')}</div></div>
</details></section>`;
}

const MATCH_LABEL: Record<string, string> = { definition: 'step definition', ez: 'EZTest phrasing', undefined: 'undefined', ambiguous: 'ambiguous' };

function bddScenario(sc: BddScenarioEntry): string {
  const steps = sc.steps.map((st) => `<li class="g-step s-${e(st.status)}">${badge(st.status)} <span class="g-kw">${e(st.keyword)}</span> ${e(st.text)}${st.match ? ` <small class="muted" title="${e(st.location ?? '')}">${e(MATCH_LABEL[st.match] ?? st.match)}${st.location ? ` &middot; ${e(st.location)}` : ''}</small>` : ''}${st.error ? `<div class="g-err">${e(st.error)}</div>` : ''}</li>`).join('');
  const hooks = sc.hookFailures.map((h) => `<li class="g-step s-failed">${badge('failed')} ${e(h)}</li>`).join('');
  return `<li class="g-scenario"><details${sc.status === 'failed' || sc.status === 'error' ? ' open' : ''}><summary>${badge(sc.status)} <span class="g-kw">${e(sc.keyword)}:</span> <a href="#${domId('j', sc.journeyId)}">${e(sc.name)}</a> <small class="muted">line ${e(sc.line)}${sc.examples ? ` &middot; ${e(sc.examples.name || 'Examples')} row ${e((sc.examples.row?.index ?? 0) + 1)}` : ''} &middot; ${e((sc.durationMs / 1000).toFixed(2))} s</small></summary><ol class="g-steps">${steps}${hooks}</ol></details></li>`;
}

/** Feature / rule / scenario hierarchy of the run's Gherkin scenarios (docs/bdd.md). */
function featuresSection(run: RunResult): string {
  const h = bddHierarchy(run);
  if (!h) return '';
  const t = h.totals;
  const features = h.features.map((f) => {
    const c = f.counts;
    const rules = f.rules.map((r) => `<li class="g-rule"><details open><summary>${badge(r.status)} <span class="g-kw">Rule:</span> ${e(r.name)} <small class="muted">line ${e(r.line)}</small></summary><ul class="g-scenarios">${r.scenarios.map(bddScenario).join('')}</ul></details></li>`).join('');
    return `<li class="g-feature"><details${f.status === 'failed' || f.status === 'error' ? ' open' : ''}><summary>${badge(f.status)} <strong>${e(f.name || f.file)}</strong> <small class="muted">${e(f.file)} &middot; ${e(c.passed + c.passedHealed)} passed, ${e(c.failed + c.errors)} failed, ${e(c.skipped)} skipped</small></summary>
<ul class="g-scenarios">${f.scenarios.map(bddScenario).join('')}${rules}</ul></details></li>`;
  }).join('');
  return `<section aria-labelledby="features-h"><h2 id="features-h">Features</h2>
<p class="meta">${e(t.features)} feature(s), ${e(t.rules)} rule(s), ${e(t.scenarios)} scenario(s), ${e(t.steps)} step(s): ${e(t.passed + t.passedHealed)} passed, ${e(t.failed + t.errors)} failed, ${e(t.skipped)} skipped</p>
<ul class="g-features">${features}</ul></section>`;
}

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--card:#f6f8fa;--border:#d0d7de;--field:#6e7781;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--heal:#8250df;--link:#0969da;--focus:#0969da}
@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--card:#161b22;--border:#30363d;--field:#6e7681;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--heal:#a371f7;--link:#4493f8;--focus:#4493f8}}
:root[data-theme=dark]{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--card:#161b22;--border:#30363d;--field:#6e7681;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--heal:#a371f7;--link:#4493f8;--focus:#4493f8}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header,main{max-width:80rem;margin:0 auto;padding:1rem}a{color:var(--link)}:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;background:var(--bg);padding:.5rem;z-index:9}
.top{display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
.summary{display:flex;gap:.75rem;flex-wrap:wrap;list-style:none;padding:0}.summary li{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:.5rem 1rem;min-width:8rem}
.summary strong{display:block;font-size:1.6rem}
.badge{display:inline-block;border-radius:1rem;padding:0 .5rem;font-size:.8rem;font-weight:600;border:1px solid currentColor;vertical-align:middle}
.s-passed{color:var(--ok)}.s-passed-healed,.healed{color:var(--heal)}.s-failed,.s-error,.s-blocked{color:var(--bad)}.s-skipped{color:var(--muted)}.flaky,.cat{color:var(--warn)}
.decision{border-radius:8px;padding:1rem;border:2px solid var(--border);margin:1rem 0}.d-GO{border-color:var(--ok)}.d-GO_WITH_RISKS{border-color:var(--warn)}.d-NO_GO{border-color:var(--bad)}
.filters{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin:1rem 0}
.filters button,.theme{background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:.3rem .7rem;cursor:pointer}
.filters button[aria-pressed=true]{border-color:var(--link);font-weight:600}
input[type=search]{background:var(--bg);color:var(--fg);border:1px solid var(--field);border-radius:6px;padding:.3rem .6rem}
.journey{border:1px solid var(--border);border-radius:8px;margin:.75rem 0;background:var(--card)}
.journey summary{cursor:pointer;padding:.5rem 1rem}.journey summary h3{display:inline;font-size:1.05rem;margin:0}
.meta,.muted{color:var(--muted)}.tag{font-family:monospace}
.viewer{display:grid;grid-template-columns:minmax(14rem,22rem) 1fr;gap:1rem;padding:0 1rem 1rem}
@media (max-width:50rem){.viewer{grid-template-columns:1fr}}
.steps{list-style:none;margin:0;padding:0}.steps button{width:100%;text-align:left;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-left:4px solid currentColor;border-radius:6px;padding:.4rem;margin:.2rem 0;cursor:pointer}
.steps button[aria-selected=true]{outline:2px solid var(--link)}.steps .num{font-weight:700}
.panel{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.75rem}
.panel img{max-width:100%;border:1px solid var(--border)}figure{margin:.5rem 0}
.error{border-left:4px solid var(--bad);padding:.25rem .75rem;background:var(--bg)}pre{white-space:pre-wrap;word-break:break-word}
.heal{border-left:4px solid var(--heal);padding:.25rem .75rem;margin:.5rem 0}
.ok{color:var(--ok)}.bad{color:var(--bad)}table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--border);padding:.25rem .5rem;text-align:left;vertical-align:top}
caption{text-align:left;font-weight:600}.card{border:1px solid var(--border);border-radius:8px;padding:.5rem 1rem;margin:.5rem 0;background:var(--bg)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(22rem,1fr));gap:.75rem}.ev{font-family:monospace;margin-right:.3rem}.ev.missing{color:var(--bad);text-decoration:line-through}
.actor{color:var(--link)}
.videobox{margin:.5rem 1rem}.videobox summary{cursor:pointer;font-weight:600}
.videowrap{display:grid;grid-template-columns:minmax(0,2fr) minmax(10rem,1fr);gap:.75rem;margin-top:.5rem}@media (max-width:50rem){.videowrap{grid-template-columns:1fr}}
.videowrap video{width:100%;border:1px solid var(--border);border-radius:6px;background:#000}
.chapters{list-style:none;margin:0;padding:0;max-height:20rem;overflow:auto}
.chapters button{width:100%;text-align:left;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:.3rem .5rem;margin:.15rem 0;cursor:pointer}
.chapters button[aria-current=true]{border-color:var(--link);font-weight:600}
.g-features,.g-scenarios,.g-steps{list-style:none;padding-left:1.1rem;margin:.2rem 0}.g-features{padding-left:0}.g-kw{font-weight:600}.g-step{margin:.15rem 0}.g-err{color:var(--bad);margin-left:2rem;white-space:pre-wrap}.g-feature>details>summary,.g-rule>details>summary,.g-scenario>details>summary{cursor:pointer;padding:.15rem 0}
`;

/** The journey of a cross-browser unit ("checkout@firefox" -> "checkout"). */
function unitJourney(j: JourneyResult): string {
  return j.browser && j.journeyId.endsWith(`@${j.browser}`) ? j.journeyId.slice(0, -(j.browser.length + 1)) : j.journeyId;
}

/** Cross-browser runs: per-browser summaries (and readiness), and a journey x browser status grid. */
function browsersSection(run: RunResult, readiness: ReportInsights['readiness']): string {
  const per = run.browsers;
  if (!per || Object.keys(per).length < 2) return '';
  const names = Object.keys(per);
  const rows = names.map((b) => {
    const x = per[b];
    const rb = readiness?.browsers?.[b];
    return `<tr><th scope="row">${e(b)}</th><td>${e(x.version ?? '')}</td><td>${e(x.total)}</td><td class="ok">${e(x.passed + x.passedHealed)}</td><td class="bad">${e(x.failed + x.errors)}</td><td>${e(x.skipped)}</td>${readiness ? `<td>${rb ? `<span class="badge">${e(rb.decision.replace(/_/g, ' '))}</span> ${e(rb.score)}` : ''}</td>` : ''}</tr>`;
  }).join('');
  const units = run.journeys.filter((j) => j.browser && names.includes(j.browser) && !j.tags.includes('hook'));
  const ids = [...new Set(units.map(unitJourney))];
  const grid = ids.map((id) => {
    const cells = names.map((b) => {
      const u = units.find((j) => j.browser === b && unitJourney(j) === id);
      return `<td>${u ? `<a href="#${domId('j', u.journeyId)}">${badge(u.status)}</a>` : '<span class="muted">-</span>'}</td>`;
    }).join('');
    const statuses = names.map((b) => units.find((j) => j.browser === b && unitJourney(j) === id)?.status).filter(Boolean);
    const ok = (st?: string) => st === 'passed' || st === 'passed-healed';
    const only = statuses.some(ok) && statuses.some((st) => !ok(st) && st !== 'skipped')
      ? names.filter((b) => { const st = units.find((j) => j.browser === b && unitJourney(j) === id)?.status; return st && !ok(st) && st !== 'skipped'; })
      : [];
    return `<tr><th scope="row">${e(id)}</th>${cells}<td>${only.length ? `<span class="bad">fails on ${e(only.join(', '))} only</span>` : ''}</td></tr>`;
  }).join('');
  return `<section aria-labelledby="browsers-h"><h2 id="browsers-h">Browsers</h2>
<table><caption>Per browser (the summary above is all browsers combined)</caption><thead><tr><th scope="col">Browser</th><th scope="col">Version</th><th scope="col">Units</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Skipped</th>${readiness ? '<th scope="col">Readiness</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
<table><caption>Journey x browser</caption><thead><tr><th scope="col">Journey</th>${names.map((b) => `<th scope="col">${e(b)}</th>`).join('')}<th scope="col">Browser-specific</th></tr></thead><tbody>${grid}</tbody></table></section>`;
}

const SCRIPT = `
(function(){
var root=document.documentElement,tb=document.getElementById('theme-toggle');
function setTheme(t){root.setAttribute('data-theme',t);tb.setAttribute('aria-pressed',String(t==='dark'));tb.textContent=t==='dark'?'Light mode':'Dark mode';try{localStorage.setItem('ez-theme',t)}catch(_){}}
var saved=null;try{saved=localStorage.getItem('ez-theme')}catch(_){}
var dark=saved?saved==='dark':(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);
setTheme(dark?'dark':'light');
tb.addEventListener('click',function(){setTheme(root.getAttribute('data-theme')==='dark'?'light':'dark')});
var status='all',q=document.getElementById('search');
function apply(){var n=0;document.querySelectorAll('.journey').forEach(function(s){var ok=(status==='all'||s.dataset.status===status)&&(!q.value||s.dataset.name.indexOf(q.value.toLowerCase())>=0);s.hidden=!ok;if(ok)n++});document.getElementById('shown').textContent=n+' shown'}
document.querySelectorAll('[data-filter]').forEach(function(b){b.addEventListener('click',function(){status=b.getAttribute('data-filter');document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))});apply()})});
q.addEventListener('input',apply);apply();
document.querySelectorAll('[role=tablist]').forEach(function(list){
var tabs=Array.prototype.slice.call(list.querySelectorAll('[role=tab]'));
function select(t,focus){tabs.forEach(function(x){var on=x===t;x.setAttribute('aria-selected',String(on));x.tabIndex=on?0:-1;var p=document.getElementById(x.getAttribute('aria-controls'));if(p)p.hidden=!on});if(focus)t.focus()}
tabs.forEach(function(t,i){t.addEventListener('click',function(){select(t,false)});t.addEventListener('keydown',function(ev){var k=ev.key,j=-1;if(k==='ArrowDown'||k==='ArrowRight')j=(i+1)%tabs.length;else if(k==='ArrowUp'||k==='ArrowLeft')j=(i-1+tabs.length)%tabs.length;else if(k==='Home')j=0;else if(k==='End')j=tabs.length-1;if(j>=0){ev.preventDefault();select(tabs[j],true)}})});
});
// Video chapters: build a clickable step list from the WebVTT chapters track; clicking seeks the video to that step.
document.querySelectorAll('.videowrap').forEach(function(wrap){
  var video=wrap.querySelector('video'),list=wrap.querySelector('.chapters');
  if(!video||!list)return;
  function build(){
    var tt=null,i;for(i=0;i<video.textTracks.length;i++){if(video.textTracks[i].kind==='chapters'){tt=video.textTracks[i];break}}
    if(!tt)return;tt.mode='hidden';var cues=tt.cues;if(!cues||!cues.length){return}
    list.textContent='';for(i=0;i<cues.length;i++){(function(cue,n){
      var li=document.createElement('li');var b=document.createElement('button');b.type='button';
      b.textContent=(n+1)+'. '+cue.text;b.setAttribute('data-start',cue.startTime);
      b.addEventListener('click',function(){video.currentTime=cue.startTime+0.001;video.play().catch(function(){})});
      li.appendChild(b);list.appendChild(li);
    })(cues[i],i)}
    video.addEventListener('timeupdate',function(){var t=video.currentTime,btns=list.querySelectorAll('button'),k;for(k=0;k<cues.length;k++){var on=t>=cues[k].startTime&&t<cues[k].endTime;if(btns[k])btns[k].setAttribute('aria-current',String(on))}});
  }
  var track=video.querySelector('track');
  if(track){if(track.readyState===2)build();else track.addEventListener('load',build);}
  video.addEventListener('loadedmetadata',function(){setTimeout(build,50)});
});
})();
`;

export interface HtmlReportOptions extends ReportInsights {
  title?: string;
}

export function renderHtmlReport(run: RunResult, opts: HtmlReportOptions = {}): string {
  if (!run || !Array.isArray(run.journeys)) throw new EzTestError('renderHtmlReport requires a RunResult', 'INVALID_INPUT');
  if (run.journeys.length === 0) throw new EzTestError('renderHtmlReport: run has no journeys', 'INVALID_INPUT');
  const evMap = new Map((opts.evidence ?? []).map((r) => [r.id, r]));
  const flakyMap = new Map((opts.flaky ?? []).map((f) => [f.journeyId, f]));
  const triageMap = new Map((opts.triage?.verdicts ?? []).map((v) => [v.journeyId, v]));
  const s = run.summary;
  const title = opts.title ?? `EZTest report - ${run.runId}`;
  const r = opts.readiness;
  const readiness = r
    ? `<section class="decision d-${e(r.decision)}" aria-labelledby="readiness-h"><h2 id="readiness-h">Release readiness: ${e(r.decision.replace(/_/g, ' '))} <small>(score ${e(r.score)}/100)</small></h2>
<ul>${r.rationale
        .map((it) => {
          const c = [
            ...it.cites.journeys.map((j) => `<a href="#${domId('j', j)}">${e(j)}</a>`),
            ...it.cites.requirements.map((q) => `<code>${e(q)}</code>`),
            ...it.cites.evidence.map((id) => evLink(id, evMap)),
          ];
          return `<li><span class="badge">${e(it.kind)}</span> ${e(it.text)}${c.length ? ` <span class="cites">[${c.join(', ')}]</span>` : ''}</li>`;
        })
        .join('')}</ul>
${r.exceptionsApplied.length ? `<p>Exceptions: ${r.exceptionsApplied.map((x) => `${e(x.gate)} approved by <strong>${e(x.approver)}</strong> (${e(x.reason)})`).join('; ')}</p>` : ''}</section>`
    : '';
  const proposals = healProposals(run);
  const healSection = proposals.length
    ? `<section aria-labelledby="heal-h"><h2 id="heal-h">Heal proposals</h2><table><thead><tr><th scope="col">Journey / step</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Tier</th><th scope="col">Confidence</th><th scope="col">Verified</th><th scope="col">Recommendation</th><th scope="col">Evidence</th></tr></thead><tbody>${proposals
        .map(
          (p) =>
            `<tr><td><a href="#${domId('j', p.journeyId)}">${e(p.journeyName)}</a> / <code>${e(p.stepId)}</code></td><td><code>${e(p.from.join(' | '))}</code></td><td><code>${e(p.to)}</code></td><td>${e(p.tier)}</td><td>${e((p.confidence * 100).toFixed(0))}%</td><td>${p.verified ? '<span class="ok">yes</span>' : '<span class="bad">no</span>'}</td><td>${e(p.recommendation)}</td><td>${evList(p.evidence, evMap)}</td></tr>`,
        )
        .join('')}</tbody></table></section>`
    : '';
  const triageSection = opts.triage?.verdicts.length
    ? `<section aria-labelledby="triage-h"><h2 id="triage-h">Triage</h2><div class="cards">${opts.triage.verdicts.map((v) => triageCard(v, evMap)).join('')}</div></section>`
    : '';
  const filterBtn = (key: string, label: string, n?: number) =>
    `<button type="button" data-filter="${e(key)}" aria-pressed="${key === 'all'}">${e(label)}${n !== undefined ? ` (${e(n)})` : ''}</button>`;
  const evidenceSection = opts.evidence?.length
    ? `<section aria-labelledby="ev-h"><h2 id="ev-h">Evidence</h2><details><summary>${e(opts.evidence.length)} artifacts${run.evidenceHead ? ` &middot; manifest head <code>${e(run.evidenceHead.slice(0, 16))}</code>` : ''}</summary><table><thead><tr><th scope="col">Id</th><th scope="col">Kind</th><th scope="col">Journey / step</th><th scope="col">SHA-256</th></tr></thead><tbody>${opts.evidence
        .map((x) => `<tr><td>${evLink(x.id, evMap)}</td><td>${e(x.kind)}</td><td>${e(x.journeyId ?? '')} ${e(x.stepId ?? '')}</td><td><code>${e(x.sha256.slice(0, 16))}</code></td></tr>`)
        .join('')}</tbody></table></details></section>`
    : '';

  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; media-src 'self' file: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${e(title)}</title><style>${CSS}</style></head>
<body><a class="skip" href="#main">Skip to results</a>
<header><div class="top"><h1>${e(title)}</h1><button type="button" class="theme" id="theme-toggle" aria-pressed="false">Dark mode</button></div>
<p class="meta">Started ${e(run.startedAt)} &middot; duration ${e((run.durationMs / 1000).toFixed(1))} s${Object.entries(run.environment)
    .map(([k, v]) => ` &middot; ${e(k)}: ${e(v)}`)
    .join('')}</p>
<ul class="summary" aria-label="Summary">
<li><strong>${e(s.total)}</strong>Total</li><li class="s-passed"><strong>${e(s.passed)}</strong>Passed</li>
<li class="s-passed-healed"><strong>${e(s.passedHealed)}</strong>Passed (healed)</li><li class="s-failed"><strong>${e(s.failed + s.errors)}</strong>Failed</li>
<li class="s-skipped"><strong>${e(s.skipped)}</strong>Skipped</li></ul></header>
<main id="main">${readiness}${browsersSection(run, r)}${triageSection}
${featuresSection(run)}
<section aria-labelledby="journeys-h"><h2 id="journeys-h">Journeys</h2>
<div class="filters" role="group" aria-label="Filter journeys">${filterBtn('all', 'All', s.total)}${filterBtn('passed', 'Passed', s.passed)}${filterBtn('passed-healed', 'Healed', s.passedHealed)}${filterBtn('failed', 'Failed', s.failed)}${filterBtn('error', 'Error', s.errors)}${filterBtn('skipped', 'Skipped', s.skipped)}
<label>Search <input type="search" id="search" aria-label="Search journeys by name, id or tag"></label> <span id="shown" aria-live="polite"></span></div>
${run.journeys.map((j) => journeySection(j, evMap, flakyMap.get(j.journeyId), triageMap.get(j.journeyId))).join('\n')}
</section>${(opts.apiCoverage ?? []).map(apiCoverageHtml).join('')}${healSection}${evidenceSection}</main>
<script>${SCRIPT}</script></body></html>`;
}
