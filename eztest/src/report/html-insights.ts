/**
 * The Quality tab's lens cards: what the accessibility, security and
 * performance lenses found across the run, by rule, with the pages and the
 * tests it was seen on. Static HTML, escaped.
 */
import { escapeHtml as e } from './escape.js';
import type { ReportModel } from './data.js';

const href = (id: string) => `#tests/${encodeURIComponent(id)}`;
const sev = (level: 'high' | 'mid' | 'low', label: string) => `<span class="cat ${level === 'high' ? 'c-product' : level === 'mid' ? 'c-data' : 'c-unknown'}">${e(label)}</span>`;

/** Accessibility, security and performance cards (empty string without lens results). */
export function qualityCards(m: ReportModel): string {
  const q = m.lenses;
  if (!q) return '';
  const name = new Map(m.tests.map((t) => [t.id, t.name]));
  const tests = (ids: string[]) => `<div class="chips">${ids.slice(0, 4).map((id) => `<a class="chip" href="${href(id)}" title="${e(name.get(id) ?? id)}">${e(name.get(id) ?? id)}</a>`).join('')}${ids.length > 4 ? `<span class="muted small">+${e(ids.length - 4)}</span>` : ''}</div>`;
  const counts = (pairs: Array<[string, number]>) => `<div class="chips" style="margin-bottom:10px">${pairs.map(([k, n]) => `<span class="chip">${e(k)} <strong>${e(n)}</strong></span>`).join('')}</div>`;
  const parts: string[] = [];
  if (q.a11y) {
    const c = q.a11y.counts;
    const rows = q.a11y.rules.slice(0, 60).map((r) => `<tr><th scope="row"><strong>${e(r.id)}</strong><div class="small" style="font-weight:400">${e(r.help)}</div>${r.sc.length ? `<div class="small muted" style="font-weight:400">WCAG ${e(r.sc.join(', '))}</div>` : ''}</th><td>${sev(r.impact === 'critical' || r.impact === 'serious' ? 'high' : r.impact === 'moderate' ? 'mid' : 'low', r.impact)}</td><td class="num">${e(r.nodes)}</td><td class="small">${e(r.pages.slice(0, 3).join(', '))}</td><td>${tests(r.tests)}</td></tr>`).join('');
    parts.push(`<section class="card span-12" aria-labelledby="q-a11y"><div class="card-h"><h3 id="q-a11y">Accessibility</h3><span class="muted small">${e(q.scanned.a11y ?? 0)} page checks</span></div>${counts((['critical', 'serious', 'moderate', 'minor'] as const).map((k) => [k, c[k]]))}${rows ? `<div class="tbl-wrap"><table><caption class="sr-only">Accessibility violations by rule</caption><thead><tr><th scope="col">Rule</th><th scope="col">Impact</th><th scope="col" class="num">Elements</th><th scope="col">Pages</th><th scope="col">Seen in</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="small muted">No violations.</p>'}</section>`);
  }
  if (q.security) {
    const c = q.security.counts;
    const rows = q.security.findings.slice(0, 60).map((f) => `<tr><th scope="row"><strong>${e(f.id)}</strong><div class="small" style="font-weight:400">${e(f.message)}</div></th><td>${sev(f.severity === 'high' || f.severity === 'critical' ? 'high' : f.severity === 'medium' ? 'mid' : 'low', f.severity)}</td><td class="small">${e(f.pages.slice(0, 3).join(', '))}${f.pages.length > 3 ? ` +${e(f.pages.length - 3)}` : ''}</td><td>${tests(f.tests)}</td></tr>`).join('');
    parts.push(`<section class="card span-12" aria-labelledby="q-sec"><div class="card-h"><h3 id="q-sec">Security</h3><span class="muted small">${e(q.scanned.security ?? 0)} page checks: headers, cookies, mixed content, exposure</span></div>${counts((['high', 'medium', 'low', 'info'] as const).map((k) => [k, c[k]]))}${rows ? `<div class="tbl-wrap"><table><caption class="sr-only">Security findings</caption><thead><tr><th scope="col">Finding</th><th scope="col">Severity</th><th scope="col">Pages</th><th scope="col">Seen in</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="small muted">No findings.</p>'}</section>`);
  }
  if (q.perf) {
    const unit = (metric: string) => (metric === 'CLS' ? '' : ' ms');
    const rows = q.perf.metrics.map((p) => `<tr><th scope="row">${e(p.metric)}</th><td>${sev(p.status === 'fail' ? 'high' : p.status === 'warn' ? 'mid' : 'low', p.status)}</td><td class="num">${e(Math.round(p.worst * 1000) / 1000)}${e(unit(p.metric))}</td><td class="num">${p.warn !== undefined ? e(p.warn) : '-'} / ${p.error !== undefined ? e(p.error) : '-'}</td><td class="num">${e(p.samples)}</td><td>${tests(p.tests)}</td></tr>`).join('');
    parts.push(`<section class="card span-12" aria-labelledby="q-perf"><div class="card-h"><h3 id="q-perf">Performance budgets</h3><span class="muted small">web vitals after each step, against warn / error budgets</span></div><div class="tbl-wrap"><table><caption class="sr-only">Performance budgets</caption><thead><tr><th scope="col">Metric</th><th scope="col">Status</th><th scope="col" class="num">Worst</th><th scope="col" class="num">Budget</th><th scope="col" class="num">Samples</th><th scope="col">Over budget in</th></tr></thead><tbody>${rows}</tbody></table></div></section>`);
  }
  return parts.join('');
}
