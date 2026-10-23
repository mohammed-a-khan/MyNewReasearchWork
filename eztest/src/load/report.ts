/**
 * The load test report: one self-contained HTML file (inline SVG charts,
 * no scripts, light and dark themes) with the verdict, SLAs, the timeline
 * of load, throughput, response times, errors and every monitor, the
 * per-transaction table, errors, analysis findings and the baseline
 * comparison.
 */
import type { LoadResults } from './run.js';
import type { TimelinePoint } from './metrics.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : n >= 100 ? Math.round(n).toLocaleString('en') : n.toFixed(d));
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

interface Series {
  label: string;
  values: Array<number | null>;
  cls: string;
}

/** A line chart over the test's seconds (inline SVG). */
export function svgChart(title: string, seconds: number[], series: Series[], o: { unit?: string; height?: number; marks?: Array<{ t: number; label: string }> } = {}): string {
  const W = 900;
  const H = o.height ?? 180;
  const padL = 56;
  const padB = 22;
  const padT = 10;
  const max = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => typeof v === 'number'))) * 1.08;
  const tMax = Math.max(1, ...seconds);
  const x = (t: number) => padL + (t / tMax) * (W - padL - 10);
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const paths = series.map((s) => {
    let d = '';
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      d += `${d && s.values[i - 1] !== null && s.values[i - 1] !== undefined ? 'L' : 'M'}${x(seconds[i]).toFixed(1)},${y(v).toFixed(1)}`;
    });
    return `<path class="s ${s.cls}" d="${d}"><title>${esc(s.label)}</title></path>`;
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<line class="grid" x1="${padL}" x2="${W - 10}" y1="${y(max * f)}" y2="${y(max * f)}"/><text class="tick" x="${padL - 6}" y="${y(max * f) + 4}" text-anchor="end">${fmt(max * f, 0)}${o.unit ?? ''}</text>`);
  const xt = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text class="tick" x="${x(tMax * f)}" y="${H - 6}" text-anchor="middle">${Math.round(tMax * f)}s</text>`);
  const marks = (o.marks ?? []).map((m) => `<line class="mark" x1="${x(m.t)}" x2="${x(m.t)}" y1="${padT}" y2="${H - padB}"><title>${esc(m.label)}</title></line>`);
  const legend = series.map((s) => `<span class="lg"><i class="sw ${s.cls}"></i>${esc(s.label)}</span>`).join('');
  const summary = `${title}: ${series.map((s) => `${s.label} max ${fmt(Math.max(0, ...s.values.filter((v): v is number => typeof v === 'number')))}${o.unit ?? ''}`).join(', ')}`;
  return `<figure class="chart"><figcaption>${esc(title)} <span class="legend">${legend}</span></figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}" preserveAspectRatio="none">${ticks.join('')}${xt.join('')}${marks.join('')}${paths.join('')}</svg></figure>`;
}

function timelineCharts(tl: TimelinePoint[], r: LoadResults): string {
  const secs = tl.map((p) => p.t);
  const marks = r.liveSla.filter((e) => e.to === 'fail').slice(0, 20).map((e) => ({ t: e.t, label: `SLA ${e.sla} ${e.metric} failed (${e.name})` }));
  const out = [
    svgChart('Active virtual users', secs, [{ label: 'VUs', values: tl.map((p) => p.vus), cls: 'c1' }], { marks }),
    svgChart('Throughput', secs, [{ label: 'requests/s', values: tl.map((p) => p.rps), cls: 'c2' }, { label: 'iterations/s', values: tl.map((p) => p.iterations), cls: 'c3' }], { marks }),
    svgChart('Response time (all requests)', secs, [
      { label: 'p50', values: tl.map((p) => p.latency?.p50 ?? null), cls: 'c1' },
      { label: 'p90', values: tl.map((p) => p.latency?.p90 ?? null), cls: 'c2' },
      { label: 'p95', values: tl.map((p) => p.latency?.p95 ?? null), cls: 'c3' },
      { label: 'p99', values: tl.map((p) => p.latency?.p99 ?? null), cls: 'c4' },
    ], { unit: ' ms', marks }),
    svgChart('Errors', secs, [{ label: 'errors/s', values: tl.map((p) => p.errors), cls: 'c5' }], { marks }),
  ];
  for (const m of r.monitors) {
    if (!m.points.length) continue;
    const keys = [...new Set(m.points.flatMap((p) => Object.keys(p.values)))].filter((k) => !/count$|^cpus$|^status$/.test(k)).slice(0, 6);
    const byT = new Map(m.points.map((p) => [p.t, p.values]));
    out.push(svgChart(`Monitor: ${m.name}`, secs, keys.map((k, i) => ({ label: k, values: secs.map((t) => byT.get(t)?.[k] ?? null), cls: `c${(i % 5) + 1}` })), { marks }));
  }
  return out.join('');
}

export function renderLoadReport(r: LoadResults, o: { title?: string } = {}): string {
  const t = r.totals;
  const verdictCls = r.verdict === 'pass' ? 'ok' : r.verdict === 'warn' ? 'warn' : 'bad';
  const rows = r.names.filter((n) => n.kind !== 'iteration');
  const nameTable = `<table><caption>Transactions and requests</caption><thead><tr><th scope="col">Kind</th><th scope="col">Name</th><th scope="col" class="n">Count</th><th scope="col" class="n">Errors</th><th scope="col" class="n">Avg</th><th scope="col" class="n">p50</th><th scope="col" class="n">p90</th><th scope="col" class="n">p95</th><th scope="col" class="n">p99</th><th scope="col" class="n">Max</th><th scope="col" class="n">/s</th></tr></thead><tbody>${rows
    .map((n) => `<tr><td>${esc(n.kind)}</td><td>${esc(n.name)}</td><td class="n">${n.count}</td><td class="n${n.errors ? ' bad' : ''}">${n.errors} (${pct(n.errorRate)})</td><td class="n">${fmt(n.latency.mean)}</td><td class="n">${fmt(n.latency.p50)}</td><td class="n">${fmt(n.latency.p90)}</td><td class="n">${fmt(n.latency.p95)}</td><td class="n">${fmt(n.latency.p99)}</td><td class="n">${fmt(n.latency.max)}</td><td class="n">${fmt(n.throughput, 2)}</td></tr>`)
    .join('')}</tbody></table>`;
  const slaTable = r.sla.items.length
    ? `<table><caption>SLAs</caption><thead><tr><th scope="col">SLA</th><th scope="col">Name</th><th scope="col">Metric</th><th scope="col" class="n">Value</th><th scope="col" class="n">Warn</th><th scope="col" class="n">Fail</th><th scope="col">Status</th></tr></thead><tbody>${r.sla.items
        .map((i) => `<tr><td>${esc(i.sla)}</td><td>${esc(i.name)}</td><td>${esc(i.metric)}</td><td class="n">${i.value === null ? '–' : i.unit === 'ratio' ? pct(i.value) : fmt(i.value, 2)}</td><td class="n">${i.warn ?? '–'}</td><td class="n">${i.fail ?? '–'}</td><td><span class="pill ${i.status === 'pass' ? 'ok' : i.status === 'warn' ? 'warn' : 'bad'}">${esc(i.status)}</span></td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="muted">No SLAs defined.</p>';
  const findings = r.analysis.findings.length
    ? `<ul class="findings">${r.analysis.findings.map((f) => `<li class="sev-${f.severity}"><strong>${esc(f.title)}</strong> ${esc(f.detail)}</li>`).join('')}</ul>`
    : '<p class="muted">No bottleneck, saturation or error pattern found.</p>';
  const errorRows = Object.entries(r.errors.byType).sort((a, b) => b[1] - a[1]);
  const errorsHtml = errorRows.length
    ? `<table><caption>Errors by type</caption><thead><tr><th scope="col">Type</th><th scope="col" class="n">Count</th></tr></thead><tbody>${errorRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('')}</tbody></table>${r.errors.samples.length ? `<details><summary>First ${r.errors.samples.length} error samples</summary><ul class="samples">${r.errors.samples.map((s) => `<li><code>${esc(s.type)}</code> ${esc(s.name)}: ${esc(s.message)}${s.url ? ` <span class="muted">${esc(s.url)}</span>` : ''}</li>`).join('')}</ul></details>` : ''}`
    : '<p class="muted">No errors.</p>';
  const cmp = r.comparison
    ? `<section><h2>Comparison with baseline ${esc(r.comparison.baselineRunId)}</h2><p>${r.comparison.regressions} regression(s), ${r.comparison.improvements} improvement(s).</p><table><caption>Baseline comparison</caption><thead><tr><th scope="col">Name</th><th scope="col" class="n">p95 before</th><th scope="col" class="n">p95 now</th><th scope="col" class="n">Change</th><th scope="col">Verdict</th><th scope="col">Why</th></tr></thead><tbody>${r.comparison.rows
        .map((x) => `<tr><td>${esc(x.name)}</td><td class="n">${fmt(x.baseline?.p95)}</td><td class="n">${fmt(x.current?.p95)}</td><td class="n">${x.p95ChangePct === undefined ? '–' : `${x.p95ChangePct > 0 ? '+' : ''}${Math.round(x.p95ChangePct * 100)}%`}</td><td><span class="pill ${x.verdict === 'regression' ? 'bad' : x.verdict === 'improvement' ? 'ok' : ''}">${esc(x.verdict)}</span></td><td>${esc(x.reasons.join('; '))}</td></tr>`)
        .join('')}</tbody></table></section>`
    : '';
  const topSql = r.monitors.filter((m) => m.topSql?.length).map((m) => `<table><caption>Top SQL: ${esc(m.name)}</caption><thead><tr><th scope="col">SQL</th><th scope="col" class="n">Executions</th><th scope="col" class="n">Total ms</th><th scope="col" class="n">Avg ms</th></tr></thead><tbody>${m.topSql!.map((q) => `<tr><td><code>${esc(q.sql)}</code></td><td class="n">${q.executions}</td><td class="n">${fmt(q.totalMs)}</td><td class="n">${fmt(q.avgMs, 2)}</td></tr>`).join('')}</tbody></table>`).join('');
  const agents = r.agents.length ? `<table><caption>Load generators</caption><thead><tr><th scope="col">Agent</th><th scope="col">Host</th><th scope="col">Zone</th><th scope="col" class="n">Peak VUs</th><th scope="col" class="n">Requests</th><th scope="col" class="n">Errors</th><th scope="col" class="n">req/s</th></tr></thead><tbody>${r.agents.map((a) => `<tr><td>${esc(a.id)}</td><td>${esc(a.host)}</td><td>${esc(a.zone ?? '')}</td><td class="n">${a.vus}</td><td class="n">${a.requests}</td><td class="n">${a.errors}</td><td class="n">${fmt(a.rps)}</td></tr>`).join('')}</tbody></table>` : '';
  const title = o.title ?? `Load test: ${r.scenario.name}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--card:#f6f8fa;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--c1:#0969da;--c2:#1a7f37;--c3:#8250df;--c4:#bc4c00;--c5:#cf222e}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9da7b3;--line:#30363d;--card:#161b22;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--c1:#58a6ff;--c2:#3fb950;--c3:#bc8cff;--c4:#ffa657;--c5:#ff7b72}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:24px;max-width:1200px;margin:auto}h1{margin:.2em 0}h2{margin-top:1.6em;border-bottom:1px solid var(--line);padding-bottom:.2em}
.muted{color:var(--muted)}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0}.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}.kpi b{display:block;font-size:20px}
.verdict{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:700;border:2px solid}.verdict.ok,.pill.ok{color:var(--ok);border-color:var(--ok)}.verdict.warn,.pill.warn{color:var(--warn);border-color:var(--warn)}.verdict.bad,.pill.bad{color:var(--bad);border-color:var(--bad)}
.pill{border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px}table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}caption{text-align:left;font-weight:600;padding:4px 0}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}td.bad{color:var(--bad)}
.chart{margin:10px 0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px}.chart svg{width:100%;height:180px;display:block}.chart figcaption{font-weight:600;margin-bottom:4px}.legend{font-weight:400;color:var(--muted);margin-left:8px}
.lg{margin-right:10px;white-space:nowrap}.sw{display:inline-block;width:12px;height:3px;margin-right:4px;vertical-align:middle}.s{fill:none;stroke-width:1.6}.grid{stroke:var(--line);stroke-width:.5}.tick{fill:var(--muted);font-size:10px}.mark{stroke:var(--bad);stroke-dasharray:3 3}
.s.c1,.sw.c1{stroke:var(--c1);background:var(--c1)}.s.c2,.sw.c2{stroke:var(--c2);background:var(--c2)}.s.c3,.sw.c3{stroke:var(--c3);background:var(--c3)}.s.c4,.sw.c4{stroke:var(--c4);background:var(--c4)}.s.c5,.sw.c5{stroke:var(--c5);background:var(--c5)}
.findings li{margin:4px 0}.sev-high strong{color:var(--bad)}.sev-medium strong{color:var(--warn)}code{font-size:12px;word-break:break-all}
</style></head><body><main>
<header><p class="muted">EZTest Load · run ${esc(r.runId)} · ${esc(r.startedAt)} · ${Math.round(r.durationMs / 1000)} s · ${esc(r.scenario.model)} model${r.agents.length ? ` · ${r.agents.length} load generator(s)` : ''}</p><h1>${esc(title)}</h1><p><span class="verdict ${verdictCls}">${esc(r.verdict.toUpperCase())}</span>${r.stopReason ? ` <span class="muted">${esc(r.stopReason)}</span>` : ''}</p></header>
<section class="kpis" aria-label="Key figures">
<div class="kpi"><span class="muted">Requests</span><b>${t.requests.toLocaleString('en')}</b></div>
<div class="kpi"><span class="muted">Throughput</span><b>${fmt(t.rps)}/s</b></div>
<div class="kpi"><span class="muted">Errors</span><b>${pct(t.errorRate)}</b></div>
<div class="kpi"><span class="muted">p50 / p95 / p99</span><b>${fmt(t.latency.p50)} / ${fmt(t.latency.p95)} / ${fmt(t.latency.p99)} ms</b></div>
<div class="kpi"><span class="muted">Peak VUs</span><b>${t.maxVus}</b></div>
<div class="kpi"><span class="muted">Generator lag (p99, worst second)</span><b>${fmt(t.generatorLag?.worstMs)} ms</b></div>
<div class="kpi"><span class="muted">Iterations</span><b>${t.iterations.toLocaleString('en')}${t.dropped ? ` (${t.dropped} dropped)` : ''}</b></div>
</section>
<section><h2>SLAs</h2>${slaTable}</section>
<section><h2>Analysis</h2>${findings}</section>
<section><h2>Timeline</h2>${timelineCharts(r.timeline, r)}</section>
<section><h2>Transactions</h2>${nameTable}<p class="muted">Response times are measured from each iteration's intended start (coordinated-omission safe). Service time p99 of all requests: ${fmt(t.service.p99)} ms vs response time p99 ${fmt(t.latency.p99)} ms.</p></section>
<section><h2>Errors</h2>${errorsHtml}</section>
${topSql ? `<section><h2>Database</h2>${topSql}</section>` : ''}
${agents ? `<section><h2>Load generators</h2>${agents}</section>` : ''}
${cmp}
</main></body></html>`;
}
