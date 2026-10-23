/**
 * Security lens: response header checks, cookie flags, mixed content, an
 * authorization matrix runner and a simple IDOR probe. Tokens are only ever
 * placed in request headers; they never appear in results or errors.
 */
import type { Page, Response } from '../browser/index.js';
import { EzTestError } from '../core/index.js';
import { storeLensEvidence, type Lens, type LensContext, type LensResult, type LensStep } from './lens.js';

export type SecuritySeverity = 'high' | 'medium' | 'low' | 'info';

export interface SecurityFinding {
  id: string;
  severity: SecuritySeverity;
  message: string;
  url: string;
  subject?: string;
}

const SEV_ORDER: SecuritySeverity[] = ['info', 'low', 'medium', 'high'];

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}

// ------------------------------------------------------------- headers

export interface HeaderCheckInput {
  url: string;
  headers: Record<string, string>;
  contentType?: string;
}

export function checkSecurityHeaders(input: HeaderCheckInput): SecurityFinding[] {
  const h = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const url = stripQuery(input.url);
  const https = url.startsWith('https:');
  const isHtml = /html/i.test(input.contentType ?? h['content-type'] ?? 'text/html');
  const out: SecurityFinding[] = [];
  const add = (id: string, severity: SecuritySeverity, message: string, subject?: string) => out.push({ id, severity, message, url, subject });
  const csp = h['content-security-policy'];
  if (isHtml) {
    if (!csp) add('csp-missing', 'medium', 'Content-Security-Policy header is missing', 'content-security-policy');
    else {
      const scriptSrc = /(?:^|;)\s*script-src\s+([^;]*)/i.exec(csp)?.[1] ?? /(?:^|;)\s*default-src\s+([^;]*)/i.exec(csp)?.[1] ?? '';
      if (/'unsafe-inline'/.test(scriptSrc) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(scriptSrc)) add('csp-unsafe-inline', 'low', "CSP allows 'unsafe-inline' scripts", 'content-security-policy');
      if (/'unsafe-eval'/.test(scriptSrc)) add('csp-unsafe-eval', 'low', "CSP allows 'unsafe-eval'", 'content-security-policy');
    }
    const xfo = h['x-frame-options'];
    const frameAncestors = csp && /frame-ancestors/i.test(csp);
    if (!frameAncestors && !(xfo && /^(deny|sameorigin)$/i.test(xfo.trim()))) {
      add('frame-protection-missing', 'medium', 'No clickjacking protection (X-Frame-Options DENY/SAMEORIGIN or CSP frame-ancestors)', 'x-frame-options');
    }
  }
  if ((h['x-content-type-options'] ?? '').trim().toLowerCase() !== 'nosniff') {
    add('xcto-missing', 'medium', 'X-Content-Type-Options: nosniff is missing', 'x-content-type-options');
  }
  if (https) {
    const hsts = h['strict-transport-security'];
    if (!hsts) add('hsts-missing', 'high', 'Strict-Transport-Security is missing on an HTTPS response', 'strict-transport-security');
    else {
      const age = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
      if (age < 15552000) add('hsts-short', 'low', `HSTS max-age ${age} is below 180 days`, 'strict-transport-security');
    }
  }
  for (const k of ['server', 'x-powered-by', 'x-aspnet-version']) {
    if (h[k] && /\d/.test(h[k])) add('version-disclosure', 'info', `${k} header discloses a version`, k);
  }
  return out;
}

// ------------------------------------------------------------- cookies

export interface CookieInfo {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Cookie set by the response, or present in the browser context. */
  source: 'set-cookie' | 'browser';
}

export function parseSetCookie(header: string): CookieInfo {
  const [pair, ...attrs] = header.split(';').map((s) => s.trim());
  const name = pair.split('=')[0].trim();
  if (!name) throw new EzTestError('Malformed Set-Cookie header', 'INVALID_INPUT');
  const lower = attrs.map((a) => a.toLowerCase());
  const ss = lower.find((a) => a.startsWith('samesite='))?.split('=')[1];
  return {
    name,
    httpOnly: lower.includes('httponly'),
    secure: lower.includes('secure'),
    sameSite: ss === 'strict' ? 'Strict' : ss === 'lax' ? 'Lax' : ss === 'none' ? 'None' : undefined,
    source: 'set-cookie',
  };
}

const SESSIONISH = /sess|sid|auth|token|jwt|login|remember/i;

export function checkCookies(cookies: CookieInfo[], url: string): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const https = url.startsWith('https:');
  const u = stripQuery(url);
  for (const c of cookies) {
    const sensitive = SESSIONISH.test(c.name);
    if (!c.httpOnly) out.push({ id: 'cookie-no-httponly', severity: sensitive ? 'high' : 'low', message: `Cookie ${c.name} lacks HttpOnly`, url: u, subject: c.name });
    if (https && !c.secure) out.push({ id: 'cookie-no-secure', severity: sensitive ? 'high' : 'medium', message: `Cookie ${c.name} lacks Secure on HTTPS`, url: u, subject: c.name });
    if (!c.sameSite) out.push({ id: 'cookie-no-samesite', severity: 'low', message: `Cookie ${c.name} has no explicit SameSite`, url: u, subject: c.name });
    else if (c.sameSite === 'None' && !c.secure) out.push({ id: 'cookie-samesite-none-insecure', severity: 'medium', message: `Cookie ${c.name} is SameSite=None without Secure`, url: u, subject: c.name });
  }
  return out;
}

// ------------------------------------------------------------- mixed content

export function findMixedContent(pageUrl: string, resourceUrls: string[]): SecurityFinding[] {
  if (!pageUrl.startsWith('https:')) return [];
  return resourceUrls
    .filter((r) => r.startsWith('http:'))
    .map((r) => ({ id: 'mixed-content', severity: 'high' as const, message: `HTTPS page loads insecure resource ${stripQuery(r)}`, url: stripQuery(pageUrl), subject: stripQuery(r) }));
}

// ------------------------------------------------------------- page scan

export interface SecurityScanResult {
  url: string;
  findings: SecurityFinding[];
  counts: Record<SecuritySeverity, number>;
}

/** Scan a page using its main document response (or re-fetch the current URL with the page's cookies). */
export async function scanPageSecurity(page: Page, response?: Response | null): Promise<SecurityScanResult> {
  const url = page.url();
  if (!/^https?:/.test(url)) throw new EzTestError(`scanPageSecurity: page is not on an http(s) URL (${url})`, 'INVALID_INPUT');
  let headers: Record<string, string>;
  let setCookies: string[];
  if (response) {
    headers = await response.allHeaders();
    setCookies = (await response.headersArray()).filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
  } else {
    const r = await page.request.get(url, { maxRedirects: 0 });
    headers = r.headers();
    setCookies = r.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
    await r.dispose();
  }
  const browserCookies: CookieInfo[] = (await page.context().cookies(url)).map((c) => ({
    name: c.name,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
    source: 'browser' as const,
  }));
  const cookies = [...setCookies.map(parseSetCookie), ...browserCookies.filter((b) => !setCookies.some((s) => parseSetCookie(s).name === b.name))];
  const resources = (await page.evaluate('performance.getEntriesByType("resource").map(function (e) { return e.name; })')) as string[];
  const findings = [...checkSecurityHeaders({ url, headers }), ...checkCookies(cookies, url), ...findMixedContent(url, resources)];
  const counts: Record<SecuritySeverity, number> = { info: 0, low: 0, medium: 0, high: 0 };
  for (const f of findings) counts[f.severity]++;
  return { url: stripQuery(url), findings, counts };
}

export function createSecurityLens(opts: { failOn?: SecuritySeverity } = {}): Lens<SecurityScanResult> {
  const failOn = SEV_ORDER.indexOf(opts.failOn ?? 'high');
  return {
    name: 'security',
    async afterStep(page: Page, step: LensStep, ctx?: LensContext): Promise<LensResult<SecurityScanResult>> {
      const res = await scanPageSecurity(page);
      const blocking = res.findings.filter((f) => SEV_ORDER.indexOf(f.severity) >= failOn);
      return {
        lens: 'security',
        stepId: step.id,
        passed: blocking.length === 0,
        summary: `${res.findings.length} finding(s), ${blocking.length} at or above ${opts.failOn ?? 'high'}`,
        evidence: await storeLensEvidence(ctx, 'security', step, res),
        data: res,
      };
    },
  };
}

// ------------------------------------------------------------- authorization matrix

export type TokenProvider = () => Promise<string | undefined> | string | undefined;

export interface AuthzRole {
  name: string;
  /** Returns the bearer token, or undefined for an anonymous role. */
  token: TokenProvider;
  /** Build auth headers from the token. Default: Authorization: Bearer <token>. */
  authHeaders?: (token: string) => Record<string, string>;
}

export interface AuthzCase {
  name?: string;
  method?: string;
  path: string;
  body?: string;
  headers?: Record<string, string>;
  /** Expected outcome per role name. Every role must have an expectation. */
  expect: Record<string, 'allow' | 'deny'>;
}

export interface AuthzResult {
  case: string;
  role: string;
  method: string;
  path: string;
  expected: 'allow' | 'deny';
  status: number;
  actual: 'allow' | 'deny' | 'error';
  violation: boolean;
  severity: SecuritySeverity;
  detail?: string;
}

export interface AuthzMatrixOptions {
  baseUrl: string;
  roles: AuthzRole[];
  cases: AuthzCase[];
  /** Statuses that mean "denied". Default 401, 403, 404. */
  denyStatuses?: number[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AuthzMatrixReport {
  passed: boolean;
  results: AuthzResult[];
  violations: AuthzResult[];
}

async function send(
  f: typeof fetch,
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; error?: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(new URL(path, baseUrl).href, { method, headers, body, redirect: 'manual', signal: ac.signal });
    await res.arrayBuffer();
    return { status: res.status };
  } catch (e) {
    return { status: 0, error: (e as Error).name === 'AbortError' ? 'timeout' : 'request failed' };
  } finally {
    clearTimeout(t);
  }
}

async function headersFor(role: AuthzRole): Promise<Record<string, string>> {
  const tok = await role.token();
  if (tok === undefined || tok === '') return {};
  return role.authHeaders ? role.authHeaders(tok) : { authorization: `Bearer ${tok}` };
}

export async function runAuthorizationMatrix(opts: AuthzMatrixOptions): Promise<AuthzMatrixReport> {
  if (opts.roles.length === 0) throw new EzTestError('authorization matrix needs at least one role', 'INVALID_INPUT');
  if (opts.cases.length === 0) throw new EzTestError('authorization matrix needs at least one case', 'INVALID_INPUT');
  const names = new Set(opts.roles.map((r) => r.name));
  if (names.size !== opts.roles.length) throw new EzTestError('duplicate role names', 'INVALID_INPUT');
  for (const c of opts.cases) {
    for (const r of names) if (!(r in c.expect)) throw new EzTestError(`case ${c.name ?? c.path} has no expectation for role ${r}`, 'INVALID_INPUT');
    for (const r of Object.keys(c.expect)) if (!names.has(r)) throw new EzTestError(`case ${c.name ?? c.path} expects unknown role ${r}`, 'INVALID_INPUT');
  }
  const deny = new Set(opts.denyStatuses ?? [401, 403, 404]);
  const f = opts.fetchImpl ?? fetch;
  const results: AuthzResult[] = [];
  for (const role of opts.roles) {
    const auth = await headersFor(role);
    for (const c of opts.cases) {
      const method = (c.method ?? 'GET').toUpperCase();
      const r = await send(f, opts.baseUrl, method, c.path, { ...(c.headers ?? {}), ...auth }, c.body, opts.timeoutMs ?? 15_000);
      const actual: AuthzResult['actual'] = r.status === 0 || r.status >= 500 ? 'error' : deny.has(r.status) ? 'deny' : r.status < 400 ? 'allow' : 'deny';
      const expected = c.expect[role.name];
      const violation = actual !== expected;
      results.push({
        case: c.name ?? `${method} ${c.path}`,
        role: role.name,
        method,
        path: c.path,
        expected,
        status: r.status,
        actual,
        violation,
        severity: !violation ? 'info' : expected === 'deny' && actual === 'allow' ? 'high' : actual === 'error' ? 'medium' : 'low',
        detail: r.error,
      });
    }
  }
  const violations = results.filter((r) => r.violation);
  return { passed: violations.length === 0, results, violations };
}

// ------------------------------------------------------------- IDOR probe

export interface IdorUser {
  name: string;
  token: TokenProvider;
  /** Paths of resources this user owns, e.g. ["/api/orders/1"]. */
  resources: string[];
  authHeaders?: (token: string) => Record<string, string>;
}

export interface IdorFinding {
  path: string;
  owner: string;
  requester: string;
  ownerStatus: number;
  requesterStatus: number;
  verdict: 'vulnerable' | 'protected' | 'inconclusive';
}

/** Each user requests the other user's resources. Access to a resource the owner can read = IDOR. */
export async function probeIdor(opts: { baseUrl: string; users: [IdorUser, IdorUser]; method?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ vulnerable: boolean; findings: IdorFinding[] }> {
  const [a, b] = opts.users;
  if (!a.resources.length || !b.resources.length) throw new EzTestError('IDOR probe needs resources for both users', 'INVALID_INPUT');
  const f = opts.fetchImpl ?? fetch;
  const method = (opts.method ?? 'GET').toUpperCase();
  const t = opts.timeoutMs ?? 15_000;
  const ha = await headersFor({ name: a.name, token: a.token, authHeaders: a.authHeaders });
  const hb = await headersFor({ name: b.name, token: b.token, authHeaders: b.authHeaders });
  const findings: IdorFinding[] = [];
  for (const [owner, ownerH, other, otherH] of [
    [a, ha, b, hb],
    [b, hb, a, ha],
  ] as const) {
    for (const path of owner.resources) {
      const o = await send(f, opts.baseUrl, method, path, ownerH, undefined, t);
      const r = await send(f, opts.baseUrl, method, path, otherH, undefined, t);
      const ownerOk = o.status >= 200 && o.status < 300;
      const verdict: IdorFinding['verdict'] = !ownerOk || r.status === 0 || r.status >= 500 ? 'inconclusive' : r.status >= 200 && r.status < 300 ? 'vulnerable' : 'protected';
      findings.push({ path, owner: owner.name, requester: other.name, ownerStatus: o.status, requesterStatus: r.status, verdict });
    }
  }
  return { vulnerable: findings.some((x) => x.verdict === 'vulnerable'), findings };
}
