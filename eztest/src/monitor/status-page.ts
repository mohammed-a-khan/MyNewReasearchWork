/**
 * Status-page helpers: a compact summary object and a self-contained HTML page
 * (inline CSS, no scripts, every value escaped).
 */
import { escapeHtml } from '../report/escape.js';
import type { MonitorHealth, MonitorState } from './state.js';

export interface MonitorSummaryJourney {
  journeyId: string;
  name: string;
  health: MonitorHealth;
  uptimePct: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  consecutiveFailures: number;
  lastRunAt?: string;
  lastChange?: string;
  failingStep?: string;
}

export interface MonitorSummary {
  overall: MonitorHealth;
  counts: Record<MonitorHealth, number>;
  journeys: MonitorSummaryJourney[];
  runs: number;
  ticks: number;
  skippedTicks: number;
  updatedAt: string;
  lastRunError?: string;
  recentAlerts: Array<{ at: string; journeyId: string; kind: 'down' | 'recovered' }>;
}

const SEVERITY: Record<MonitorHealth, number> = { unknown: 0, up: 1, degraded: 2, down: 3 };

export function summarizeMonitorState(state: MonitorState): MonitorSummary {
  const journeys = Object.values(state.journeys)
    .map((j) => ({
      journeyId: j.journeyId,
      name: j.name,
      health: j.health,
      uptimePct: j.uptimePct,
      p50Ms: j.p50Ms,
      p95Ms: j.p95Ms,
      consecutiveFailures: j.consecutiveFailures,
      lastRunAt: j.lastRunAt,
      lastChange: j.lastChange,
      failingStep: j.lastFailingStep ? `${j.lastFailingStep.stepId}: ${j.lastFailingStep.intent}` : undefined,
    }))
    .sort((a, b) => SEVERITY[b.health] - SEVERITY[a.health] || a.journeyId.localeCompare(b.journeyId));
  const counts: Record<MonitorHealth, number> = { up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const j of journeys) counts[j.health] += 1;
  let overall: MonitorHealth = 'unknown';
  if (journeys.length) {
    overall = counts.down ? 'down' : counts.degraded ? 'degraded' : counts.up ? 'up' : 'unknown';
  }
  return {
    overall,
    counts,
    journeys,
    runs: state.runs,
    ticks: state.ticks,
    skippedTicks: state.skippedTicks,
    updatedAt: state.updatedAt,
    lastRunError: state.lastRunError,
    recentAlerts: state.alerts.slice(-10).reverse().map((a) => ({ at: a.at, journeyId: a.journeyId, kind: a.kind })),
  };
}

const LABEL: Record<MonitorHealth, string> = { up: 'Operational', degraded: 'Degraded', down: 'Down', unknown: 'No data' };

const fmtMs = (v: number | null) => (v === null ? '–' : `${Math.round(v)} ms`);
const fmtPct = (v: number | null) => (v === null ? '–' : `${v.toFixed(2)}%`);

export function renderStatusPage(state: MonitorState, opts: { title?: string } = {}): string {
  const s = summarizeMonitorState(state);
  const title = opts.title ?? 'EZTest monitor status';
  const rows = s.journeys
    .map(
      (j) => `<tr class="h-${j.health}"><td><span class="dot" aria-hidden="true"></span>${escapeHtml(LABEL[j.health])}</td>
<td><strong>${escapeHtml(j.name)}</strong><br><code>${escapeHtml(j.journeyId)}</code>${j.failingStep ? `<div class="fail">Failing: ${escapeHtml(j.failingStep)}</div>` : ''}</td>
<td>${escapeHtml(fmtPct(j.uptimePct))}</td><td>${escapeHtml(fmtMs(j.p50Ms))}</td><td>${escapeHtml(fmtMs(j.p95Ms))}</td>
<td>${escapeHtml(j.lastRunAt ?? '–')}</td><td>${escapeHtml(j.lastChange ?? '–')}</td></tr>`,
    )
    .join('\n');
  const alerts = s.recentAlerts.length
    ? `<ul>${s.recentAlerts.map((a) => `<li>${escapeHtml(a.at)} — <code>${escapeHtml(a.journeyId)}</code> ${escapeHtml(a.kind === 'down' ? 'went down' : 'recovered')}</li>`).join('')}</ul>`
    : '<p>No alerts.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--up:#1a7f37;--down:#cf222e;--deg:#9a6700;--unk:#6e7781}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--up:#3fb950;--down:#f85149;--deg:#d29922;--unk:#8b949e}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:72rem;padding:1.5rem 16px}
h1{font-size:1.4rem}.banner{padding:.8rem 1rem;border-radius:8px;border:1px solid var(--line);font-weight:600;margin-bottom:1rem}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.85rem}.dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.4rem;background:var(--unk)}
.h-up .dot,.o-up{background:var(--up)}.h-down .dot,.o-down{background:var(--down)}.h-degraded .dot,.o-degraded{background:var(--deg)}
.o-up,.o-down,.o-degraded,.o-unknown{color:#fff}.o-unknown{background:var(--unk)}.fail{color:var(--down);font-size:.85rem}.muted{color:var(--muted)}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<div class="banner o-${s.overall}">Overall: ${escapeHtml(LABEL[s.overall])} — ${s.counts.up} up, ${s.counts.degraded} degraded, ${s.counts.down} down</div>
${s.lastRunError ? `<p class="fail">Last run error: ${escapeHtml(s.lastRunError)}</p>` : ''}
<div class="wrap"><table><thead><tr><th>Status</th><th>Journey</th><th>Uptime</th><th>p50</th><th>p95</th><th>Last run</th><th>Last change</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7">No journeys have run yet.</td></tr>'}
</tbody></table></div>
<h2>Recent alerts</h2>
${alerts}
<p class="muted">Runs: ${s.runs} · ticks: ${s.ticks} · skipped (overlap): ${s.skippedTicks} · updated ${escapeHtml(s.updatedAt)}</p>
</body></html>`;
}
