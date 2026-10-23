/**
 * Spec governance: deterministic lint rules over an OpenAPI/Swagger document,
 * in the spirit of API style guides (operation ids, documented responses,
 * declared path parameters, error responses, security, examples). Each rule
 * can be switched off or its severity changed.
 */
import type { ApiOperation, ApiSpec } from './openapi.js';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  /** Operation id or JSON pointer of the problem. */
  where: string;
  message: string;
}

export interface LintRule {
  id: string;
  severity: LintSeverity;
  description: string;
  check(spec: ApiSpec): Array<Omit<LintFinding, 'rule' | 'severity'>>;
}

const per = (fn: (op: ApiOperation) => string | undefined) => (spec: ApiSpec) =>
  spec.operations.flatMap((op) => {
    const m = fn(op);
    return m ? [{ where: op.id, message: m }] : [];
  });

export const LINT_RULES: LintRule[] = [
  { id: 'info-title-version', severity: 'error', description: 'info.title and info.version are set',
    check: (s) => (!s.title || !s.apiVersion ? [{ where: '#/info', message: 'info.title and info.version are required' }] : []) },
  { id: 'servers-defined', severity: 'warning', description: 'servers (or host/basePath) are declared',
    check: (s) => (s.servers.length ? [] : [{ where: '#/servers', message: 'no servers declared; imports and mocks cannot derive a base URL' }]) },
  { id: 'operation-id', severity: 'error', description: 'every operation has an operationId',
    check: per((op) => (op.operationId ? undefined : 'operationId is missing')) },
  { id: 'operation-id-unique', severity: 'error', description: 'operationIds are unique',
    check: (s) => {
      const seen = new Map<string, number>();
      for (const op of s.operations) if (op.operationId) seen.set(op.operationId, (seen.get(op.operationId) ?? 0) + 1);
      return [...seen].filter(([, n]) => n > 1).map(([id, n]) => ({ where: id, message: `operationId "${id}" is used ${n} times` }));
    } },
  { id: 'operation-summary', severity: 'warning', description: 'every operation has a summary or description',
    check: per((op) => (op.summary || op.description ? undefined : 'no summary or description')) },
  { id: 'operation-tags', severity: 'info', description: 'every operation is tagged',
    check: per((op) => (op.tags.length ? undefined : 'no tags')) },
  { id: 'success-response', severity: 'error', description: 'every operation documents a 2xx (or 3xx) response',
    check: per((op) => (Object.keys(op.responses).some((c) => /^[23]/.test(c)) ? undefined : 'no success (2xx/3xx) response documented')) },
  { id: 'error-response', severity: 'warning', description: 'every operation documents a 4xx response or default',
    check: per((op) => (Object.keys(op.responses).some((c) => /^4|^default$/.test(c)) ? undefined : 'no 4xx or default error response documented')) },
  { id: 'response-schema', severity: 'warning', description: 'JSON responses have a schema',
    check: per((op) => {
      const bad = Object.entries(op.responses).filter(([, r]) => Object.entries(r.content).some(([ct, m]) => /json/.test(ct) && !m.schema)).map(([c]) => c);
      return bad.length ? `JSON response(s) ${bad.join(', ')} have no schema` : undefined;
    }) },
  { id: 'path-params-declared', severity: 'error', description: 'every {param} in a path is declared as a path parameter',
    check: per((op) => {
      const declared = new Set(op.parameters.filter((p) => p.in === 'path').map((p) => p.name));
      const missing = op.pathParams.filter((p) => !declared.has(p));
      const extra = [...declared].filter((p) => !op.pathParams.includes(p));
      if (missing.length) return `path parameter(s) ${missing.join(', ')} not declared`;
      return extra.length ? `declared path parameter(s) ${extra.join(', ')} are not in the path` : undefined;
    }) },
  { id: 'security-defined', severity: 'error', description: 'security requirements name declared security schemes',
    check: (s) => s.operations.flatMap((op) => op.security.filter((n) => !(n in s.securitySchemes)).map((n) => ({ where: op.id, message: `security scheme "${n}" is not declared` }))) },
  { id: 'no-trailing-slash', severity: 'warning', description: 'paths do not end with a slash',
    check: (s) => [...new Set(s.operations.map((o) => o.path))].filter((p) => p.length > 1 && p.endsWith('/')).map((p) => ({ where: p, message: 'path ends with "/"' })) },
  { id: 'get-no-body', severity: 'error', description: 'GET/HEAD/DELETE operations do not take a request body',
    check: per((op) => (['GET', 'HEAD'].includes(op.method) && op.requestBody ? `${op.method} must not have a request body` : undefined)) },
  { id: 'request-body-example', severity: 'info', description: 'request bodies carry an example (used by imports and mocks)',
    check: per((op) => (op.requestBody && !Object.values(op.requestBody.content).some((m) => m.example !== undefined || m.examples) ? 'request body has no example' : undefined)) },
  { id: 'unresolved-refs', severity: 'error', description: 'every $ref resolves',
    check: (s) => s.warnings.map((w) => ({ where: '#', message: w })) },
];

export interface LintOptions {
  /** rule id -> 'off' or a severity override. */
  rules?: Record<string, LintSeverity | 'off'>;
}

export interface LintReport {
  file: string;
  findings: LintFinding[];
  counts: Record<LintSeverity, number>;
  /** False when there is at least one error finding. */
  passed: boolean;
}

export function lintSpec(spec: ApiSpec, opts: LintOptions = {}): LintReport {
  const findings: LintFinding[] = [];
  for (const rule of LINT_RULES) {
    const o = opts.rules?.[rule.id];
    if (o === 'off') continue;
    const severity = o ?? rule.severity;
    for (const f of rule.check(spec)) findings.push({ rule: rule.id, severity, ...f });
  }
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { file: spec.file, findings, counts, passed: counts.error === 0 };
}

export function lintReportText(r: LintReport): string {
  const lines = [`${r.file}: ${r.counts.error} error(s), ${r.counts.warning} warning(s), ${r.counts.info} info`];
  for (const f of r.findings) lines.push(`  ${f.severity.padEnd(7)} ${f.rule.padEnd(22)} ${f.where}: ${f.message}`);
  return lines.join('\n');
}
