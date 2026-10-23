/**
 * API security scan pack: EZTest's own deterministic scanner over API
 * surfaces and OpenAPI specs. It extends the security lens (headers, cookies,
 * authorization matrix, IDOR) with probes for the OWASP API Security Top 10
 * (2023): broken object-level authorization (BOLA/IDOR), broken
 * authentication (auth-bypass replays), broken object-property-level
 * authorization (mass assignment), unrestricted resource consumption (rate
 * limits), injection (safe, marked payloads), security misconfiguration
 * (headers, CORS, verbose errors). Findings carry masked request/response
 * evidence and map to an OWASP category, and feed a readiness gate.
 *
 * It is no scanner integration and shells out to nothing: every probe is a
 * plain fetch with a deterministic payload, so a run is reproducible.
 *
 * Safe by default: a scan runs only against hosts on an explicit allow-list
 * and only when opt-in is given, never production. Mutating probes (mass
 * assignment, injection on write operations) run only when `allowMutating`
 * is set, since they create or change data on the target.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EvidenceVault, EzTestError, type EvidenceRef } from '../core/index.js';
import type { ApiOperation, ApiSpec } from '../contracts/openapi.js';
import { checkSecurityHeaders, probeIdor, runAuthorizationMatrix, type IdorUser, type SecurityFinding, type SecuritySeverity, type TokenProvider } from './security.js';

export const OWASP_API_2023 = {
  API1: 'API1:2023 Broken Object Level Authorization',
  API2: 'API2:2023 Broken Authentication',
  API3: 'API3:2023 Broken Object Property Level Authorization',
  API4: 'API4:2023 Unrestricted Resource Consumption',
  API5: 'API5:2023 Broken Function Level Authorization',
  API7: 'API7:2023 Server Side Request Forgery',
  API8: 'API8:2023 Security Misconfiguration',
  API9: 'API9:2023 Improper Inventory Management',
  API10: 'API10:2023 Unsafe Consumption of APIs',
} as const;
export type OwaspApiCategory = keyof typeof OWASP_API_2023;

export type ApiProbeName = 'authBypass' | 'bola' | 'massAssignment' | 'injection' | 'rateLimit' | 'securityHeaders' | 'cors' | 'verboseErrors';
export const ALL_PROBES: ApiProbeName[] = ['authBypass', 'bola', 'massAssignment', 'injection', 'rateLimit', 'securityHeaders', 'cors', 'verboseErrors'];

export interface ApiScanFinding extends SecurityFinding {
  probe: ApiProbeName;
  owasp: OwaspApiCategory;
  method: string;
  /** Masked request/response evidence for this finding. */
  evidence: { request?: string; response?: string; detail?: string };
}

/** One endpoint the scan exercises. */
export interface ApiTarget {
  method: string;
  /** Path (joined onto baseUrl), e.g. /api/orders/{id}. */
  path: string;
  /** Whether the endpoint is meant to require authentication (drives the auth-bypass probe). */
  authRequired?: boolean;
  /** A concrete, non-destructive value for each path/query parameter. */
  sample?: Record<string, string>;
  /** A valid request body (object) for write operations: the mass-assignment and injection probes build on it. */
  body?: Record<string, unknown>;
  /** Query parameters to fuzz for injection (default: those in `sample` plus any `?a=b` already in the path). */
  injectParams?: string[];
  /** Parameters whose value identifies an object (for BOLA): owner A's and B's values. */
  objectIds?: Record<string, [string, string]>;
}

export interface ApiScanConfig {
  baseUrl: string;
  /** Hosts the scan may touch. A scan whose baseUrl host is not here is refused. */
  allowedHosts: string[];
  /** Explicit opt-in. Without it (and the allow-list) nothing is sent. */
  confirm: boolean;
  /** Bearer token for the authenticated requests (so non-auth probes do not all 401). */
  token?: TokenProvider;
  authHeaders?: (token: string) => Record<string, string>;
  /** A second identity for BOLA (object-level authorization) checks. */
  otherToken?: TokenProvider;
  /** Allow probes that create or change data (mass assignment, injection on POST/PUT/PATCH). Default false. */
  allowMutating?: boolean;
  /** Which probes to run (default all). */
  probes?: ApiProbeName[];
  /** Sensitive properties the mass-assignment probe tries to set. */
  sensitiveProperties?: string[];
  /** Requests for the rate-limit probe burst. Default 20. */
  rateLimitBurst?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Mask secrets in evidence (tokens, cookies). The engine passes the config masker. */
  mask?: (text: string) => string;
}

export interface ApiScanReport {
  baseUrl: string;
  probes: ApiProbeName[];
  targets: number;
  findings: ApiScanFinding[];
  counts: Record<SecuritySeverity, number>;
  /** Count of findings per OWASP category. */
  owasp: Partial<Record<OwaspApiCategory, number>>;
  /** Probes that could not run (e.g. no second identity for BOLA), for honesty. */
  skipped: Array<{ probe: ApiProbeName; reason: string }>;
}

const DEFAULT_SENSITIVE = ['role', 'roles', 'isAdmin', 'admin', 'is_admin', 'isVerified', 'verified', 'permissions', 'scope', 'scopes', 'accountBalance', 'balance', 'credit', 'owner', 'ownerId', 'userId', 'id', 'status', 'approved', 'price', 'discount'];

/** Safe, clearly-marked injection payloads (they never cause real injection; they look for bad handling). */
const INJECTION_PAYLOADS: Array<{ kind: string; value: string; owasp: OwaspApiCategory }> = [
  { kind: 'sql', value: "eztest'\"--", owasp: 'API8' },
  { kind: 'sql-tautology', value: "1 OR 1=1 -- eztest", owasp: 'API8' },
  { kind: 'xss', value: '<eztest-xss>', owasp: 'API8' },
  { kind: 'path-traversal', value: '../../eztest-nope', owasp: 'API8' },
  { kind: 'nosql', value: '{"$gt":""}', owasp: 'API8' },
  { kind: 'ssrf', value: 'http://169.254.169.254/eztest', owasp: 'API7' },
];

/** Signatures of a database / stack-trace / framework error leaking to the client (verbose errors / injection). */
const ERROR_SIGNATURES: Array<{ re: RegExp; what: string }> = [
  { re: /\bSQL syntax\b|\bSQLSTATE\b|unterminated quoted string|ORA-\d{5}|PG::\w+Error|SequelizeDatabaseError|near "[^"]*": syntax error/i, what: 'SQL database error' },
  { re: /System\.\w+Exception|java\.[\w.]+Exception|Traceback \(most recent call last\)|at [\w.$]+\([\w.]+\.(?:java|cs):\d+\)|goroutine \d+ \[/i, what: 'stack trace' },
  { re: /MongoError|E11000 duplicate key|\$where|BSONError/i, what: 'NoSQL database error' },
  { re: /<eztest-xss>/, what: 'payload reflected unescaped' },
  { re: /\broot:.*:0:0:|\/etc\/passwd/i, what: 'path traversal response' },
];

const sev = (s: SecuritySeverity) => s;

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Throw unless the scan is allowed to touch `baseUrl` (allow-list + opt-in). */
export function assertScanAllowed(cfg: Pick<ApiScanConfig, 'baseUrl' | 'allowedHosts' | 'confirm'>): void {
  const host = hostOf(cfg.baseUrl);
  const hostname = hostnameOf(cfg.baseUrl);
  if (!host) throw new EzTestError(`API security scan: "${cfg.baseUrl}" is not an absolute URL`, 'INVALID_INPUT');
  if (!cfg.confirm) throw new EzTestError('API security scan is opt-in: it sends probe requests to the target. Pass confirm: true (CLI: --yes) and only against non-production hosts.', 'NOT_ALLOWED');
  const allowed = (cfg.allowedHosts ?? []).map((h) => h.toLowerCase());
  // An allow-list entry with a port must match host:port; one without matches any port on that hostname.
  const ok = allowed.some((a) => {
    if (a.startsWith('*.')) return hostname === a.slice(2) || hostname.endsWith(a.slice(1));
    return a.includes(':') ? a === host : a === hostname;
  });
  if (!ok) throw new EzTestError(`API security scan refused: ${host} is not in security.api.allowedHosts (${allowed.join(', ') || 'none configured'}). The scanner only runs against configured non-production hosts.`, 'NOT_ALLOWED');
}

/** Build scan targets from an OpenAPI spec: method, path, auth requirement, and object-id path parameters. */
export function targetsFromSpec(spec: ApiSpec, opts: { ids?: Record<string, [string, string]>; sample?: Record<string, string> } = {}): ApiTarget[] {
  return spec.operations.map((op: ApiOperation) => {
    const pathParams = op.parameters.filter((p) => p.in === 'path');
    const sample: Record<string, string> = { ...opts.sample };
    const objectIds: Record<string, [string, string]> = {};
    for (const p of pathParams) {
      const v = opts.ids?.[p.name];
      if (v) objectIds[p.name] = v;
      if (!sample[p.name]) sample[p.name] = v ? v[0] : p.example !== undefined ? String(p.example) : /id$/i.test(p.name) ? '1' : 'eztest';
    }
    return {
      method: op.method, path: op.path, authRequired: op.security.length > 0,
      ...(Object.keys(sample).length ? { sample } : {}), ...(Object.keys(objectIds).length ? { objectIds } : {}),
    };
  });
}

function fillPath(path: string, sample: Record<string, string> = {}): string {
  return path.replace(/\{([^}]+)\}/g, (_w, name: string) => encodeURIComponent(sample[name] ?? '1'));
}

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

export class ApiSecurityScanner {
  private readonly f: typeof fetch;
  private readonly timeout: number;
  private readonly mask: (s: string) => string;

  constructor(private readonly cfg: ApiScanConfig) {
    assertScanAllowed(cfg);
    this.f = cfg.fetchImpl ?? fetch;
    this.timeout = cfg.timeoutMs ?? 15_000;
    this.mask = cfg.mask ?? ((s) => s);
  }

  private async send(method: string, path: string, opts: { headers?: Record<string, string>; body?: string; query?: Record<string, string> } = {}): Promise<Sent> {
    const url = new URL(path.replace(/^\//, ''), this.cfg.baseUrl.endsWith('/') ? this.cfg.baseUrl : this.cfg.baseUrl + '/');
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    if (hostOf(url.href) !== hostOf(this.cfg.baseUrl)) return { status: 0, headers: {}, body: '', error: 'cross-host request blocked' };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeout);
    try {
      const res = await this.f(url.href, { method, headers: opts.headers, body: opts.body, redirect: 'manual', signal: ac.signal });
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      const text = (await res.text()).slice(0, 4000);
      return { status: res.status, headers, body: text };
    } catch (e) {
      return { status: 0, headers: {}, body: '', error: (e as Error).name === 'AbortError' ? 'timeout' : 'request failed' };
    } finally {
      clearTimeout(t);
    }
  }

  private async authHeaders(token?: TokenProvider): Promise<Record<string, string>> {
    if (!token) return {};
    const t = await token();
    if (!t) return {};
    return this.cfg.authHeaders ? this.cfg.authHeaders(t) : { authorization: `Bearer ${t}` };
  }

  private reqLine(method: string, path: string, extra = ''): string {
    return this.mask(`${method} ${path}${extra}`);
  }

  private respLine(r: Sent): string {
    return this.mask(`${r.status || r.error} ${r.body ? r.body.slice(0, 300) : ''}`.trim());
  }

  async scan(targets: ApiTarget[]): Promise<ApiScanReport> {
    const probes = this.cfg.probes ?? ALL_PROBES;
    const findings: ApiScanFinding[] = [];
    const skipped: ApiScanReport['skipped'] = [];
    const auth = await this.authHeaders(this.cfg.token);
    const add = (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => findings.push({ url: f.url ?? '', ...f });

    for (const probe of probes) {
      try {
        if (probe === 'authBypass') await this.authBypass(targets, add);
        else if (probe === 'bola') await this.bola(targets, add, skipped);
        else if (probe === 'massAssignment') await this.massAssignment(targets, auth, add, skipped);
        else if (probe === 'injection') await this.injection(targets, auth, add, skipped);
        else if (probe === 'rateLimit') await this.rateLimit(targets, auth, add, skipped);
        else if (probe === 'securityHeaders') await this.securityHeaders(targets, auth, add);
        else if (probe === 'cors') await this.cors(targets, auth, add);
        else if (probe === 'verboseErrors') await this.verboseErrors(targets, auth, add);
      } catch (e) {
        skipped.push({ probe, reason: (e as Error).message });
      }
    }

    const counts: Record<SecuritySeverity, number> = { info: 0, low: 0, medium: 0, high: 0 };
    const owasp: Partial<Record<OwaspApiCategory, number>> = {};
    for (const f of findings) {
      counts[f.severity]++;
      owasp[f.owasp] = (owasp[f.owasp] ?? 0) + 1;
    }
    return { baseUrl: this.cfg.baseUrl, probes, targets: targets.length, findings, counts, owasp, skipped };
  }

  // ---- API2/API5: a protected endpoint answers 2xx with no credentials
  private async authBypass(targets: ApiTarget[], add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void): Promise<void> {
    for (const t of targets.filter((x) => x.authRequired && x.method.toUpperCase() === 'GET')) {
      const path = fillPath(t.path, t.sample);
      const r = await this.send('GET', path, { query: t.sample });
      if (r.status >= 200 && r.status < 300) {
        add({ id: 'auth-bypass', probe: 'authBypass', owasp: 'API2', severity: sev('high'), method: 'GET', url: path, message: `${t.path} returns ${r.status} without authentication`, subject: t.path, evidence: { request: this.reqLine('GET', path, ' (no Authorization header)'), response: this.respLine(r) } });
      }
    }
  }

  // ---- API1: BOLA/IDOR — one identity reads another's object (reuses probeIdor)
  private async bola(targets: ApiTarget[], add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void, skipped: ApiScanReport['skipped']): Promise<void> {
    const withIds = targets.filter((t) => t.objectIds && Object.keys(t.objectIds).length && t.method.toUpperCase() === 'GET');
    if (!withIds.length) { skipped.push({ probe: 'bola', reason: 'no targets with owner A/B object ids (set objectIds)' }); return; }
    if (!this.cfg.token || !this.cfg.otherToken) { skipped.push({ probe: 'bola', reason: 'needs two identities (token and otherToken) to compare object access' }); return; }
    const aPaths: string[] = [];
    const bPaths: string[] = [];
    for (const t of withIds) {
      const a: Record<string, string> = { ...t.sample };
      const b: Record<string, string> = { ...t.sample };
      for (const [k, [va, vb]] of Object.entries(t.objectIds!)) {
        a[k] = va;
        b[k] = vb;
      }
      aPaths.push(fillPath(t.path, a));
      bPaths.push(fillPath(t.path, b));
    }
    const users: [IdorUser, IdorUser] = [
      { name: 'userA', token: this.cfg.token, resources: aPaths, ...(this.cfg.authHeaders ? { authHeaders: this.cfg.authHeaders } : {}) },
      { name: 'userB', token: this.cfg.otherToken, resources: bPaths, ...(this.cfg.authHeaders ? { authHeaders: this.cfg.authHeaders } : {}) },
    ];
    const { findings } = await probeIdor({ baseUrl: this.cfg.baseUrl, users, fetchImpl: this.f, timeoutMs: this.timeout });
    for (const f of findings.filter((x) => x.verdict === 'vulnerable')) {
      add({ id: 'bola', probe: 'bola', owasp: 'API1', severity: sev('high'), method: 'GET', url: f.path, message: `${f.requester} can read ${f.owner}'s object at ${f.path} (status ${f.requesterStatus})`, subject: f.path, evidence: { request: this.reqLine('GET', f.path, ` as ${f.requester}`), response: `owner ${f.ownerStatus}, other identity ${f.requesterStatus}` } });
    }
  }

  // ---- API3: mass assignment / BOPLA — a write accepts a sensitive property it should ignore
  private async massAssignment(targets: ApiTarget[], auth: Record<string, string>, add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void, skipped: ApiScanReport['skipped']): Promise<void> {
    const writes = targets.filter((t) => ['POST', 'PUT', 'PATCH'].includes(t.method.toUpperCase()) && t.body);
    if (!writes.length) { skipped.push({ probe: 'massAssignment', reason: 'no write targets with a sample body' }); return; }
    if (!this.cfg.allowMutating) { skipped.push({ probe: 'massAssignment', reason: 'mutating probe not enabled (set allowMutating: true against a non-production host)' }); return; }
    const sensitive = this.cfg.sensitiveProperties ?? DEFAULT_SENSITIVE;
    for (const t of writes) {
      const path = fillPath(t.path, t.sample);
      const inject = sensitive.filter((p) => !(p in (t.body ?? {})));
      const marker = `eztest-${Date.now().toString(36)}`;
      const body = { ...t.body, ...Object.fromEntries(inject.map((p) => [p, /id$/i.test(p) || /balance|credit|price|discount/i.test(p) ? 999999 : /role|scope|permission/i.test(p) ? `admin-${marker}` : true])) };
      const r = await this.send(t.method.toUpperCase(), path, { headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body), query: t.sample });
      if (r.status < 200 || r.status >= 300) continue;
      const echoed = inject.filter((p) => new RegExp(`"${p}"\\s*:`).test(r.body) && (r.body.includes(`admin-${marker}`) || new RegExp(`"${p}"\\s*:\\s*(?:true|999999)`).test(r.body)));
      if (echoed.length) {
        add({ id: 'mass-assignment', probe: 'massAssignment', owasp: 'API3', severity: sev('high'), method: t.method.toUpperCase(), url: path, message: `${t.method} ${t.path} accepted and reflected unexpected propert${echoed.length > 1 ? 'ies' : 'y'}: ${echoed.join(', ')}`, subject: echoed.join(','), evidence: { request: this.reqLine(t.method.toUpperCase(), path, ` body+${echoed.join('+')}`), response: this.respLine(r) } });
      }
    }
  }

  // ---- API8/API7: injection with safe payloads — error signatures, reflection or 500s
  private async injection(targets: ApiTarget[], auth: Record<string, string>, add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void, skipped: ApiScanReport['skipped']): Promise<void> {
    let ran = false;
    for (const t of targets) {
      const method = t.method.toUpperCase();
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (mutating && !this.cfg.allowMutating) continue;
      const params = t.injectParams ?? Object.keys(t.sample ?? {});
      if (!params.length && !t.body) continue;
      ran = true;
      for (const payload of INJECTION_PAYLOADS) {
        // Baseline then injected, so a 500 only the payload causes is the signal.
        const baseQ = { ...t.sample };
        const target = params[0] ?? Object.keys(t.sample ?? {})[0];
        if (!target) break;
        const q = { ...baseQ, [target]: payload.value };
        const path = fillPath(t.path, q);
        const r = await this.send(method, path, { headers: auth, query: q, ...(mutating && t.body ? { body: JSON.stringify({ ...t.body, [target]: payload.value }) } : {}) });
        const sig = ERROR_SIGNATURES.find((s) => s.re.test(r.body));
        if (sig) {
          add({ id: `injection-${payload.kind}`, probe: 'injection', owasp: payload.owasp, severity: sev(payload.kind === 'xss' ? 'medium' : 'high'), method, url: path, message: `${t.path} (${target}) returned a ${sig.what} for a ${payload.kind} payload`, subject: target, evidence: { request: this.reqLine(method, path, ` ${target}=${payload.value}`), response: this.respLine(r), detail: sig.what } });
          break; // one finding per parameter is enough
        }
        if (r.status >= 500) {
          add({ id: `injection-500-${payload.kind}`, probe: 'injection', owasp: payload.owasp, severity: sev('medium'), method, url: path, message: `${t.path} (${target}) returned ${r.status} for a ${payload.kind} payload (unhandled input)`, subject: target, evidence: { request: this.reqLine(method, path, ` ${target}=${payload.value}`), response: this.respLine(r) } });
          break;
        }
      }
    }
    if (!ran) skipped.push({ probe: 'injection', reason: 'no targets with parameters or a body to fuzz' });
  }

  // ---- API4: no rate limiting — a burst is never throttled
  private async rateLimit(targets: ApiTarget[], auth: Record<string, string>, add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void, skipped: ApiScanReport['skipped']): Promise<void> {
    const t = targets.find((x) => x.method.toUpperCase() === 'GET');
    if (!t) { skipped.push({ probe: 'rateLimit', reason: 'no GET target to burst' }); return; }
    const n = this.cfg.rateLimitBurst ?? 20;
    const path = fillPath(t.path, t.sample);
    const results = await Promise.all(Array.from({ length: n }, () => this.send('GET', path, { headers: auth, query: t.sample })));
    const throttled = results.filter((r) => r.status === 429).length;
    const anyLimitHeader = results.some((r) => Object.keys(r.headers).some((h) => /ratelimit|retry-after/i.test(h)));
    if (throttled === 0 && !anyLimitHeader && results.every((r) => r.status && r.status < 500)) {
      add({ id: 'no-rate-limit', probe: 'rateLimit', owasp: 'API4', severity: sev('medium'), method: 'GET', url: path, message: `${n} rapid requests to ${t.path} were all accepted with no 429 and no RateLimit/Retry-After header`, subject: t.path, evidence: { request: this.reqLine('GET', path, ` x${n}`), response: `statuses: ${[...new Set(results.map((r) => r.status))].join(', ')}` } });
    }
  }

  // ---- API8: security headers missing on an API response
  private async securityHeaders(targets: ApiTarget[], auth: Record<string, string>, add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void): Promise<void> {
    const t = targets.find((x) => x.method.toUpperCase() === 'GET') ?? targets[0];
    if (!t) return;
    const path = fillPath(t.path, t.sample);
    const r = await this.send(t.method.toUpperCase(), path, { headers: auth, query: t.sample });
    const url = new URL(path.replace(/^\//, ''), this.cfg.baseUrl.endsWith('/') ? this.cfg.baseUrl : this.cfg.baseUrl + '/').href;
    // API responses are JSON: the relevant checks are nosniff, HSTS (https), and version disclosure.
    for (const f of checkSecurityHeaders({ url, headers: r.headers, contentType: r.headers['content-type'] ?? 'application/json' })) {
      if (f.id === 'csp-missing' || f.id === 'frame-protection-missing') continue; // not meaningful for a JSON API
      add({ ...f, probe: 'securityHeaders', owasp: 'API8', method: t.method.toUpperCase(), evidence: { request: this.reqLine(t.method.toUpperCase(), path), response: this.respLine({ ...r, body: JSON.stringify(r.headers) }) } });
    }
  }

  // ---- API8: permissive CORS — reflects an arbitrary Origin, worse with credentials
  private async cors(targets: ApiTarget[], auth: Record<string, string>, add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void): Promise<void> {
    const t = targets.find((x) => x.method.toUpperCase() === 'GET') ?? targets[0];
    if (!t) return;
    const path = fillPath(t.path, t.sample);
    const evil = 'https://eztest-evil.example';
    const r = await this.send('GET', path, { headers: { ...auth, origin: evil }, query: t.sample });
    const acao = r.headers['access-control-allow-origin'];
    const acac = (r.headers['access-control-allow-credentials'] ?? '').toLowerCase() === 'true';
    if (acao === '*' && acac) {
      add({ id: 'cors-wildcard-credentials', probe: 'cors', owasp: 'API8', severity: sev('high'), method: 'GET', url: path, message: `${t.path} returns Access-Control-Allow-Origin: * together with Allow-Credentials: true`, subject: 'cors', evidence: { request: this.reqLine('GET', path, ` Origin: ${evil}`), response: `ACAO: ${acao}, ACAC: true` } });
    } else if (acao === evil) {
      add({ id: 'cors-reflects-origin', probe: 'cors', owasp: 'API8', severity: sev(acac ? 'high' : 'medium'), method: 'GET', url: path, message: `${t.path} reflects an arbitrary Origin in Access-Control-Allow-Origin${acac ? ' with credentials' : ''}`, subject: 'cors', evidence: { request: this.reqLine('GET', path, ` Origin: ${evil}`), response: `ACAO: ${acao}${acac ? ', ACAC: true' : ''}` } });
    }
  }

  // ---- API8: verbose errors — a malformed request leaks a stack trace or framework internals
  private async verboseErrors(targets: ApiTarget[], auth: Record<string, string>, add: (f: Omit<ApiScanFinding, 'url'> & { url?: string }) => void): Promise<void> {
    const bad = "'\"<>)(%00";
    for (const t of targets.filter((x) => x.method.toUpperCase() === 'GET').slice(0, 5)) {
      // A malformed value in every parameter, so a handler that does not validate leaks its internals.
      const fuzzed = Object.fromEntries(Object.keys(t.sample ?? {}).map((k) => [k, bad]));
      const path = fillPath(t.path, { ...t.sample, ...fuzzed });
      const r = await this.send('GET', path, { headers: auth, query: { ...fuzzed, eztestBad: bad } });
      const sig = ERROR_SIGNATURES.find((s) => s.re.test(r.body));
      if (sig && r.status >= 400) {
        add({ id: 'verbose-error', probe: 'verboseErrors', owasp: 'API8', severity: sev('medium'), method: 'GET', url: path, message: `${t.path} leaks a ${sig.what} in an error response (${r.status})`, subject: t.path, evidence: { request: this.reqLine('GET', path, ' malformed'), response: this.respLine(r), detail: sig.what } });
        break;
      }
    }
  }
}

/** Run an authorization-matrix check as part of a scan (function-level authorization, API5). */
export { runAuthorizationMatrix };

export async function scanApiSecurity(cfg: ApiScanConfig, targets: ApiTarget[]): Promise<ApiScanReport> {
  return new ApiSecurityScanner(cfg).scan(targets);
}

// ---------------------------------------------------------------- readiness gate

export interface ApiSecurityGateInput {
  report: ApiScanReport;
  evidence: string[];
}

export interface ApiSecurityGateOutcome {
  status: 'pass' | 'fail' | 'no-data';
  summary: string;
  evidence: string[];
}

const SEV_ORDER: SecuritySeverity[] = ['info', 'low', 'medium', 'high'];

/** The apiSecurity readiness gate: fail when findings at or above `failOn` (default medium) exist. */
export function evaluateApiSecurityGate(input: ApiSecurityGateInput | undefined, failOn: SecuritySeverity = 'medium'): ApiSecurityGateOutcome {
  if (!input) return { status: 'no-data', summary: 'No API security scan was recorded (run `eztest api-scan --readiness`).', evidence: [] };
  const threshold = SEV_ORDER.indexOf(failOn);
  const blocking = input.report.findings.filter((f) => SEV_ORDER.indexOf(f.severity) >= threshold);
  if (blocking.length === 0) {
    return { status: 'pass', summary: `API security scan clean at/above ${failOn} (${input.report.findings.length} informational finding(s), ${input.report.targets} endpoints).`, evidence: input.evidence };
  }
  const byCat = [...new Set(blocking.map((f) => f.owasp))].map((c) => `${OWASP_API_2023[c]} x${blocking.filter((f) => f.owasp === c).length}`);
  return { status: 'fail', summary: `API security scan found ${blocking.length} finding(s) at/above ${failOn}: ${byCat.join('; ')}.`, evidence: input.evidence };
}

/** Markdown summary of a scan report (for the CLI and the HTML report). */
export function apiScanMarkdown(r: ApiScanReport): string {
  const out: string[] = [
    `# API security scan — ${r.baseUrl}`, '',
    `Endpoints: ${r.targets} · Probes: ${r.probes.join(', ')} · Findings: ${r.findings.length} (high ${r.counts.high}, medium ${r.counts.medium}, low ${r.counts.low}, info ${r.counts.info})`, '',
  ];
  if (r.findings.length) {
    out.push('| Severity | OWASP | Probe | Method | Endpoint | Finding |', '|---|---|---|---|---|---|');
    for (const f of [...r.findings].sort((a, b) => SEV_ORDER.indexOf(b.severity) - SEV_ORDER.indexOf(a.severity))) {
      out.push(`| ${f.severity} | ${OWASP_API_2023[f.owasp]} | ${f.probe} | ${f.method} | \`${f.url || f.subject || ''}\` | ${f.message.replace(/\|/g, '\\|')} |`);
    }
  } else out.push('No findings.');
  if (r.skipped.length) out.push('', '## Probes not run', '', ...r.skipped.map((s) => `- ${s.probe}: ${s.reason}`));
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- run recording

export const API_SECURITY_FILE = 'api-security.json';

/** Write a scan report into the run directory, recorded as evidence so the gate can cite it. */
export async function recordApiSecurityScan(runDir: string, report: ApiScanReport): Promise<string> {
  const vault = await EvidenceVault.resume(runDir);
  const ref = await vault.store('report', `security/api-scan-${Date.now()}.json`, JSON.stringify(report, null, 2), { description: `API security scan of ${report.baseUrl}` });
  await writeFile(join(runDir, API_SECURITY_FILE), JSON.stringify({ ...report, evidenceId: ref.id }, null, 2));
  return ref.id;
}

/** Read the scan report recorded for a run (for the readiness gate). */
export async function apiSecurityReadinessInput(runDir: string, evidence: EvidenceRef[]): Promise<ApiSecurityGateInput | undefined> {
  const p = join(runDir, API_SECURITY_FILE);
  if (!existsSync(p)) return undefined;
  try {
    const doc = JSON.parse(await readFile(p, 'utf8')) as ApiScanReport & { evidenceId?: string };
    const { evidenceId, ...report } = doc;
    return { report, evidence: evidenceId && evidence.some((e) => e.id === evidenceId) ? [evidenceId] : [] };
  } catch {
    return undefined;
  }
}
