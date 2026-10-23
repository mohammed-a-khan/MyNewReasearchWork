/**
 * Postman Collection v2.0 / v2.1 -> .ez API journeys. Each top-level folder
 * (or the collection's own requests) becomes a journey; requests become API
 * steps with `{{var}}` rewritten to `${var}`, auth turned into headers that
 * reference variables (never literal secrets), and the common `pm.*` test
 * assertions turned into expectations. Script code that has no plain-English
 * equivalent is kept as a TODO line, never dropped silently. Postman
 * environment files become the journey's Variables header; secret values are
 * not copied (they become variables to be set from secret:// references).
 */
import { quoteText } from '../intent/quotes.js';
import { JourneyDraft } from './builder.js';
import { assembleReport } from './report.js';
import type { ImporterOptions, ImportReport } from './types.js';

type Json = Record<string, unknown>;

export interface PostmanImportOptions extends ImporterOptions {
  /** A Postman environment export (values become Variables; secret ones are left for secret:// references). */
  environment?: unknown;
}

/** {{var}} -> ${var}; Postman dynamic variables ({{$guid}}, {{$timestamp}}) -> EZ expressions. */
export function postmanVars(s: string): string {
  return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, name: string) => {
    if (name === '$guid' || name === '$randomUUID') return '${uuid()}';
    if (name === '$timestamp') return '${now()}';
    if (name === '$isoTimestamp') return '${now()}';
    if (name === '$randomInt') return '${random(0, 1000)}';
    return `\${${name.replace(/[^\w.]/g, '_')}}`;
  });
}

function urlOf(u: unknown): { url: string; query: Record<string, string> } {
  if (typeof u === 'string') return { url: postmanVars(u), query: {} };
  const o = (u ?? {}) as Json;
  let raw = typeof o.raw === 'string' ? o.raw : '';
  const query: Record<string, string> = {};
  if (Array.isArray(o.query)) {
    for (const q of o.query as Json[]) if (!q.disabled && typeof q.key === 'string') query[q.key] = postmanVars(String(q.value ?? ''));
    raw = raw.split('?')[0];
  }
  if (!raw) {
    const host = Array.isArray(o.host) ? (o.host as string[]).join('.') : String(o.host ?? '');
    const path = Array.isArray(o.path) ? (o.path as string[]).join('/') : String(o.path ?? '');
    raw = `${o.protocol ? `${String(o.protocol)}://` : ''}${host}${path ? `/${path}` : ''}`;
  }
  // Path variables ":id" take their value from url.variable.
  for (const v of (Array.isArray(o.variable) ? o.variable : []) as Json[]) {
    if (typeof v.key === 'string') raw = raw.replace(new RegExp(`:${v.key}(?=/|$|\\?)`), v.value !== undefined && v.value !== '' ? String(v.value) : `{{${v.key}}}`);
  }
  return { url: postmanVars(raw), query };
}

function authHeaders(auth: unknown): { headers: Record<string, string>; note?: string } {
  if (!auth || typeof auth !== 'object') return { headers: {} };
  const a = auth as Json;
  const type = String(a.type ?? 'noauth');
  const list = (Array.isArray(a[type]) ? a[type] : []) as Json[];
  const get = (k: string) => {
    const v = list.find((x) => x.key === k)?.value;
    return v === undefined ? undefined : String(v);
  };
  const asVar = (v: string | undefined, fallback: string) => {
    if (v && /^\{\{[^}]+\}\}$/.test(v.trim())) return postmanVars(v.trim());
    // A literal credential in the collection is never copied into the journey.
    return `\${${fallback}}`;
  };
  if (type === 'noauth') return { headers: {} };
  if (type === 'bearer') return { headers: { Authorization: `Bearer ${asVar(get('token'), 'token')}` } };
  if (type === 'apikey') {
    const where = get('in') ?? 'header';
    if (where !== 'header') return { headers: {}, note: 'API key in the query string: add "with query <key>=${apiKey}"' };
    return { headers: { [get('key') ?? 'x-api-key']: asVar(get('value'), 'apiKey') } };
  }
  if (type === 'basic') return { headers: {}, note: 'basic auth: give the API a role in identity.roles (or a header "Authorization" with a pre-encoded ${basicAuth} variable)' };
  if (type === 'oauth2') {
    const token = list.find((x) => x.key === 'accessToken')?.value;
    return { headers: { Authorization: `Bearer ${asVar(token === undefined ? undefined : String(token), 'accessToken')}` }, note: 'oauth2: prefer an identity role with client credentials ("as <role>")' };
  }
  return { headers: {}, note: `auth type "${type}" is not converted; use an identity role` };
}

interface Ctx {
  auth: unknown;
  draft: JourneyDraft;
  used: Set<string>;
  file: string;
}

function keyFor(name: string, used: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^[^A-Za-z_]+/, '').replace(/^./, (c) => c.toLowerCase()) || 'response';
  let k = base;
  for (let n = 2; used.has(k); n++) k = `${base}${n}`;
  used.add(k);
  return k;
}

/** Translate one line of a Postman test script; undefined when it has no equivalent. */
function testLine(line: string, key: string, jsonVars: Set<string>): { kind: 'expect' | 'step'; text: string } | undefined | null {
  const t = line.trim().replace(/;$/, '');
  if (!t || /^\/\//.test(t) || /^pm\.test\(/.test(t) || /^\}\s*\)?$/.test(t) || /^(?:var|let|const)\s+\w+\s*=\s*pm\.response\.json\(\)$/.test(t)) {
    const m = /^(?:var|let|const)\s+(\w+)\s*=\s*pm\.response\.json\(\)$/.exec(t);
    if (m) jsonVars.add(m[1]);
    return null; // structural: nothing to emit
  }
  let m: RegExpExecArray | null;
  if ((m = /^pm\.response\.to\.have\.status\((\d{3})\)$/.exec(t)) || (m = /^pm\.expect\(pm\.response\.(?:code|status)\)\.to\.(?:eql|equal|be|eq)\((\d{3})\)$/.exec(t))) return { kind: 'expect', text: `response ${key} status is ${m[1]}` };
  if ((m = /^pm\.response\.to\.be\.(ok|success)$/.exec(t))) return { kind: 'expect', text: `response ${key} status is 200` };
  if ((m = /^pm\.expect\(pm\.response\.responseTime\)\.to\.be\.(?:below|lessThan|lt)\((\d+)\)$/.exec(t))) return { kind: 'expect', text: `response ${key} responded within ${m[1]} ms` };
  const path = (expr: string): string | undefined => {
    const e = /^(?:pm\.response\.json\(\)|(\w+))((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[['"][^'"]+['"]\])*)$/.exec(expr.trim());
    if (!e || (e[1] && !jsonVars.has(e[1]))) return undefined;
    return `$${e[2].replace(/\[['"]([^'"]+)['"]\]/g, '.$1')}`;
  };
  if ((m = /^pm\.expect\((.+?)\)\.to\.(?:eql|equal|eq|be)\((.+)\)$/.exec(t))) {
    const p = path(m[1]);
    const v = m[2].trim();
    if (p && p !== '$' && /^(?:"[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false|null)$/.test(v)) {
      const val = /^["']/.test(v) ? v.slice(1, -1) : v;
      return { kind: 'expect', text: `response ${key} ${quoteText(p)} equals ${quoteText(val)}` };
    }
  }
  if ((m = /^pm\.expect\((.+?)\)\.to\.(?:exist|not\.be\.undefined|be\.ok)$/.exec(t))) {
    const p = path(m[1]);
    if (p && p !== '$') return { kind: 'expect', text: `response ${key} has ${quoteText(p)}` };
  }
  if ((m = /^pm\.expect\((.+?)\)\.to\.(?:include|contain)\((["'])(.*)\2\)$/.exec(t))) {
    const p = path(m[1]);
    if (p && p !== '$') return { kind: 'expect', text: `response ${key} ${quoteText(p)} contains ${quoteText(m[3])}` };
  }
  if ((m = /^pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*(["'])([\w.-]+)\1\s*,\s*(.+)\)$/.exec(t))) {
    const p = path(m[3]);
    if (p && p !== '$') return { kind: 'step', text: `Capture ${quoteText(p)} from ${key} as ${m[2]}` };
  }
  return undefined;
}

function addRequest(item: Json, ctx: Ctx): void {
  const req = (typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request ?? {}) as Json;
  const name = String(item.name ?? 'request');
  const key = keyFor(name, ctx.used);
  const method = String(req.method ?? 'GET').toUpperCase();
  const src = { line: 1, original: `${name}: ${method} ${typeof req.url === 'string' ? req.url : String((req.url as Json | undefined)?.raw ?? '')}` };
  if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
    ctx.draft.addTodo(src, `method ${method} is not supported by API steps`);
    return;
  }
  const { url, query } = urlOf(req.url);
  if (!url || /\s/.test(url)) {
    ctx.draft.addTodo(src, 'request has no usable URL');
    return;
  }
  for (const ev of (Array.isArray(item.event) ? item.event : []) as Json[]) {
    if (ev.listen === 'prerequest') {
      const exec = ((ev.script as Json | undefined)?.exec ?? []) as string[];
      for (const l of (Array.isArray(exec) ? exec : [String(exec)]).filter((x) => x.trim() && !/^\s*\/\//.test(x))) ctx.draft.addTodo({ line: 1, original: l }, 'pre-request scripts are not converted', 'none');
    }
  }
  const clauses: string[] = [];
  if (Object.keys(query).length) clauses.push(`with query ${Object.entries(query).map(([k, v]) => `${k}=${quoteText(v)}`).join(', ')}`);
  const auth = authHeaders(req.auth ?? ctx.auth);
  if (auth.note) ctx.draft.comment(`${name}: ${auth.note}`);
  const headers: Record<string, string> = { ...auth.headers };
  for (const h of (Array.isArray(req.header) ? req.header : []) as Json[]) if (!h.disabled && typeof h.key === 'string') headers[h.key] = postmanVars(String(h.value ?? ''));
  for (const [k, v] of Object.entries(headers)) clauses.push(`with header ${quoteText(k)} = ${quoteText(v)}`);
  const body = req.body as Json | undefined;
  let graphql: { query: string; variables?: string } | undefined;
  if (body && !body.disabled) {
    const mode = String(body.mode ?? '');
    if (mode === 'raw' && typeof body.raw === 'string' && body.raw.trim()) clauses.push(`with body ${quoteText(postmanVars(body.raw.trim()))}`);
    else if (mode === 'urlencoded') clauses.push(`with form ${((body.urlencoded ?? []) as Json[]).filter((x) => !x.disabled).map((x) => `${String(x.key)}=${quoteText(postmanVars(String(x.value ?? '')))}`).join(', ')}`);
    else if (mode === 'formdata') clauses.push(`with multipart ${((body.formdata ?? []) as Json[]).filter((x) => !x.disabled).map((x) => `${String(x.key)}=${quoteText(x.type === 'file' ? `@${String(x.src ?? '')}` : postmanVars(String(x.value ?? '')))}`).join(', ')}`);
    else if (mode === 'graphql') graphql = { query: String((body.graphql as Json | undefined)?.query ?? ''), ...((body.graphql as Json | undefined)?.variables ? { variables: String((body.graphql as Json).variables) } : {}) };
    else if (mode === 'file') ctx.draft.comment(`${name}: binary file body: add "with body from file ..."`);
  }
  let line: string;
  if (graphql) {
    line = `Send GraphQL query ${quoteText(graphql.query)} to ${quoteText(url)}${graphql.variables ? ` with variables ${quoteText(postmanVars(graphql.variables))}` : ''} and store as ${key}`;
  } else {
    const onlyBody = clauses.length === 1 && clauses[0].startsWith('with body ');
    line = onlyBody || !clauses.length ? `Call API ${quoteText(`${method} ${url}`)}${clauses.length ? ` ${clauses[0]}` : ''} and store as ${key}` : `Call API ${quoteText(`${method} ${url}`)} ${clauses.join(' ')} and store as ${key}`;
  }
  // Steps with test assertions on non-2xx statuses must allow errors.
  const tests = ((Array.isArray(item.event) ? item.event : []) as Json[]).filter((e) => e.listen === 'test').flatMap((e) => {
    const exec = (e.script as Json | undefined)?.exec;
    return Array.isArray(exec) ? (exec as string[]) : typeof exec === 'string' ? exec.split('\n') : [];
  });
  const errorStatus = tests.some((l) => /status\((?:[45]\d\d)\)|\.(?:code|status)\)\.to\.(?:eql|equal|be|eq)\([45]\d\d\)/.test(l));
  if (errorStatus && !graphql) line = line.replace(/ and store as /, clauses.length && !(clauses.length === 1 && clauses[0].startsWith('with body ')) ? ' with errors allowed and store as ' : ' and store as ');
  if (!ctx.draft.step(line, src, { action: 'api' })) return;
  const jsonVars = new Set<string>();
  for (const l of tests) {
    const r = testLine(l, key, jsonVars);
    if (r === null) continue;
    if (!r) {
      ctx.draft.addTodo({ line: 1, original: l }, 'Postman test script line has no plain-English equivalent', 'assertion');
      continue;
    }
    if (r.kind === 'expect') ctx.draft.expect(r.text, { line: 1, original: l });
    else ctx.draft.step(r.text, { line: 1, original: l });
  }
}

function collectRequests(items: Json[], ctx: Ctx, prefix = ''): void {
  for (const it of items) {
    if (Array.isArray(it.item)) {
      ctx.draft.comment(`folder: ${prefix}${String(it.name ?? '')}`);
      collectRequests(it.item as Json[], { ...ctx, auth: it.auth ?? ctx.auth }, `${prefix}${String(it.name ?? '')} / `);
    } else addRequest(it, ctx);
  }
}

function variablesHeader(collection: Json, env: unknown): string | undefined {
  const vars: Array<[string, string]> = [];
  const secrets: string[] = [];
  const take = (list: unknown) => {
    for (const v of (Array.isArray(list) ? list : []) as Json[]) {
      if (typeof v.key !== 'string' || v.enabled === false) continue;
      if (v.type === 'secret' || /pass|secret|token|key/i.test(v.key)) {
        secrets.push(v.key);
        continue;
      }
      if (v.value !== undefined && v.value !== '') vars.push([v.key.replace(/[^\w.]/g, '_'), String(v.value)]);
    }
  };
  take(collection.variable);
  take((env as Json | undefined)?.values);
  const dedup = [...new Map(vars).entries()].filter(([k]) => /^[A-Za-z_][\w.-]*$/.test(k));
  const header = dedup.length ? `Variables: ${dedup.map(([k, v]) => `${k}=${quoteText(postmanVars(v))}`).join(', ')}` : undefined;
  return secrets.length ? `${header ? `${header}\n` : ''}# secret variables (set them from secret:// references in the config): ${[...new Set(secrets)].join(', ')}` : header;
}

/** Import a Postman collection (v2.0 or v2.1 JSON). */
export function importPostman(text: string, opts: PostmanImportOptions = {}): ImportReport {
  const file = opts.file ?? 'collection.json';
  let doc: Json;
  try {
    doc = JSON.parse(text) as Json;
  } catch (e) {
    return { journeys: [], converted: [], todo: [], warnings: [`${file}: not valid JSON (${(e as Error).message})`], coverage: { sourceSteps: 0, convertedSteps: 0, assertions: 0, convertedAssertions: 0 }, files: [file] };
  }
  const info = (doc.info ?? {}) as Json;
  const name = String(info.name ?? 'Postman collection');
  const ids = opts.ids ?? new Set<string>();
  const items = (Array.isArray(doc.item) ? doc.item : []) as Json[];
  const vh = variablesHeader(doc, opts.environment);
  const headers = vh ? vh.split('\n').filter((l) => !l.startsWith('#')) : [];
  const secretNote = vh?.split('\n').find((l) => l.startsWith('#'));
  const drafts: JourneyDraft[] = [];
  const mk = (title: string) => {
    const d = new JourneyDraft(title, { kind: 'postman', file, line: 1, ids, tags: ['api', 'postman', ...(opts.tags ?? [])], headers, ...(typeof info.description === 'string' ? { description: info.description } : {}) });
    if (secretNote) d.comment(secretNote.slice(2));
    return d;
  };
  const loose = items.filter((i) => !Array.isArray(i.item));
  if (loose.length) {
    const d = mk(name);
    collectRequests(loose, { auth: doc.auth, draft: d, used: new Set(), file });
    drafts.push(d);
  }
  for (const folder of items.filter((i) => Array.isArray(i.item))) {
    const d = mk(`${name}: ${String(folder.name ?? 'folder')}`);
    collectRequests(folder.item as Json[], { auth: folder.auth ?? doc.auth, draft: d, used: new Set(), file });
    drafts.push(d);
  }
  return assembleReport(drafts, [file]);
}

export function looksLikePostman(text: string): boolean {
  const head = text.slice(0, 4000);
  return /"_postman_id"|schema\.getpostman\.com\/json\/collection|"schema"\s*:\s*"https:\/\/schema\.postman\.com/.test(head);
}
