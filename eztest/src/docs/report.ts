/**
 * Self-contained HTML and deterministic JSON output for document results
 * (reconciliation, three-way ledger, PDF diff, bulk compare, document checks).
 * All text is HTML-escaped. `maskValue` hides business values everywhere
 * (findings, ledger values, diff before/after, gate details).
 */
import type { ReconciliationReport } from './reconcile.js';
import { FINDING_TYPES } from './reconcile.js';
import type { ThreeWayReport } from './threeway.js';
import type { BulkCompareResult, PdfDiffResult } from './diff.js';
import { CHANGE_CATEGORIES } from './diff.js';
import type { DocumentCheckReport } from './checks.js';

export type DocsResult = ReconciliationReport | ThreeWayReport | PdfDiffResult | BulkCompareResult | DocumentCheckReport;

export interface OutputOptions {
  title?: string;
  /** true -> values replaced by "•••"; a function -> custom masking. */
  maskValue?: boolean | ((value: string, context: { field?: string }) => string);
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

function masker(opts: OutputOptions): (v: unknown, field?: string) => string | undefined {
  return (v, field) => {
    if (v === undefined) return undefined;
    const s = v === null ? '' : String(v);
    if (!opts.maskValue) return s;
    if (typeof opts.maskValue === 'function') return opts.maskValue(s, { field });
    return '•••';
  };
}

const VALUE_KEYS = new Set([
  'expected', 'actual', 'expectedNormalized', 'actualNormalized', 'delta', 'raw', 'normalized', 'before', 'after',
  'printedTotal', 'sum', 'expectedSum', 'actualSum',
]);

function stableSort(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stableSort);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stableSort((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Apply value masking to a result (returns a deep copy). */
export function maskResult<T extends DocsResult>(result: T, opts: OutputOptions): T {
  if (!opts.maskValue) return structuredClone(result);
  const m = masker(opts);
  const walk = (v: unknown, key?: string, parent?: Record<string, unknown>): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) out[k] = walk(x, k, o);
      // Diff descriptions embed values; rebuild them from the value-free subject.
      if (typeof o.subject === 'string' && typeof o.description === 'string') {
        out.description = `${o.subject}${'before' in o || 'after' in o ? ': changed' : ''}`;
      }
      return out;
    }
    if (key && VALUE_KEYS.has(key) && (typeof v === 'string' || typeof v === 'number')) {
      return m(v, typeof parent?.column === 'string' ? parent.column : key);
    }
    return v;
  };
  const masked = walk(result) as T;
  if (masked.kind === 'bulk-compare') {
    // Signatures are already value-free (numbers/ids generalized) but may contain text values.
    for (const c of masked.clusters) c.description = `${c.count} document(s): ${c.category}`;
  }
  return masked;
}

/** Deterministic JSON (sorted keys, 2-space indent). */
export function toJson(result: DocsResult, opts: OutputOptions = {}): string {
  return JSON.stringify(stableSort(maskResult(result, opts)), null, 2) + '\n';
}

// ----------------------------------------------------------------- HTML

const CSS = `:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--bad:#cf222e;--badbg:#ffebe9;--ok:#1a7f37;--okbg:#dafbe1;--warn:#9a6700;--warnbg:#fff8c5;--chip:#f6f8fa}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--bad:#ff7b72;--badbg:#3c1618;--ok:#3fb950;--okbg:#12261e;--warn:#d29922;--warnbg:#2e2512;--chip:#161b22}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}.muted{color:var(--muted)}
.status{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600}.PASS,.ALL_AGREE,.SAME{background:var(--okbg);color:var(--ok)}.FAIL,.MISMATCH,.MISSING,.EXTRA,.DUPLICATE_KEY,.ODD_ONE_OUT,.ALL_DISAGREE,.DISAGREE{background:var(--badbg);color:var(--bad)}
.WITHIN_TOLERANCE,.KNOWN_DIFFERENCE,.FORMAT_ONLY,.INSUFFICIENT_DATA,.masked{background:var(--warnbg);color:var(--warn)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
td code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.chips label{background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:2px 10px;cursor:pointer;user-select:none}
.tag{display:inline-block;padding:0 6px;border-radius:4px;font-size:12px;font-weight:600}.odd{outline:2px solid var(--bad)}ul{padding-left:20px}`;

const SCRIPT = `document.querySelectorAll('[data-filter]').forEach(function(cb){cb.addEventListener('change',function(){var on={};document.querySelectorAll('[data-filter]').forEach(function(c){on[c.getAttribute('data-filter')]=c.checked});document.querySelectorAll('tr[data-type]').forEach(function(r){r.style.display=on[r.getAttribute('data-type')]===false?'none':''})})});`;

function filterChips(types: string[], counts: Record<string, number>): string {
  const present = types.filter((t) => (counts[t] ?? 0) > 0);
  if (!present.length) return '';
  return `<div class="chips" role="group" aria-label="Filter by type">${present
    .map((t) => `<label><input type="checkbox" data-filter="${escapeHtml(t)}" checked> ${escapeHtml(t)} (${counts[t]})</label>`)
    .join('')}</div>`;
}

function td(v: unknown, code = false): string {
  const s = escapeHtml(v ?? '');
  return `<td>${code && s ? `<code>${s}</code>` : s}</td>`;
}

function gatesHtml(gates: ReconciliationReport['gates']): string {
  if (!gates.length) return '';
  return `<h2>Gates</h2><div class="wrap"><table><thead><tr><th>Gate</th><th>Result</th><th>Message</th><th>Details</th></tr></thead><tbody>${gates
    .map(
      (g) =>
        `<tr>${td(g.name)}<td><span class="tag ${g.passed ? 'PASS' : 'FAIL'}">${g.passed ? 'PASS' : 'FAIL'}</span></td>${td(g.message)}${td(
          g.details ? Object.entries(g.details).map(([k, v]) => `${k}=${v}`).join(', ') : '',
          true,
        )}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

function reconHtml(r: ReconciliationReport, heading = true): string {
  const s = r.summary;
  return `${heading ? `<p class="muted">${escapeHtml(r.expectedName)} ↔ ${escapeHtml(r.actualName)}</p>` : ''}
<p><span class="status ${r.status}">${r.status}</span> rows expected ${s.expectedRows}, actual ${s.actualRows}, joined ${s.matchedRows}; fields compared ${s.fieldsCompared}</p>
${s.skippedColumns.length ? `<p class="muted">Columns not present on the actual side: ${escapeHtml(s.skippedColumns.join(', '))}</p>` : ''}
${gatesHtml(r.gates)}
<h2>Findings</h2>${filterChips(FINDING_TYPES, s.counts)}
<div class="wrap"><table><thead><tr><th>Type</th><th>Key</th><th>Column</th><th>Expected</th><th>Actual</th><th>Detail</th></tr></thead><tbody>
${r.findings
  .map(
    (f) =>
      `<tr data-type="${escapeHtml(f.type)}"><td><span class="tag ${escapeHtml(f.type)}">${escapeHtml(f.type)}</span></td>${td(f.key, true)}${td(f.column)}${td(f.expected, true)}${td(f.actual, true)}${td(
        [f.message, f.reason ? `reason: ${f.reason}` : '', f.delta !== undefined ? `Δ ${f.delta}` : '', f.actualProvenance?.page ? `page ${f.actualProvenance.page}` : f.expectedProvenance?.page ? `page ${f.expectedProvenance.page}` : '']
          .filter(Boolean)
          .join(' · '),
      )}</tr>`,
  )
  .join('\n')}</tbody></table></div>`;
}

function threeWayHtml(r: ThreeWayReport): string {
  const counts: Record<string, number> = {};
  for (const f of r.fields) counts[f.verdict] = (counts[f.verdict] ?? 0) + 1;
  return `<p><span class="status ${r.status}">${r.status}</span></p>
${r.diagnosis.length ? `<h2>Diagnosis</h2><ul>${r.diagnosis.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` : ''}
<h2>Ledger</h2>${filterChips(['ALL_AGREE', 'ODD_ONE_OUT', 'DISAGREE', 'ALL_DISAGREE', 'INSUFFICIENT_DATA'], counts)}
<div class="wrap"><table><thead><tr><th>Field</th><th>UI</th><th>PDF</th><th>DB</th><th>Verdict</th><th>Diagnosis</th></tr></thead><tbody>
${r.fields
  .map(
    (f) =>
      `<tr data-type="${escapeHtml(f.verdict)}">${td(f.name)}${(['ui', 'pdf', 'db'] as const)
        .map((s) => {
          const v = f.values[s];
          const body = v.raw !== undefined ? `<code>${escapeHtml(v.raw)}</code>${v.page ? ` <span class="muted">p.${v.page}</span>` : ''}` : `<span class="muted">${escapeHtml(v.note ?? '—')}</span>`;
          return `<td${f.oddOneOut === s ? ' class="odd"' : ''}>${body}</td>`;
        })
        .join('')}<td><span class="tag ${escapeHtml(f.verdict)}">${escapeHtml(f.verdict)}</span></td>${td(f.diagnosis)}</tr>`,
  )
  .join('\n')}</tbody></table></div>
${r.footing ? gatesHtml([r.footing]) : ''}
${r.lines ? `<h2>Line items (PDF ↔ DB)</h2>${reconHtml(r.lines, false)}` : ''}`;
}

function diffHtml(r: PdfDiffResult): string {
  return `<p class="muted">${escapeHtml(r.a)} → ${escapeHtml(r.b)}</p><p><span class="status ${r.identical ? 'PASS' : 'FAIL'}">${r.identical ? 'NO SIGNIFICANT CHANGES' : 'CHANGED'}</span></p>
<h2>Changes</h2>${filterChips(CHANGE_CATEGORIES, r.summary)}
<div class="wrap"><table><thead><tr><th>Category</th><th>Page</th><th>Change</th><th>Before</th><th>After</th></tr></thead><tbody>
${r.changes
  .map(
    (c) =>
      `<tr data-type="${escapeHtml(c.category)}"><td><span class="tag ${c.category === 'masked' ? 'masked' : 'FAIL'}">${escapeHtml(c.category)}</span></td>${td(c.page ?? '')}${td(c.description)}${td(c.before, true)}${td(c.after, true)}</tr>`,
  )
  .join('\n')}</tbody></table></div>`;
}

function bulkHtml(r: BulkCompareResult): string {
  const counts: Record<string, number> = {};
  for (const c of r.clusters) counts[c.category] = (counts[c.category] ?? 0) + 1;
  return `<p class="muted">${escapeHtml(r.dirA)} → ${escapeHtml(r.dirB)}</p>
<p><span class="status ${r.status}">${r.status}</span> ${r.pairs} pair(s), ${r.identical} identical, ${r.different} different, ${r.onlyInA.length} only in A, ${r.onlyInB.length} only in B, ${r.errors.length} error(s)</p>
<h2>Clusters</h2>${filterChips([...CHANGE_CATEGORIES, 'only-in-a', 'only-in-b', 'error'], counts)}
<div class="wrap"><table><thead><tr><th>Documents</th><th>Category</th><th>Pattern</th><th>Examples</th></tr></thead><tbody>
${r.clusters
  .map((c) => `<tr data-type="${escapeHtml(c.category)}">${td(c.count)}${td(c.category)}${td(c.description)}${td(c.examples.join(', '), true)}</tr>`)
  .join('\n')}</tbody></table></div>`;
}

function checkHtml(r: DocumentCheckReport): string {
  const counts = { failed: r.findings.filter((f) => !f.passed).length, passed: r.findings.filter((f) => f.passed).length };
  return `<p class="muted">${escapeHtml(r.source)}</p><p><span class="status ${r.status}">${r.status}</span></p>
<h2>Checks</h2>${filterChips(['failed', 'passed'], counts)}
<div class="wrap"><table><thead><tr><th>Result</th><th>Check</th><th>Message</th><th>Page</th><th>Evidence (masked)</th></tr></thead><tbody>
${r.findings
  .map(
    (f) =>
      `<tr data-type="${f.passed ? 'passed' : 'failed'}"><td><span class="tag ${f.passed ? 'PASS' : 'FAIL'}">${f.passed ? 'PASS' : 'FAIL'}</span></td>${td(f.check)}${td(f.message)}${td(f.page ?? '')}${td(f.evidence, true)}</tr>`,
  )
  .join('\n')}</tbody></table></div>`;
}

const DEFAULT_TITLES: Record<DocsResult['kind'], string> = {
  reconciliation: 'Reconciliation report',
  'three-way': 'Three-way ledger',
  'pdf-diff': 'Document diff',
  'bulk-compare': 'Bulk document regression',
  'document-check': 'Document checks',
};

/** Render a self-contained HTML report (inline CSS/JS, no external resources). */
export function renderHtml(result: DocsResult, opts: OutputOptions = {}): string {
  const r = maskResult(result, opts);
  const title = opts.title ?? DEFAULT_TITLES[r.kind];
  const body =
    r.kind === 'reconciliation' ? reconHtml(r) :
    r.kind === 'three-way' ? threeWayHtml(r) :
    r.kind === 'pdf-diff' ? diffHtml(r) :
    r.kind === 'bulk-compare' ? bulkHtml(r) : checkHtml(r);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>
<h1>${escapeHtml(title)}</h1>${opts.maskValue ? '<p class="muted">Business values are masked.</p>' : ''}
${body}
</main><script>${SCRIPT}</script></body></html>
`;
}
