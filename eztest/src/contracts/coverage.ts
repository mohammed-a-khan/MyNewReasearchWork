/**
 * API coverage: which operations, documented status codes and parameters of
 * a spec a run exercised. Computed from the API calls a run recorded (the
 * network evidence of API steps, or the contract evidence written when
 * `api.spec` is configured), never from guesses.
 */
import { matchOperation, responseFor, type ApiSpec } from './openapi.js';

export interface ApiCall {
  method: string;
  url: string;
  status?: number;
  journeyId?: string;
  stepId?: string;
  evidenceId?: string;
  /** Request header names (values are never needed for coverage). */
  headerNames?: string[];
  /** Contract violations found for this call (from contract evidence). */
  violations?: number;
  hasBody?: boolean;
}

export interface OperationCoverage {
  id: string;
  method: string;
  path: string;
  tags: string[];
  covered: boolean;
  calls: number;
  statuses: { documented: string[]; covered: string[]; missing: string[]; seen: number[]; undocumented: number[] };
  parameters: { documented: string[]; exercised: string[]; missing: string[] };
  journeys: string[];
  evidence: string[];
  violations: number;
}

export interface ApiCoverageReport {
  spec: { file: string; title: string; version: string };
  totals: {
    operations: number; coveredOperations: number; operationRatio: number;
    statusCodes: number; coveredStatusCodes: number; statusRatio: number;
    parameters: number; coveredParameters: number; parameterRatio: number;
    calls: number; unmatchedCalls: number; violations: number;
  };
  operations: OperationCoverage[];
  unmatched: Array<{ method: string; url: string; status?: number; journeyId?: string; evidenceId?: string }>;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : Math.round((a / b) * 1000) / 1000);

export function computeApiCoverage(spec: ApiSpec, calls: ApiCall[]): ApiCoverageReport {
  const ops = new Map<string, OperationCoverage>();
  for (const op of spec.operations) {
    const documented = op.parameters.filter((p) => p.in !== 'cookie').map((p) => `${p.in}:${p.name}`);
    if (op.requestBody) documented.push('body');
    ops.set(op.id, {
      id: op.id, method: op.method, path: op.path, tags: op.tags, covered: false, calls: 0,
      statuses: { documented: Object.keys(op.responses), covered: [], missing: [], seen: [], undocumented: [] },
      parameters: { documented, exercised: [], missing: [] },
      journeys: [], evidence: [], violations: 0,
    });
  }
  const unmatched: ApiCoverageReport['unmatched'] = [];
  let violations = 0;
  for (const c of calls) {
    violations += c.violations ?? 0;
    const hit = matchOperation(spec, c.method, c.url);
    if (!hit) {
      unmatched.push({ method: c.method.toUpperCase(), url: c.url, ...(c.status !== undefined ? { status: c.status } : {}), ...(c.journeyId ? { journeyId: c.journeyId } : {}), ...(c.evidenceId ? { evidenceId: c.evidenceId } : {}) });
      continue;
    }
    const oc = ops.get(hit.operation.id)!;
    oc.covered = true;
    oc.calls++;
    oc.violations += c.violations ?? 0;
    if (c.journeyId && !oc.journeys.includes(c.journeyId)) oc.journeys.push(c.journeyId);
    if (c.evidenceId && !oc.evidence.includes(c.evidenceId)) oc.evidence.push(c.evidenceId);
    if (c.status !== undefined) {
      if (!oc.statuses.seen.includes(c.status)) oc.statuses.seen.push(c.status);
      const r = responseFor(hit.operation, c.status);
      if (!r) {
        if (!oc.statuses.undocumented.includes(c.status)) oc.statuses.undocumented.push(c.status);
      } else if (!oc.statuses.covered.includes(r.code)) oc.statuses.covered.push(r.code);
    }
    const ex = new Set(oc.parameters.exercised);
    for (const p of hit.operation.pathParams) ex.add(`path:${p}`);
    let query: URLSearchParams | undefined;
    try {
      query = new URL(c.url, 'http://placeholder').searchParams;
    } catch {
      query = undefined;
    }
    for (const k of query?.keys() ?? []) ex.add(`query:${k}`);
    for (const h of c.headerNames ?? []) {
      const p = hit.operation.parameters.find((x) => x.in === 'header' && x.name.toLowerCase() === h.toLowerCase());
      if (p) ex.add(`header:${p.name}`);
    }
    if (c.hasBody) ex.add('body');
    oc.parameters.exercised = [...ex].filter((p) => oc.parameters.documented.includes(p));
  }
  let statusCodes = 0;
  let coveredStatusCodes = 0;
  let parameters = 0;
  let coveredParameters = 0;
  for (const oc of ops.values()) {
    oc.statuses.missing = oc.statuses.documented.filter((s) => !oc.statuses.covered.includes(s));
    oc.parameters.missing = oc.parameters.documented.filter((p) => !oc.parameters.exercised.includes(p));
    oc.statuses.seen.sort((a, b) => a - b);
    statusCodes += oc.statuses.documented.length;
    coveredStatusCodes += oc.statuses.covered.length;
    parameters += oc.parameters.documented.length;
    coveredParameters += oc.parameters.exercised.length;
  }
  const list = [...ops.values()];
  const covered = list.filter((o) => o.covered).length;
  return {
    spec: { file: spec.file, title: spec.title, version: spec.apiVersion },
    totals: {
      operations: list.length, coveredOperations: covered, operationRatio: ratio(covered, list.length),
      statusCodes, coveredStatusCodes, statusRatio: ratio(coveredStatusCodes, statusCodes),
      parameters, coveredParameters, parameterRatio: ratio(coveredParameters, parameters),
      calls: calls.length, unmatchedCalls: unmatched.length, violations,
    },
    operations: list,
    unmatched,
  };
}

/** Calls from network evidence entries ({ entries: [{ method, url, status, journeyId }] }). */
export function callsFromNetworkLogs(logs: Array<{ evidenceId?: string; journeyId?: string; stepId?: string; entries: Array<{ method?: string; url?: string; status?: number; requestBody?: unknown; journeyId?: string; stepId?: string }> }>): ApiCall[] {
  const out: ApiCall[] = [];
  for (const l of logs) {
    for (const e of l.entries) {
      if (!e.method || !e.url) continue;
      out.push({
        method: e.method, url: e.url, ...(e.status !== undefined ? { status: e.status } : {}),
        ...(e.journeyId ?? l.journeyId ? { journeyId: e.journeyId ?? l.journeyId } : {}),
        ...(e.stepId ?? l.stepId ? { stepId: e.stepId ?? l.stepId } : {}),
        ...(l.evidenceId ? { evidenceId: l.evidenceId } : {}),
        hasBody: e.requestBody !== undefined && e.requestBody !== null && e.requestBody !== '',
      });
    }
  }
  return out;
}

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

export function apiCoverageMarkdown(r: ApiCoverageReport): string {
  const t = r.totals;
  const out = [
    `# API coverage: ${r.spec.title || r.spec.file} ${r.spec.version}`.trim(), '',
    `| | Covered | Total | Ratio |`, `|---|---|---|---|`,
    `| Operations | ${t.coveredOperations} | ${t.operations} | ${pct(t.operationRatio)} |`,
    `| Status codes | ${t.coveredStatusCodes} | ${t.statusCodes} | ${pct(t.statusRatio)} |`,
    `| Parameters | ${t.coveredParameters} | ${t.parameters} | ${pct(t.parameterRatio)} |`, '',
    `Calls: ${t.calls} · not in the spec: ${t.unmatchedCalls} · contract violations: ${t.violations}`, '',
    '| Operation | Calls | Status codes covered | Missing status codes | Undocumented statuses | Parameters missing |', '|---|---|---|---|---|---|',
  ];
  for (const o of r.operations) {
    out.push(`| ${o.covered ? '' : '**untested** '}\`${o.method} ${o.path}\` (${o.id}) | ${o.calls} | ${o.statuses.covered.join(', ') || '-'} | ${o.statuses.missing.join(', ') || '-'} | ${o.statuses.undocumented.join(', ') || '-'} | ${o.parameters.missing.join(', ') || '-'} |`);
  }
  if (r.unmatched.length) {
    out.push('', '## Calls not described by the spec', '', ...r.unmatched.map((u) => `- \`${u.method} ${u.url}\`${u.status !== undefined ? ` -> ${u.status}` : ''}${u.journeyId ? ` (${u.journeyId})` : ''}`));
  }
  return out.join('\n') + '\n';
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** An HTML section for the run report. */
export function apiCoverageHtml(r: ApiCoverageReport): string {
  const t = r.totals;
  const rows = r.operations.map((o) => `<tr class="${o.covered ? 'cov-yes' : 'cov-no'}"><td><code>${esc(o.method)} ${esc(o.path)}</code><br><small>${esc(o.id)}</small></td><td>${o.covered ? 'yes' : '<strong>untested</strong>'}</td><td>${o.calls}</td><td>${esc(o.statuses.covered.join(', ') || '-')}</td><td>${esc(o.statuses.missing.join(', ') || '-')}</td><td>${esc(o.statuses.undocumented.join(', ') || '-')}</td><td>${esc(o.parameters.missing.join(', ') || '-')}</td><td>${o.violations}</td></tr>`).join('');
  const unmatched = r.unmatched.length
    ? `<h3>Calls not described by the spec</h3><ul>${r.unmatched.map((u) => `<li><code>${esc(u.method)} ${esc(u.url)}</code>${u.status !== undefined ? ` &rarr; ${u.status}` : ''}</li>`).join('')}</ul>`
    : '';
  return `<section class="api-coverage" aria-labelledby="apicov-h"><h2 id="apicov-h">API coverage: ${esc(r.spec.title || r.spec.file)}</h2>
<p>Operations ${t.coveredOperations}/${t.operations} (${pct(t.operationRatio)}) · status codes ${t.coveredStatusCodes}/${t.statusCodes} (${pct(t.statusRatio)}) · parameters ${t.coveredParameters}/${t.parameters} (${pct(t.parameterRatio)}) · contract violations ${t.violations}</p>
<table><thead><tr><th>Operation</th><th>Covered</th><th>Calls</th><th>Statuses covered</th><th>Statuses missing</th><th>Undocumented</th><th>Parameters missing</th><th>Violations</th></tr></thead><tbody>${rows}</tbody></table>${unmatched}</section>`;
}
