/**
 * Human-readable pack summary for auditors (HTML or Markdown). Every value
 * from the manifest is escaped; the page is self-contained.
 */
import { escapeHtml } from '../report/escape.js';
import type { PackManifest } from './manifest.js';

export const SIGNATURE_STATEMENT = [
  'The ed25519 signature in pack-manifest.sig covers the canonical form of pack-manifest.json.',
  'A valid signature proves that, since signing, no listed file has changed (each is bound by its SHA-256), no file was added or removed, and the manifest (run summary, traceability, signer, profile) is unaltered — and that the signer held the private key with the stated fingerprint.',
  'The embedded evidence-manifest.jsonl is a hash chain written during the run; re-verifying it shows each evidence file is the one recorded at that point in the run.',
  'The signature does not prove that the tests were adequate, that the system behaved correctly outside the recorded journeys, or who physically controlled the key; key custody and identity checks are procedural controls.',
];

const mdEscape = (v: unknown) =>
  String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([|`*_[\]<>#])/g, '\\$1')
    .replace(/\r?\n/g, ' ');

export function renderPackSummary(manifest: PackManifest, opts: { format?: 'html' | 'markdown' } = {}): string {
  const m = manifest;
  const s = m.run.summary;
  const counts = `${s.total} total — ${s.passed} passed, ${s.passedHealed} passed-healed, ${s.failed} failed, ${s.skipped} skipped, ${s.errors} errors`;
  if (opts.format === 'markdown') {
    const lines = [
      `# Evidence pack — run ${mdEscape(m.run.runId)}`,
      '',
      `**Profile:** ${mdEscape(m.profile.title)}  `,
      `**Signer:** ${mdEscape(m.signer.name)} (${mdEscape(m.signer.role)}) — ${mdEscape(m.signer.meaning)}  `,
      `**Signed at (UTC):** ${mdEscape(m.createdAt)}  `,
      `**Key fingerprint (SHA-256 of SPKI):** \`${mdEscape(m.key.fingerprint)}\`  `,
      `**Run:** ${mdEscape(m.run.startedAt)} → ${mdEscape(m.run.finishedAt)}; ${mdEscape(counts)}  `,
      `**Evidence chain head:** \`${mdEscape(m.evidence.head)}\` (${m.evidence.entries} entries, ${m.evidence.excluded.length} excluded)`,
      '',
      '## Traceability',
      '',
      `| ${mdEscape(m.profile.requirementLabel)} | Journey | Result | Evidence |`,
      '|---|---|---|---|',
      ...m.traceability.map((r) => `| ${mdEscape(r.requirement)} | ${mdEscape(r.journeyName)} (${mdEscape(r.journeyId)}) | ${mdEscape(r.status)} | ${mdEscape(r.evidence.join(', ') || '—')} |`),
      ...(m.traceability.length ? [] : ['| — | no journey lists a requirement | — | — |']),
      '',
      ...(m.untracedJourneys.length ? ['**Journeys without a requirement:** ' + m.untracedJourneys.map((u) => `${mdEscape(u.journeyId)} (${mdEscape(u.status)})`).join(', '), ''] : []),
      '## Profile statements',
      '',
      ...m.profile.statements.map((x) => `- ${mdEscape(x)}`),
      '',
      ...(m.profile.warnings.length ? ['## Warnings', '', ...m.profile.warnings.map((w) => `- ${mdEscape(w)}`), ''] : []),
      '## What the signature proves',
      '',
      ...SIGNATURE_STATEMENT.map((x) => `- ${x}`),
      '',
      '## Files',
      '',
      '| File | Role | SHA-256 | Bytes |',
      '|---|---|---|---|',
      ...m.files.map((f) => `| ${mdEscape(f.path)} | ${mdEscape(f.role)}${f.kind ? ` (${mdEscape(f.kind)})` : ''} | \`${f.sha256}\` | ${f.size} |`),
      '',
    ];
    return lines.join('\n');
  }
  const e = escapeHtml;
  const trace = m.traceability.length
    ? m.traceability
        .map((r) => `<tr><td>${e(r.requirement)}</td><td>${e(r.journeyName)}<br><code>${e(r.journeyId)}</code></td><td class="st-${e(r.status)}">${e(r.status)}</td><td>${e(r.evidence.join(', ') || '—')}</td></tr>`)
        .join('\n')
    : '<tr><td colspan="4">No journey lists a requirement.</td></tr>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evidence pack ${e(m.run.runId)}</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922}}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif;max-width:68rem;margin:0 auto;padding:1.5rem 16px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid var(--line);padding:.4rem .5rem;vertical-align:top}
th{color:var(--muted);font-size:.85rem}.wrap{overflow-x:auto}code{font-size:.85em;word-break:break-all}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{color:var(--muted)}
.st-passed,.st-passed-healed{color:var(--ok)}.st-failed,.st-error{color:var(--bad)}.warn{color:var(--warn)}
</style></head><body>
<h1>Evidence pack — run ${e(m.run.runId)}</h1>
<dl>
<dt>Profile</dt><dd>${e(m.profile.title)}</dd>
<dt>Signer</dt><dd>${e(m.signer.name)} (${e(m.signer.role)})</dd>
<dt>Meaning of signature</dt><dd>${e(m.signer.meaning)}</dd>
<dt>Signed at (UTC)</dt><dd>${e(m.createdAt)}</dd>
<dt>Key fingerprint</dt><dd><code>${e(m.key.fingerprint)}</code></dd>
<dt>Run</dt><dd>${e(m.run.startedAt)} → ${e(m.run.finishedAt)}</dd>
<dt>Results</dt><dd>${e(counts)}</dd>
<dt>Evidence chain head</dt><dd><code>${e(m.evidence.head)}</code> (${m.evidence.entries} entries, ${m.evidence.excluded.length} excluded)</dd>
</dl>
<h2>Traceability</h2>
<div class="wrap"><table><thead><tr><th>${e(m.profile.requirementLabel)}</th><th>Journey</th><th>Result</th><th>Evidence</th></tr></thead><tbody>
${trace}
</tbody></table></div>
${m.untracedJourneys.length ? `<p class="warn">Journeys without a requirement: ${m.untracedJourneys.map((u) => `<code>${e(u.journeyId)}</code> (${e(u.status)})`).join(', ')}</p>` : ''}
<h2>Profile statements</h2>
<ul>${m.profile.statements.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
${m.profile.warnings.length ? `<h2>Warnings</h2><ul class="warn">${m.profile.warnings.map((w) => `<li>${e(w)}</li>`).join('')}</ul>` : ''}
<h2>What the signature proves</h2>
<ul>${SIGNATURE_STATEMENT.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
<h2>Files</h2>
<div class="wrap"><table><thead><tr><th>File</th><th>Role</th><th>SHA-256</th><th>Bytes</th></tr></thead><tbody>
${m.files.map((f) => `<tr><td>${e(f.path)}</td><td>${e(f.role)}${f.kind ? ` (${e(f.kind)})` : ''}</td><td><code>${e(f.sha256)}</code></td><td>${f.size}</td></tr>`).join('\n')}
</tbody></table></div>
</body></html>`;
}
