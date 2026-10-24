/** CSV of every test (one row per test), for spreadsheets and BI tools. RFC 4180 quoting; formula injection neutralised. */
import type { ReportModel } from './data.js';

export const CSV_COLUMNS = [
  'id', 'name', 'state', 'status', 'duration_ms', 'started_offset_ms', 'attempt', 'browser', 'suite', 'file', 'tags', 'requirements', 'risk', 'owners',
  'failed_step', 'error', 'signature', 'known_failure', 'first_seen_run', 'triage_category', 'triage_confidence', 'flaky_state', 'heals',
  'ado_test_cases', 'ado_results', 'bugs', 'data_row',
] as const;

/** Quote a cell; a leading = + - @ (or tab / CR) is prefixed with ' so spreadsheets do not run it as a formula. */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderTestsCsv(m: ReportModel): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of m.tests) {
    lines.push([
      t.id, t.name, t.state, t.status, t.durationMs, t.startMs, t.attempt, t.browser ?? '', t.suite.join(' / '), t.file ?? '', t.tags.join(' '), t.requirements.join(' '), t.risk, t.owners.join(' '),
      t.failedStep ?? '', (t.error?.message ?? '').split('\n')[0].slice(0, 500), t.signature ?? '', t.failure ? (t.failure.known ? 'yes' : 'no') : '', t.failure?.firstSeenRun ?? '',
      t.triage?.category ?? '', t.triage ? t.triage.confidence.toFixed(2) : '', t.history?.state ?? '', t.heals,
      (t.ado?.testCases ?? []).map((c) => c.id).join(' '), (t.ado?.results ?? []).map((r) => `${r.resultId ?? ''}:${r.outcome ?? ''}`).join(' '), t.bugs.map((b) => `${b.system}:${b.id}`).join(' '),
      t.row ? Object.entries(t.row).map(([k, v]) => `${k}=${v}`).join('; ') : '',
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
