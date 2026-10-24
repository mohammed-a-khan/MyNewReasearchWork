/**
 * Report sections that read the run as a whole: what needs attention (new
 * failures, regressions, flaky, fixed, slower), failure categories with the
 * suggested next step, the flakiest tests from history, the quality lenses
 * (accessibility, security, performance) and the effective configuration
 * (secrets masked). Static HTML and SVG, escaped.
 */
import { escapeHtml as e } from './escape.js';
import { attentionOf, topFlakyOf, STATE_LABEL, type ReportModel, type TestState } from './data.js';
import { CATEGORY_LABEL, FAILURE_CATEGORIES, type FailureCategory } from './categorise.js';
import { fmtMs, fmtPct, hbarChart } from './charts.js';

const href = (id: string) => `#test/${encodeURIComponent(id)}`;
export const CATEGORY_MARK: Record<FailureCategory, string> = { product: 'st-failed', test: 'st-healed', environment: 'st-error', data: 'st-flaky', flaky: 'st-flaky', unknown: 'st-skipped' };
const catChip = (c: FailureCategory) => `<span class="cat c-${c}">${e(CATEGORY_LABEL[c])}</span>`;
const seqSpark = (seq: string) => `<span class="spark sm" role="img" aria-label="History, oldest first: ${e(seq.split('').map((c) => (c === 'P' ? 'pass' : c === 'H' ? 'healed pass' : 'fail')).join(', '))}">${seq.split('').map((c) => `<i class="${c === 'P' || c === 'H' ? c : 'F'}"></i>`).join('')}</span>`;

/** "Needs attention": new failures, regressions against the baseline, flaky, fixed and slower tests. */
export function attentionBlock(m: ReportModel): string {
  const a = attentionOf(m);
  const li = (id: string, name: string, extra = '') => `<li><a href="${href(id)}">${e(name)}</a>${extra}</li>`;
  const card = (title: string, n: number, cls: string, items: string[], empty: string, total = n) =>
    `<div class="card"><h3><span class="cnt ${cls}">${e(n)}</span>${e(title)}</h3>${items.length ? `<ul>${items.slice(0, 5).join('')}${total > 5 ? `<li class="muted">+${e(total - 5)} more</li>` : ''}</ul>` : `<p class="small muted">${e(empty)}</p>`}</div>`;
  return `<div class="attn" role="region" aria-label="Needs attention">
${card('New failures', a.newFailures.length, a.newFailures.length ? 'ink-failed' : '', a.newFailures.map((t) => li(t.id, t.name, t.cat ? ` ${catChip(t.cat.c)}` : '')), 'No failure is new: every failing signature was seen before.')}
${card('Regressions', a.regressions.length, a.regressions.length ? 'ink-failed' : '', a.regressions.map((t) => li(t.id, t.name)), m.comparison ? 'Nothing that passed in the baseline fails now.' : 'No baseline run to compare with.')}
${card('Flaky', a.flaky.length, '', a.flaky.map((t) => li(t.id, t.name, t.history ? ` ${seqSpark(t.history.sequence.slice(-10))}` : '')), 'No test passed only on retry.')}
${card('Fixed', a.fixed.length, a.fixed.length ? 'ink-passed' : '', a.fixed.map((t) => li(t.id, t.name)), m.comparison ? 'Nothing that failed in the baseline passes now.' : 'No baseline run to compare with.')}
${card('Slower', a.slower.length, '', a.slower.map((t) => li(t.id, t.name, ` <span class="muted">${e(fmtMs(t.beforeMs))} &rarr; ${e(fmtMs(t.afterMs))}</span>`)), m.comparison ? 'No test got 1.5x slower than the baseline.' : 'No baseline run to compare with.')}
</div>`;
}

/** Failure categories (bar per category, each bar filters the test list) with the suggested next step. */
export function categoriesCard(m: ReportModel): string {
  const cats = m.categories ?? {};
  const rows = FAILURE_CATEGORIES.filter((c) => cats[c]).map((c) => ({ label: CATEGORY_LABEL[c], value: cats[c]!, valueLabel: `${cats[c]} test${cats[c] === 1 ? '' : 's'}`, cls: CATEGORY_MARK[c], href: `#category/${c}`, tip: `${CATEGORY_LABEL[c]}: ${cats[c]} test(s)` }));
  if (!rows.length) return `<div class="card"><h3>Failure categories</h3><p class="muted">Nothing failed or was flaky in this run.</p></div>`;
  const fixes = FAILURE_CATEGORIES.filter((c) => cats[c]).map((c) => {
    const t = m.tests.find((x) => x.cat?.c === c);
    return t?.cat ? `<li>${catChip(c)} <span class="fixline">${e(t.cat.fix)}</span></li>` : '';
  }).join('');
  return `<div class="card" id="categories"><h3>Failure categories</h3><p class="card-sub">Every failing and flaky test in one category: product defect, test issue, environment, test data, flaky, or needs review. Select a bar to list those tests.</p>${hbarChart(rows, { title: 'Failing and flaky tests by category', unit: 'Tests', labelWidth: 150, width: 560 })}
<details class="small" style="margin-top:6px"><summary>Suggested next step per category</summary><ul class="reasons" style="gap:8px;margin-top:6px">${fixes}</ul></details></div>`;
}

/** The flakiest tests from history (flips, failure rate, recent outcomes). */
export function topFlakyCard(m: ReportModel): string {
  const top = topFlakyOf(m);
  if (!top.length) return `<div class="card"><h3>Flakiest tests</h3><p class="muted">No test flips between passing and failing in the recorded history.</p></div>`;
  return `<div class="card"><h3>Flakiest tests</h3><p class="card-sub">From history: outcome flips, failure rate and the recent outcomes (oldest first).</p><div class="tbl-wrap"><table><thead><tr><th scope="col">Test</th><th scope="col">This run</th><th scope="col">Flips</th><th scope="col">Failure rate</th><th scope="col">Recent</th></tr></thead><tbody>${top
    .map((t) => `<tr><td><a href="${href(t.id)}">${e(t.name)}</a></td><td>${e(STATE_LABEL[t.state as TestState])}</td><td class="num">${e(t.flips)}</td><td class="num">${e(fmtPct(t.failRate, 0))} <span class="muted small">(${e(t.failures)} of ${e(t.samples)})</span></td><td>${seqSpark(t.sequence.slice(-16))}</td></tr>`)
    .join('')}</tbody></table></div></div>`;
}

/** The quality lenses of the run: accessibility rules, security findings and performance budgets. */
export function qualityBlock(m: ReportModel): string {
  const q = m.lenses;
  if (!q) return '';
  const tests = (ids: string[]) => `<div class="chips">${ids.slice(0, 6).map((id) => `<a class="chip" href="${href(id)}">${e(m.tests.find((t) => t.id === id)?.name ?? id)}</a>`).join('')}${ids.length > 6 ? `<span class="muted small">+${e(ids.length - 6)}</span>` : ''}</div>`;
  const ev = (ids: string[]) => ids.slice(0, 3).map((id) => {
    const r = m.evidence[id];
    return r?.[1] ? `<a class="mono small" href="${e(r[1])}">${e(id)}</a>` : `<span class="mono small">${e(id)}</span>`;
  }).join(' ');
  const parts: string[] = [];
  if (q.a11y) {
    const c = q.a11y.counts;
    const rows = q.a11y.rules.slice(0, 60).map((r) => `<tr><td><strong>${e(r.id)}</strong><div class="small">${e(r.help)}</div>${r.sc.length ? `<div class="small muted">WCAG ${e(r.sc.join(', '))}</div>` : ''}${r.targets.length ? `<div class="small mono muted">${e(r.targets.slice(0, 2).join(' | '))}</div>` : ''}</td><td><span class="cat ${r.impact === 'critical' || r.impact === 'serious' ? 'c-product' : r.impact === 'moderate' ? 'c-data' : 'c-unknown'}">${e(r.impact)}</span></td><td class="num">${e(r.nodes)}</td><td class="small">${e(r.pages.slice(0, 3).join(', '))}</td><td>${tests(r.tests)}</td><td>${ev(r.ev)}</td></tr>`).join('');
    parts.push(`<div class="card"><h3>Accessibility</h3><p class="card-sub">${e(q.scanned.a11y ?? 0)} page check(s) by EZTest's accessibility engine.</p><div class="q-counts">${(['critical', 'serious', 'moderate', 'minor'] as const).map((k) => `<span class="chip">${e(k)} <strong>${e(c[k])}</strong></span>`).join('')}</div>${rows ? `<div class="tbl-wrap"><table><caption class="sr-only">Accessibility violations by rule</caption><thead><tr><th scope="col">Rule</th><th scope="col">Impact</th><th scope="col">Elements</th><th scope="col">Pages</th><th scope="col">Tests</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="small">No violations.</p>'}</div>`);
  }
  if (q.security) {
    const c = q.security.counts;
    const rows = q.security.findings.slice(0, 60).map((f) => `<tr><td><strong>${e(f.id)}</strong><div class="small">${e(f.message)}</div></td><td><span class="cat ${f.severity === 'high' || f.severity === 'critical' ? 'c-product' : f.severity === 'medium' ? 'c-data' : 'c-unknown'}">${e(f.severity)}</span></td><td class="small">${e(f.pages.slice(0, 3).join(', '))}${f.pages.length > 3 ? ` +${e(f.pages.length - 3)}` : ''}</td><td>${tests(f.tests)}</td><td>${ev(f.ev)}</td></tr>`).join('');
    parts.push(`<div class="card"><h3>Security</h3><p class="card-sub">${e(q.scanned.security ?? 0)} page check(s): headers, cookies, mixed content and exposure.</p><div class="q-counts">${(['high', 'medium', 'low', 'info'] as const).map((k) => `<span class="chip">${e(k)} <strong>${e(c[k])}</strong></span>`).join('')}</div>${rows ? `<div class="tbl-wrap"><table><caption class="sr-only">Security findings</caption><thead><tr><th scope="col">Finding</th><th scope="col">Severity</th><th scope="col">Pages</th><th scope="col">Tests</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="small">No findings.</p>'}</div>`);
  }
  if (q.perf) {
    const unit = (metric: string) => (metric === 'CLS' ? '' : ' ms');
    const rows = q.perf.metrics.map((p) => `<tr><td><strong>${e(p.metric)}</strong></td><td><span class="cat ${p.status === 'fail' ? 'c-product' : p.status === 'warn' ? 'c-data' : 'c-unknown'}">${e(p.status)}</span></td><td class="num">${e(Math.round(p.worst * 1000) / 1000)}${e(unit(p.metric))}</td><td class="num">${p.warn !== undefined ? e(p.warn) : '-'} / ${p.error !== undefined ? e(p.error) : '-'}</td><td class="num">${e(p.samples)}</td><td>${tests(p.tests)}</td></tr>`).join('');
    parts.push(`<div class="card"><h3>Performance budgets</h3><p class="card-sub">Web vitals measured after each step, against the budgets (warn / error).</p><div class="tbl-wrap"><table><caption class="sr-only">Performance budgets</caption><thead><tr><th scope="col">Metric</th><th scope="col">Status</th><th scope="col">Worst</th><th scope="col">Budget</th><th scope="col">Samples</th><th scope="col">Over budget in</th></tr></thead><tbody>${rows}</tbody></table></div></div>`);
  }
  return `<section class="block" id="quality" aria-labelledby="quality-h"><div class="block-head"><h2 id="quality-h">Quality lenses</h2><p>What the accessibility, security and performance lenses found across the run, by rule, with the tests and pages it was seen on.</p></div><div style="display:grid;grid-template-columns:minmax(0,1fr);gap:16px">${parts.join('')}</div></section>`;
}

/** The effective configuration, secrets masked, with a filter. */
export function configCard(m: ReportModel): string {
  if (!m.config?.length) return '';
  return `<details class="card" id="config" style="margin-top:14px"><summary><h3 style="display:inline">Configuration</h3> <span class="muted small">${e(m.config.length)} effective settings; passwords, tokens, keys and credentials in URLs are masked</span></summary>
<div style="margin-top:10px"><div class="cfg-filter no-print"><label class="sr-only" for="cfg-q">Filter settings</label><input type="search" id="cfg-q" placeholder="Filter settings (key or value)" autocomplete="off"> <span id="cfg-count" class="small muted" aria-live="polite"></span></div>
<div class="tbl-wrap"><table class="cfg" id="cfg-table"><caption class="sr-only">Effective configuration</caption><thead><tr><th scope="col">Setting</th><th scope="col">Value</th></tr></thead><tbody>${m.config.map(([k, v]) => `<tr><td class="mono">${e(k)}</td><td class="mono">${e(v)}</td></tr>`).join('')}</tbody></table></div></div></details>`;
}
