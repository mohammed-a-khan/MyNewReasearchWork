/**
 * Automatic correlation and user-path generation from captured traffic
 * (EZTest run network logs, browser recordings through EZTest's driver, or
 * HAR files). Dynamic values that a response produces and later requests
 * send back (session ids, CSRF tokens, ASP.NET ViewState, JSF ViewState,
 * OAuth tokens, ids in URLs...) become extractors on the producing request
 * and `${variables}` in the requests that use them, so no session value is
 * hard-coded.
 *
 * Detection runs in this order:
 *   1. rules: framework rule packs (ASP.NET, JSF, Salesforce, Dynamics 365,
 *      SAP, generic CSRF/OAuth/session) plus the project's own rules (the
 *      rule editor);
 *   2. heuristics: JSON leaves that look dynamic, ids, hidden form tokens,
 *      token-like response headers.
 * Remaining credentials become `${env.NAME}` variables.
 */
import { EzTestError } from '../core/index.js';
import { entryDuration, entryStart, normalizeNetworkLog, type NetworkEntry } from '../perf/network.js';
import type { CorrelationRuleSpec, Extractor } from './model.js';
import { globMatch } from './sla.js';

export interface CorrelationFound {
  variable: string;
  /** Index of the producing request (after filtering). */
  sourceRequest: number;
  kind: 'json' | 'header' | 'regex' | 'boundary' | 'cookie';
  expression: string;
  /** Rule or heuristic that found it. */
  rule: string;
  framework?: string;
  usedBy: number[];
  preview: string;
}

export interface GeneratedUserPath {
  /** The user path document (EZTest Load YAML shape). */
  path: { description?: string; source?: string; actions: unknown[]; thinkTime?: unknown };
  baseUrl: string;
  correlations: CorrelationFound[];
  /** Candidates seen but not used (assistant view). */
  candidates: Array<{ value: string; source: number; rule: string; reason: string }>;
  requests: number;
  transactions: string[];
  warnings: string[];
  /** Environment variables the path expects (credentials found in the capture). */
  env: string[];
}

export interface GenerateOptions {
  name?: string;
  includeStatic?: boolean;
  /** Use recorded gaps between pages as think time (default true), bounded by min/max seconds. */
  thinkTime?: { min?: number; max?: number; fixed?: number; recorded?: boolean };
  /** Framework rule packs to apply (default: all). */
  frameworks?: string[];
  /** Project rules (the rule editor). */
  rules?: CorrelationRuleSpec[];
  /** Values to parameterize from a data set: { "<literal>": "users.username" }. */
  parameters?: Record<string, string>;
  /** Variables to replace literals with env: { "<literal>": "ENV_NAME" }. */
  env?: Record<string, string>;
  minValueLength?: number;
  /** Disable heuristics, rules only. */
  rulesOnly?: boolean;
  /** Candidate values (by preview or variable) to skip. */
  exclude?: string[];
}

type Part = { lit: string } | { expr: string };

const STATIC_RE = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot)(?:\?|$)/i;
const SENSITIVE_KEY = /^(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access_token|refresh_token|id_token|token|otp|totp)$/i;
const SENSITIVE_HEADER = /^(?:authorization|x-api-key|api-key|x-auth-token|proxy-authorization)$/i;
const DROP_HEADERS = /^(?:cookie|host|content-length|connection|accept-encoding|user-agent|origin|referer|sec-.*|:.*|upgrade-insecure-requests|cache-control|pragma|priority)$/i;
const ID_KEY = /(?:^id$|_id$|Id$|ID$|^uuid$|number$)/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `<input ... name="NAME" ... value="(...)">` in either attribute order. */
export function hiddenInputRegex(name: string): string {
  const n = esc(name);
  return `<input(?=[^>]*name=["']${n}["'])[^>]*value=["']([^"']*)["']`;
}

// ------------------------------------------------------------------ framework rule packs

export const FRAMEWORK_RULES: Record<string, CorrelationRuleSpec[]> = {
  aspnet: [
    { name: 'ASP.NET __VIEWSTATE', from: 'body', regex: hiddenInputRegex('__VIEWSTATE'), var: 'viewState', enabled: true, framework: 'aspnet' },
    { name: 'ASP.NET __VIEWSTATEGENERATOR', from: 'body', regex: hiddenInputRegex('__VIEWSTATEGENERATOR'), var: 'viewStateGenerator', enabled: true, framework: 'aspnet' },
    { name: 'ASP.NET __EVENTVALIDATION', from: 'body', regex: hiddenInputRegex('__EVENTVALIDATION'), var: 'eventValidation', enabled: true, framework: 'aspnet' },
    { name: 'ASP.NET __RequestVerificationToken', from: 'body', regex: hiddenInputRegex('__RequestVerificationToken'), var: 'requestVerificationToken', enabled: true, framework: 'aspnet' },
    { name: 'ASP.NET UpdatePanel ViewState', from: 'body', regex: '\\|hiddenField\\|__VIEWSTATE\\|([^|]*)\\|', var: 'viewState', enabled: true, framework: 'aspnet' },
  ],
  jsf: [
    { name: 'JSF ViewState', from: 'body', regex: '<input(?=[^>]*name=["\'](?:javax|jakarta)\\.faces\\.ViewState["\'])[^>]*value=["\']([^"\']*)["\']', var: 'jsfViewState', enabled: true, framework: 'jsf' },
    { name: 'JSF partial ViewState', from: 'body', regex: '<update id="[^"]*(?:javax|jakarta)\\.faces\\.ViewState[^"]*"><!\\[CDATA\\[([^\\]]*)\\]\\]>', var: 'jsfViewState', enabled: true, framework: 'jsf' },
    { name: 'JSF ClientWindow', from: 'body', regex: hiddenInputRegex('javax.faces.ClientWindow'), var: 'jsfClientWindow', enabled: true, framework: 'jsf' },
  ],
  salesforce: [
    { name: 'Visualforce ViewState', from: 'body', regex: hiddenInputRegex('com.salesforce.visualforce.ViewState'), var: 'sfViewState', enabled: true, framework: 'salesforce' },
    { name: 'Visualforce ViewStateVersion', from: 'body', regex: hiddenInputRegex('com.salesforce.visualforce.ViewStateVersion'), var: 'sfViewStateVersion', enabled: true, framework: 'salesforce' },
    { name: 'Visualforce ViewStateMAC', from: 'body', regex: hiddenInputRegex('com.salesforce.visualforce.ViewStateMAC'), var: 'sfViewStateMac', enabled: true, framework: 'salesforce' },
    { name: 'Visualforce ViewStateCSRF', from: 'body', regex: hiddenInputRegex('com.salesforce.visualforce.ViewStateCSRF'), var: 'sfViewStateCsrf', enabled: true, framework: 'salesforce' },
    { name: 'Lightning aura.token', from: 'body', regex: '"token"\\s*:\\s*"([^"]{20,})"', var: 'auraToken', enabled: true, framework: 'salesforce' },
    { name: 'Lightning fwuid', from: 'body', regex: '"fwuid"\\s*:\\s*"([^"]+)"', var: 'auraFwuid', enabled: true, framework: 'salesforce' },
    { name: 'Salesforce _CONFIRMATIONTOKEN', from: 'body', regex: hiddenInputRegex('_CONFIRMATIONTOKEN'), var: 'sfConfirmationToken', enabled: true, framework: 'salesforce' },
  ],
  d365: [
    { name: 'Dynamics 365 CRMWRPCToken', from: 'body', regex: 'CRMWRPCToken=([^&"\'\\\\]+)', var: 'crmWrpcToken', enabled: true, framework: 'd365' },
    { name: 'Dynamics 365 CRMWRPCTokenTimeStamp', from: 'body', regex: 'CRMWRPCTokenTimeStamp=(\\d+)', var: 'crmWrpcTokenTimeStamp', enabled: true, framework: 'd365' },
    { name: 'Dynamics 365 request verification token', from: 'body', regex: hiddenInputRegex('__RequestVerificationToken'), var: 'd365RequestVerificationToken', enabled: true, framework: 'd365' },
    { name: 'Dynamics 365 F&O session id', from: 'body', regex: '"(?:SessionId|sessionId)"\\s*:\\s*"([^"]+)"', var: 'foSessionId', enabled: true, framework: 'd365' },
  ],
  sap: [
    { name: 'SAP sap-contextid', from: 'body', regex: 'sap-contextid=([^&"\'\\s;]+)', var: 'sapContextId', enabled: true, framework: 'sap' },
    { name: 'SAP sap-wd-secure-id', from: 'body', regex: hiddenInputRegex('sap-wd-secure-id'), var: 'sapWdSecureId', enabled: true, framework: 'sap' },
    { name: 'SAP sap-login-XSRF', from: 'body', regex: hiddenInputRegex('sap-login-XSRF'), var: 'sapLoginXsrf', enabled: true, framework: 'sap' },
    { name: 'SAP OData x-csrf-token', from: 'header', header: 'x-csrf-token', var: 'sapCsrfToken', enabled: true, framework: 'sap' },
    { name: 'SAP Web Dynpro sap-wd-cltwndid', from: 'body', regex: 'sap-wd-cltwndid=([^&"\'\\s]+)', var: 'sapWdWindowId', enabled: true, framework: 'sap' },
  ],
  generic: [
    { name: 'CSRF meta tag', from: 'body', regex: '<meta(?=[^>]*name=["\'](?:csrf-token|_csrf|csrf)["\'])[^>]*content=["\']([^"\']+)["\']', var: 'csrfToken', enabled: true, framework: 'generic' },
    { name: 'CSRF hidden input', from: 'body', regex: '<input(?=[^>]*name=["\'][^"\']*(?:csrf|xsrf|authenticity_token)[^"\']*["\'])[^>]*value=["\']([^"\']+)["\']', var: 'csrfToken', enabled: true, framework: 'generic' },
    { name: 'CSRF response header', from: 'header', header: 'x-csrf-token', var: 'csrfHeader', enabled: true, framework: 'generic' },
    { name: 'XSRF cookie', from: 'cookie', header: 'XSRF-TOKEN', var: 'xsrfCookie', enabled: true, framework: 'generic' },
    { name: 'OAuth access_token', from: 'body', json: '$.access_token', var: 'accessToken', enabled: true, framework: 'generic' },
    { name: 'OAuth id_token', from: 'body', json: '$.id_token', var: 'idToken', enabled: true, framework: 'generic' },
    { name: 'OAuth refresh_token', from: 'body', json: '$.refresh_token', var: 'refreshToken', enabled: true, framework: 'generic' },
    { name: 'OAuth code in redirect', from: 'header', header: 'location', regex: '[?&]code=([^&#]+)', var: 'authCode', enabled: true, framework: 'generic' },
    { name: 'URL session id (jsessionid)', from: 'body', regex: ';jsessionid=([A-Za-z0-9._-]+)', var: 'jsessionid', enabled: true, framework: 'generic' },
  ],
};

export const FRAMEWORKS = Object.keys(FRAMEWORK_RULES);

// ------------------------------------------------------------------ parts

function substitute(parts: Part[], value: string, expr: string, wordBoundary: boolean): { parts: Part[]; n: number } {
  let n = 0;
  const out: Part[] = [];
  const re = new RegExp(wordBoundary ? `(?<![A-Za-z0-9_])${esc(value)}(?![A-Za-z0-9_])` : esc(value), 'g');
  for (const p of parts) {
    if (!('lit' in p)) {
      out.push(p);
      continue;
    }
    let last = 0;
    for (const m of p.lit.matchAll(re)) {
      out.push({ lit: p.lit.slice(last, m.index) });
      out.push({ expr });
      last = m.index! + m[0].length;
      n++;
    }
    out.push({ lit: p.lit.slice(last) });
  }
  return { parts: out, n };
}

function joinParts(parts: Part[]): string {
  return parts.map((p) => ('lit' in p ? p.lit : `\${${p.expr}}`)).join('');
}

function jsonPathOf(path: Array<string | number>): string {
  return '$' + path.map((p) => (typeof p === 'number' ? `[${p}]` : /^[A-Za-z_$][\w$-]*$/.test(p) ? `.${p}` : `['${p.replace(/'/g, "\\'")}']`)).join('');
}

function jsonLeaves(v: unknown, path: Array<string | number>, out: Array<{ path: Array<string | number>; value: string | number; key: string }>, depth = 0): void {
  if (depth > 12 || out.length > 5000) return;
  if (Array.isArray(v)) v.forEach((x, i) => jsonLeaves(x, [...path, i], out, depth + 1));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) jsonLeaves(x, [...path, k], out, depth + 1);
  else if (typeof v === 'string' || typeof v === 'number') out.push({ path, value: v, key: String([...path].reverse().find((p) => typeof p === 'string') ?? '') });
}

function looksDynamic(s: string, minLen: number): boolean {
  if (s.length < minLen || s.length > 8192) return false;
  if (/^(?:true|false|null|bearer|basic|ok|success|application\/json)$/i.test(s)) return false;
  if (/\s/.test(s) && s.length < 40) return false;
  return /\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s)) || /[-_.~+/=]/.test(s);
}

interface Candidate {
  value: string;
  source: number;
  kind: CorrelationFound['kind'];
  expression: string;
  numeric: boolean;
  rule: string;
  framework?: string;
  var?: string;
  extractor: Extractor;
}

function headerList(h: Record<string, string> | undefined, name: string): string[] {
  const v = h?.[name.toLowerCase()];
  return v === undefined ? [] : v.split(/\n/);
}

function applyRule(rule: CorrelationRuleSpec, e: NetworkEntry, i: number): Candidate[] {
  if (!rule.enabled) return [];
  if (rule.urlMatch && !globMatch(rule.urlMatch, e.url)) return [];
  const out: Candidate[] = [];
  const base = { source: i, numeric: false, rule: rule.name, framework: rule.framework, var: rule.var };
  if (rule.from === 'cookie') {
    const name = rule.header ?? '';
    for (const line of headerList(e.responseHeaders, 'set-cookie')) {
      const kv = line.split(';')[0];
      if (kv.startsWith(`${name}=`) && kv.length > name.length + 1) {
        const value = kv.slice(name.length + 1);
        out.push({ ...base, value, kind: 'cookie', expression: name, extractor: { var: '', from: 'cookie', name } });
      }
    }
    return out;
  }
  const texts = rule.from === 'header' ? headerList(e.responseHeaders, rule.header ?? '') : e.responseBody ? [e.responseBody] : [];
  for (const t of texts) {
    if (rule.json) {
      try {
        const leaves: Array<{ path: Array<string | number>; value: string | number; key: string }> = [];
        jsonLeaves(JSON.parse(t), [], leaves);
        const want = rule.json.replace(/^\$\.?/, '');
        for (const l of leaves) {
          const p = jsonPathOf(l.path).replace(/^\$\.?/, '');
          if (p === want || p.endsWith(`.${want}`)) out.push({ ...base, value: String(l.value), kind: 'json', expression: jsonPathOf(l.path), extractor: { var: '', from: 'body', json: jsonPathOf(l.path) } });
        }
      } catch {
        // not JSON
      }
    } else if (rule.regex) {
      for (const m of t.matchAll(new RegExp(rule.regex, 'g'))) {
        if (m[1] !== undefined && m[1].length >= 3) {
          out.push({ ...base, value: m[1], kind: 'regex', expression: rule.regex, extractor: rule.from === 'header' ? { var: '', from: 'header', name: rule.header, regex: rule.regex } : { var: '', from: 'body', regex: rule.regex } });
        }
      }
    } else if (rule.boundary) {
      const re = new RegExp(`${esc(rule.boundary.left)}([\\s\\S]*?)${esc(rule.boundary.right)}`, 'g');
      for (const m of t.matchAll(re)) if (m[1]) out.push({ ...base, value: m[1], kind: 'boundary', expression: `${rule.boundary.left}…${rule.boundary.right}`, extractor: { var: '', from: rule.from === 'header' ? 'header' : 'body', name: rule.header, boundary: rule.boundary } });
    } else if (rule.from === 'header' && t.length >= 3) {
      out.push({ ...base, value: t, kind: 'header', expression: rule.header ?? '', extractor: { var: '', from: 'header', name: rule.header } });
    }
  }
  return out;
}

function heuristics(entries: NetworkEntry[], minLen: number): Candidate[] {
  const out: Candidate[] = [];
  entries.forEach((e, i) => {
    const ct = e.responseHeaders?.['content-type'] ?? '';
    const body = e.responseBody;
    if (body) {
      let parsed: unknown;
      let isJson = false;
      if (/json/i.test(ct) || /^\s*[[{]/.test(body)) {
        try {
          parsed = JSON.parse(body);
          isJson = true;
        } catch {
          /* not json */
        }
      }
      if (isJson) {
        const leaves: Array<{ path: Array<string | number>; value: string | number; key: string }> = [];
        jsonLeaves(parsed, [], leaves);
        for (const l of leaves) {
          const expression = jsonPathOf(l.path);
          if (typeof l.value === 'number') {
            if (Number.isInteger(l.value) && l.value > 0 && ID_KEY.test(l.key)) out.push({ value: String(l.value), source: i, kind: 'json', expression, numeric: true, rule: 'JSON id', extractor: { var: '', from: 'body', json: expression } });
          } else if (looksDynamic(l.value, minLen)) out.push({ value: l.value, source: i, kind: 'json', expression, numeric: false, rule: 'JSON value', extractor: { var: '', from: 'body', json: expression } });
        }
      } else if (/html/i.test(ct) || /<html|<form|<meta/i.test(body)) {
        for (const m of body.matchAll(/<input(?=[^>]*type=["']hidden["'])[^>]*>/gi)) {
          const name = /name=["']([^"']+)["']/i.exec(m[0])?.[1];
          const value = /value=["']([^"']*)["']/i.exec(m[0])?.[1];
          if (name && value && value.length >= 4 && looksDynamic(value, 4)) out.push({ value, source: i, kind: 'regex', expression: hiddenInputRegex(name), numeric: false, rule: `hidden input ${name}`, var: name.replace(/[^\w]+/g, '_'), extractor: { var: '', from: 'body', regex: hiddenInputRegex(name) } });
        }
      }
    }
    for (const [h, v] of Object.entries(e.responseHeaders ?? {})) {
      if (/csrf|xsrf|token|session-id|request-id/i.test(h) && !/^set-cookie$/i.test(h) && looksDynamic(v, minLen)) out.push({ value: v, source: i, kind: 'header', expression: h, numeric: false, rule: `header ${h}`, extractor: { var: '', from: 'header', name: h } });
    }
    const loc = e.responseHeaders?.location;
    if (loc) {
      for (const m of loc.matchAll(/\/(\d{2,})(?=\/|$|\?)/g)) out.push({ value: m[1], source: i, kind: 'regex', expression: `Location id`, numeric: true, rule: 'id in redirect', extractor: { var: '', from: 'header', name: 'location', regex: `/(${'\\d+'})(?=/|$|\\?)` } });
    }
  });
  return out;
}

function requestTexts(e: NetworkEntry): string[] {
  return [e.url, e.requestBody ?? '', ...Object.entries(e.requestHeaders ?? {}).filter(([k]) => !DROP_HEADERS.test(k)).map(([, v]) => v)];
}

const isForm = (e: NetworkEntry) => /x-www-form-urlencoded/i.test(e.requestHeaders?.['content-type'] ?? '');
const urlPathAndQuery = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');

function pathTemplate(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/{uuid}');
  } catch {
    return url;
  }
}

/** Generate a correlated user path from captured traffic. */
export function generateUserPath(input: NetworkEntry[] | unknown, opts: GenerateOptions = {}): GeneratedUserPath {
  const all = normalizeNetworkLog(input);
  const entries = all.filter((e) => e.status !== 0 && (opts.includeStatic || !STATIC_RE.test(new URL(e.url, 'http://x').pathname)));
  if (!entries.length) throw new EzTestError('no requests to turn into a user path', 'INVALID_INPUT');
  const minLen = opts.minValueLength ?? 6;
  const warnings: string[] = [];
  if (all.length !== entries.length) warnings.push(`${all.length - entries.length} static/failed request(s) skipped`);
  const env = new Set<string>();

  const origins = new Map<string, number>();
  for (const e of entries) origins.set(new URL(e.url).origin, (origins.get(new URL(e.url).origin) ?? 0) + 1);
  const baseOrigin = [...origins.entries()].sort((a, b) => b[1] - a[1])[0][0];

  type Req = { url: Part[]; body: Part[] | null; headers: Array<[string, Part[]]>; extract: Extractor[] };
  const reqs: Req[] = entries.map((e) => ({
    url: [{ lit: e.url.startsWith(baseOrigin) ? e.url.slice(baseOrigin.length) || '/' : e.url }],
    headers: Object.entries(e.requestHeaders ?? {}).filter(([k]) => !DROP_HEADERS.test(k)).map(([k, v]) => [k, [{ lit: v }]]),
    body: e.requestBody !== undefined && e.requestBody !== '' ? [{ lit: e.requestBody }] : null,
    extract: [],
  }));

  const applyEverywhere = (fromIdx: number, value: string, variable: string, wordBoundary: boolean, urlOnly = false): number[] => {
    const used: number[] = [];
    const enc = encodeURIComponent(value);
    const formEnc = enc.replace(/%20/g, '+');
    for (let j = fromIdx; j < reqs.length; j++) {
      const r = reqs[j];
      let n = 0;
      const sub = (parts: Part[], form: boolean) => {
        let res = substitute(parts, value, form ? `__urlencode(${variable})` : variable, wordBoundary);
        n += res.n;
        for (const alt of form ? [enc, formEnc] : [enc]) {
          if (alt === value) continue;
          res = substitute(res.parts, alt, `__urlencode(${variable})`, wordBoundary);
          n += res.n;
        }
        return res.parts;
      };
      r.url = sub(r.url, false);
      if (!urlOnly) {
        if (r.body) r.body = sub(r.body, isForm(entries[j]));
        r.headers = r.headers.map(([k, v]) => [k, sub(v, false)]);
      }
      if (n) used.push(j);
    }
    return used;
  };

  for (const [literal, path] of Object.entries(opts.parameters ?? {})) {
    if (literal && !applyEverywhere(0, literal, path, false).length) warnings.push(`parameter ${path}: "${literal.slice(0, 3)}…" not found in any request`);
  }
  for (const [literal, name] of Object.entries(opts.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new EzTestError(`Invalid environment variable name ${name}`, 'INVALID_INPUT');
    if (literal && applyEverywhere(0, literal, `env.${name}`, false).length) env.add(name);
  }

  const frameworks = opts.frameworks ?? FRAMEWORKS;
  const rules = [...frameworks.flatMap((f) => FRAMEWORK_RULES[f] ?? []), ...(opts.rules ?? [])];
  const ruled: Candidate[] = [];
  entries.forEach((e, i) => {
    for (const r of rules) ruled.push(...applyRule(r, e, i));
  });
  const heur = opts.rulesOnly ? [] : heuristics(entries, minLen).sort((a, b) => b.value.length - a.value.length || a.source - b.source);
  const correlations: CorrelationFound[] = [];
  const candidates: GeneratedUserPath['candidates'] = [];
  const taken = new Set<string>();
  const varNames = new Set<string>();
  const exclude = new Set(opts.exclude ?? []);
  for (const c of [...ruled, ...heur]) {
    const preview = c.value.length > 8 ? `${c.value.slice(0, 3)}...(${c.value.length} chars)` : c.numeric ? c.value : '***';
    if (taken.has(c.value)) continue;
    if (exclude.has(c.rule) || exclude.has(preview)) {
      candidates.push({ value: preview, source: c.source, rule: c.rule, reason: 'excluded' });
      continue;
    }
    const numRe = new RegExp(`(?<![A-Za-z0-9_.])${esc(c.value)}(?![A-Za-z0-9_])`);
    // The client sent it before the response produced it: an input, not a dynamic value.
    if (entries.slice(0, c.source + 1).some((e) => (c.numeric ? numRe.test(urlPathAndQuery(e.url)) : requestTexts(e).some((t) => t.includes(c.value))))) {
      candidates.push({ value: preview, source: c.source, rule: c.rule, reason: 'sent by the client before' });
      continue;
    }
    const later = entries.slice(c.source + 1).some((e) => (c.numeric ? numRe.test(urlPathAndQuery(e.url)) : requestTexts(e).some((t) => t.includes(c.value) || t.includes(encodeURIComponent(c.value)) || t.includes(encodeURIComponent(c.value).replace(/%20/g, '+')))));
    if (!later) {
      candidates.push({ value: preview, source: c.source, rule: c.rule, reason: 'not used by a later request' });
      continue;
    }
    let variable = (c.var ?? `corr_${correlations.length + 1}`).replace(/[^\w]/g, '_');
    if (varNames.has(variable)) variable = `${variable}_${correlations.length + 1}`;
    const usedBy = applyEverywhere(c.source + 1, c.value, variable, c.numeric, c.numeric);
    if (!usedBy.length) continue;
    taken.add(c.value);
    varNames.add(variable);
    reqs[c.source].extract.push({ ...c.extractor, var: variable });
    correlations.push({ variable, sourceRequest: c.source, kind: c.kind, expression: c.expression, rule: c.rule, framework: c.framework, usedBy, preview });
  }

  // remaining hard-coded credentials -> ${env.NAME}
  const envFor = (name: string) => `EZ_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  reqs.forEach((r, i) => {
    r.headers = r.headers.map(([k, v]) => {
      if (SENSITIVE_HEADER.test(k) && v.some((p) => 'lit' in p && /\S{6,}/.test(p.lit.replace(/^(Bearer|Basic|Negotiate|NTLM)\s+/i, '')))) {
        const scheme = /^(Bearer|Basic)\s+/i.exec(v.find((p): p is { lit: string } => 'lit' in p)?.lit ?? '')?.[1];
        env.add(envFor(k));
        warnings.push(`request ${i}: header ${k} had a hard-coded value no earlier response produced; using \${env.${envFor(k)}}`);
        return [k, scheme ? [{ lit: `${scheme} ` }, { expr: `env.${envFor(k)}` }] : [{ expr: `env.${envFor(k)}` }]];
      }
      return [k, v];
    });
    if (r.body && r.body.length === 1 && 'lit' in r.body[0]) {
      const text = r.body[0].lit;
      const ct = entries[i].requestHeaders?.['content-type'] ?? '';
      if (/x-www-form-urlencoded/i.test(ct) || (!/json/i.test(ct) && /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(text))) {
        const parts: Part[] = [];
        text.split('&').forEach((pair, k) => {
          if (k > 0) parts.push({ lit: '&' });
          const eq = pair.indexOf('=');
          const key = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
          if (eq >= 0 && SENSITIVE_KEY.test(key) && pair.slice(eq + 1) !== '') {
            env.add(envFor(key));
            parts.push({ lit: pair.slice(0, eq + 1) }, { expr: `__urlencode(env.${envFor(key)})` });
            warnings.push(`request ${i}: form field "${key}" taken from \${env.${envFor(key)}}`);
          } else parts.push({ lit: pair });
        });
        r.body = parts;
      } else if (/json/i.test(ct) || /^\s*\{/.test(text)) {
        try {
          const leaves: Array<{ path: Array<string | number>; value: string | number; key: string }> = [];
          jsonLeaves(JSON.parse(text), [], leaves);
          let parts: Part[] = [{ lit: text }];
          for (const l of leaves) {
            if (typeof l.value === 'string' && SENSITIVE_KEY.test(l.key) && l.value.length > 0) {
              const res = substitute(parts, JSON.stringify(l.value), `"\${env.${envFor(l.key)}}"`, false);
              parts = res.parts.map((p) => ('expr' in p && p.expr.startsWith('"${') ? { lit: p.expr } : p));
              if (res.n) {
                env.add(envFor(l.key));
                warnings.push(`request ${i}: JSON field "${l.key}" taken from \${env.${envFor(l.key)}}`);
              }
            }
          }
          r.body = parts;
        } catch {
          /* leave as is */
        }
      }
    }
  });

  // transactions (one per page/step group) and think times
  const groupOf = (e: NetworkEntry) => e.group ?? e.stepId ?? 'journey';
  const blocks: Array<{ name: string; idx: number[] }> = [];
  entries.forEach((e, i) => {
    const g = groupOf(e);
    const last = blocks[blocks.length - 1];
    if (last && last.name === g) last.idx.push(i);
    else blocks.push({ name: g, idx: [i] });
  });
  const tmin = opts.thinkTime?.min ?? 0.5;
  const tmax = opts.thinkTime?.max ?? 10;
  const think = (b: number): number | undefined => {
    if (b >= blocks.length - 1) return undefined;
    if (opts.thinkTime?.fixed !== undefined) return opts.thinkTime.fixed;
    if (opts.thinkTime?.recorded === false) return undefined;
    const lastE = entries[blocks[b].idx[blocks[b].idx.length - 1]];
    const nextE = entries[blocks[b + 1].idx[0]];
    const gap = ((entryStart(nextE) ?? NaN) - ((entryStart(lastE) ?? NaN) + (entryDuration(lastE) ?? 0))) / 1000;
    if (!Number.isFinite(gap)) return 1;
    return Math.round(Math.min(tmax, Math.max(tmin, gap)) * 100) / 100;
  };

  const actions: unknown[] = [];
  const usedNames = new Map<string, number>();
  blocks.forEach((b, bi) => {
    const inner = b.idx.map((i) => {
      const e = entries[i];
      const r = reqs[i];
      let name = `${e.method} ${pathTemplate(e.url)}`;
      const seen = usedNames.get(name) ?? 0;
      usedNames.set(name, seen + 1);
      if (seen) name = `${name} #${seen + 1}`;
      const spec: Record<string, unknown> = { name, method: e.method, url: joinParts(r.url) };
      if (r.headers.length) spec.headers = Object.fromEntries(r.headers.map(([k, v]) => [k, joinParts(v)]));
      if (r.body) spec.body = joinParts(r.body);
      spec.followRedirects = false;
      spec.assert = [{ status: e.status }];
      if (r.extract.length) spec.extract = r.extract;
      return { request: spec };
    });
    actions.push({ transaction: { name: b.name, actions: inner } });
    const t = think(bi);
    if (t !== undefined) actions.push({ think: `${t}s` });
  });

  return {
    path: { description: opts.name ? `Generated from ${opts.name}` : 'Generated from captured traffic', source: opts.name, actions },
    baseUrl: baseOrigin,
    correlations,
    candidates,
    requests: entries.length,
    transactions: blocks.map((b) => b.name),
    warnings,
    env: [...env],
  };
}
