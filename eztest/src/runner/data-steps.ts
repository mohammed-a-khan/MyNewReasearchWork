/**
 * API, GraphQL, SOAP, WebSocket, database, email/SMS, dataset comparison and
 * variable steps.
 *
 * SQL safety: `${var}` inside SQL is never spliced into the text. Each one
 * (or a quoted literal containing one, e.g. '%${name}%') becomes a bound
 * parameter in the connection's placeholder style.
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import {
  EzTestError, NotSupportedError, asText, evaluateExpression, interpolate, renderTemplate, type ApiCall, type Step,
} from '../core/index.js';
import { parseCsv } from '../docs/csv.js';
import { readXlsxTable } from '../importers/xlsx.js';
import { ApiClient, buildSoapEnvelope, caseInsensitiveRow, compareRows, describeDifferences, formatGraphQLErrors, getPath, GraphQLClient, GraphQLWsClient, parseSoapResponse, placeholder, scanSql, selectClientCertificate, validateGraphQL, WsClient, type CompareOptions, type GraphQLEvent, type GraphQLSubscription, type SqlDialect } from '../surfaces/index.js';
import type { ActionOutcome } from './actions.js';
import { regex } from './conditions-advanced.js';
import { maskDeep } from './dom.js';
import { safeName } from './evidence.js';
import type { ApiResponse, DbQueryParams, RunOptions, StepContext } from './types.js';
import { resolveUrl } from './api.js';

type Vars = Record<string, unknown>;

/** Interpolate ${var} in every string leaf of a JSON-like value. */
export function interpolateDeep(v: unknown, I: (s: string) => string): unknown {
  if (typeof v === 'string') return I(v);
  if (Array.isArray(v)) return v.map((x) => interpolateDeep(x, I));
  if (v && typeof v === 'object' && !(v instanceof FormData) && !(v instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolateDeep(x, I)]));
  }
  return v;
}

const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain', '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/html',
};

function withQuery(url: string, query: Record<string, string>): string {
  const qs = new URLSearchParams(query).toString();
  if (!qs) return url;
  return url + (url.includes('?') ? '&' : '?') + qs;
}

/** Build the concrete call (interpolated; form/multipart/file/GraphQL/SOAP bodies prepared). */
/**
 * An inline body written as JSON text with placeholders (`'{"amount": ${amount}}'`) cannot be parsed
 * when the line is read, only after the values are filled in. When the filled-in text is a JSON object
 * or array (and no content type was given), it is sent as JSON, like a body that parsed up front.
 */
function jsonOrText(text: string, hasContentType: boolean): unknown {
  const t = text.trim();
  if (hasContentType || !(t.startsWith('{') || t.startsWith('['))) return text;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return text;
  }
}

export async function buildApiCall(step: Step, ctx: StepContext, opts: RunOptions): Promise<ApiCall> {
  if (!step.api) throw new EzTestError(`Step "${step.intent}" has no api call`, 'MISSING_API');
  const I = (s: string) => ctx.interpolate(s);
  const src = step.api;
  const headers: Record<string, string> = Object.fromEntries(Object.entries(src.headers ?? {}).map(([k, v]) => [k, I(v)]));
  const hasHeader = (h: string) => Object.keys(headers).some((k) => k.toLowerCase() === h);
  const query = src.query ? Object.fromEntries(Object.entries(src.query).map(([k, v]) => [k, I(v)])) : {};
  const call: ApiCall = {
    method: src.method, url: withQuery(I(src.url), query), headers, ...(src.asRole ? { asRole: src.asRole } : {}), ...(src.timeoutMs ? { timeoutMs: src.timeoutMs } : {}),
    ...(src.clientCertificate ? { clientCertificate: I(src.clientCertificate) } : {}),
  };
  // Bodies are templates: ${var}, ${expression} such as ${json(items)}, and {{...}} with templates.syntax: mustache.
  const B = (s: string) => renderTemplate(s, ctx.vars(), { syntax: opts.templateSyntax });
  const base = opts.baseDir ?? process.cwd();
  if (src.graphql) {
    call.method = 'POST';
    call.body = { query: src.graphql.query, variables: interpolateDeep(src.graphql.variables ?? {}, I), ...(src.graphql.operationName ? { operationName: src.graphql.operationName } : {}) };
    if (!hasHeader('accept')) headers.accept = 'application/graphql-response+json, application/json';
  } else if (src.soap) {
    call.method = 'POST';
    const version = src.soap.version ?? '1.1';
    call.body = buildSoapEnvelope({ version, body: I(src.soap.body) });
    if (version === '1.1') {
      headers['content-type'] = 'text/xml; charset=utf-8';
      headers.soapaction = `"${src.soap.action ?? ''}"`;
    } else headers['content-type'] = `application/soap+xml; charset=utf-8${src.soap.action ? `; action="${src.soap.action}"` : ''}`;
  } else if (src.form) {
    call.body = new URLSearchParams(Object.fromEntries(Object.entries(src.form).map(([k, v]) => [k, I(v)]))).toString();
    if (!hasHeader('content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (src.multipart) {
    const fd = new FormData();
    for (const [k, raw] of Object.entries(src.multipart)) {
      const v = I(raw);
      if (v.startsWith('@')) {
        const path = resolve(base, v.slice(1));
        const bytes = await readFile(path);
        fd.append(k, new Blob([new Uint8Array(bytes)], { type: CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' }), path.split(/[\\/]/).pop());
      } else fd.append(k, v);
    }
    call.body = fd;
  } else if (src.bodyFile) {
    const path = resolve(base, I(src.bodyFile));
    const ct = CONTENT_TYPES[extname(path).toLowerCase()];
    if (ct && /json|xml|text|csv|html/.test(ct)) call.body = B(await readFile(path, 'utf8'));
    else call.body = new Uint8Array(await readFile(path));
    if (!hasHeader('content-type')) headers['content-type'] = ct ?? 'application/octet-stream';
  } else if (src.body !== undefined) {
    call.body = typeof src.body === 'string' ? jsonOrText(B(src.body), hasHeader('content-type')) : interpolateDeep(src.body, B);
  }
  return call;
}

/** Turn a raw response into what the ledger keeps (GraphQL errors and SOAP faults surfaced). */
export function finishApiResponse(step: Step, res: ApiResponse, durationMs: number): ApiResponse & { durationMs: number; errors?: unknown[]; fault?: unknown } {
  const out: ApiResponse & { durationMs: number; errors?: unknown[]; fault?: unknown } = { ...res, durationMs };
  const allow = step.args?.allowErrors === true || step.postconditions.some((c) => c.type === 'apiStatus' || c.type === 'jsonPath');
  if (step.api?.graphql) {
    const b = res.body as { data?: unknown; errors?: Array<{ message?: string }> } | string;
    if (!b || typeof b !== 'object') throw new EzTestError(`GraphQL endpoint returned HTTP ${res.status} without a GraphQL body`, 'GRAPHQL_ERROR');
    if (Array.isArray(b.errors) && b.errors.length) {
      out.errors = b.errors;
      if (!allow) throw new EzTestError(`GraphQL errors: ${b.errors.map((e) => e.message ?? JSON.stringify(e)).join('; ')}`, 'GRAPHQL_ERROR');
    }
  }
  if (step.api?.soap) {
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    const parsed = parseSoapResponse(text);
    out.body = parsed.body;
    if (parsed.fault) {
      out.fault = parsed.fault;
      if (!allow) throw new EzTestError(`SOAP fault ${parsed.fault.code}: ${parsed.fault.reason}`, 'SOAP_FAULT');
    }
  }
  return out;
}

// ------------------------------------------------------------------ SQL binding

type Dialect = SqlDialect;
type BindValue = string | number | boolean | null;

function lookupVar(vars: Vars, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (cur !== null && typeof cur === 'object' && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function sqlParam(v: unknown, name: string): BindValue {
  if (v === undefined) throw new EzTestError(`SQL uses \${${name}} but no such variable is set`, 'UNKNOWN_VARIABLE');
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/**
 * Replace `${var}` (and quoted literals containing `${...}`) with bound
 * parameters. Existing `?`/`$n`/`@pn`/`:n` parameters keep their positions.
 * Comments, quoted identifiers and Oracle q'[..]' literals are skipped.
 */
export function bindSql(sql: string, params: BindValue[], vars: Vars, dialect: Dialect): { sql: string; params: BindValue[] } {
  if (!sql.includes('${')) return { sql, params };
  // sqlite and mysql ("?") and oracle (":1", bound by position of appearance) need values in text order.
  const ordered = dialect === 'sqlite' || dialect === 'oracle' || dialect === 'mysql';
  const tokens = scanSql(sql, { named: dialect === 'oracle', positional: ordered, vars: true, literalVars: true, backslashEscapes: dialect === 'mysql' });
  const out: BindValue[] = [];
  const tail = [...params];
  let given = 0;
  let n = 0;
  let next = params.length;
  let text = '';
  let at = 0;
  const mark = (): string => (ordered ? placeholder(dialect, ++n) : placeholder(dialect, ++next));
  for (const t of tokens) {
    text += sql.slice(at, t.start);
    at = t.end;
    if (t.kind === 'var') {
      const literalVar = sql[t.start] === "'";
      let value: BindValue;
      if (literalVar) {
        const whole = /^\$\{([A-Za-z_][\w.]*)\}$/.exec(t.name);
        value = whole ? sqlParam(lookupVar(vars, whole[1]), whole[1]) : interpolate(t.name, vars, { strict: true });
      } else value = sqlParam(lookupVar(vars, t.name), t.name);
      text += mark();
      if (ordered) out.push(value);
      else tail.push(value);
      continue;
    }
    // an existing positional/named marker (sqlite ?, oracle :x or ?)
    if (given >= params.length) throw new EzTestError('SQL has more bind markers than params', 'BAD_SQL');
    out.push(params[given++]);
    text += dialect === 'oracle' ? placeholder(dialect, ++n) : sql.slice(t.start, t.end);
  }
  text += sql.slice(at);
  if (ordered) {
    while (given < params.length) out.push(params[given++]);
    return { sql: text, params: out };
  }
  return { sql: text, params: tail };
}

/** SQL calling a stored procedure with n parameters in a dialect. */
export function procedureSql(name: string, n: number, dialect: Dialect): string {
  if (!/^[A-Za-z_][\w.]*$/.test(name)) throw new EzTestError(`Invalid procedure name "${name}"`, 'BAD_SQL');
  if (dialect === 'sqlite') throw new NotSupportedError('stored procedures on SQLite');
  if (dialect === 'postgres') return `CALL ${name}(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ')})`;
  if (dialect === 'oracle') return `BEGIN ${name}(${Array.from({ length: n }, (_, i) => `:${i + 1}`).join(', ')}); END;`;
  if (dialect === 'mysql') return `CALL ${name}(${Array.from({ length: n }, () => '?').join(', ')})`;
  return `EXEC ${name}${n ? ' ' + Array.from({ length: n }, (_, i) => `@p${i + 1}`).join(', ') : ''}`;
}

/** A catalogue bind value: a lone "${var}" keeps the variable's type, other strings are interpolated. */
function bindFromStep(v: BindValue, ctx: StepContext): BindValue {
  if (typeof v !== 'string') return v;
  const whole = /^\$\{([A-Za-z_][\w.]*)\}$/.exec(v);
  if (whole) return sqlParam(lookupVar(ctx.vars(), whole[1]), whole[1]);
  return ctx.interpolate(v);
}

function wrapRows(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((r) => (r && typeof r === 'object' && Object.getPrototypeOf(r) === Object.prototype ? caseInsensitiveRow(r as Record<string, unknown>) : r));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return caseInsensitiveRow(v as Record<string, unknown>);
  return v;
}

export async function dbAction(step: Step, ctx: StepContext, opts: RunOptions): Promise<ActionOutcome> {
  if (!step.db) throw new EzTestError(`Step "${step.intent}" has no query`, 'MISSING_DB');
  if (!opts.db) throw new EzTestError('No db handler configured (RunOptions.db)', 'NO_HANDLER');
  const q = step.db;
  const given = (q.params ?? []).map((p) => (typeof p === 'string' ? ctx.interpolate(p) : p));
  const mask = ctx.session?.mask ?? ((s: string) => s);
  const k = step.captureAs ?? (q.out?.length ? 'out' : 'rows');
  if (q.procedure && q.out?.length) {
    if (!opts.db.callProcedure) throw new NotSupportedError('stored procedure OUT parameters with this db handler (needs the EZTest engine and an Oracle connection)');
    const outs = await opts.db.callProcedure(q.connection, q.procedure, given, q.out);
    const v = wrapRows(maskDeep(outs, mask));
    ctx.ledger.set(k, v);
    return { captured: { [k]: v } };
  }
  let connection = q.connection;
  let bound: { sql: string; params: unknown[] };
  if (q.query) {
    if (!opts.db.namedQuery) throw new EzTestError(`Step "${step.intent}" runs catalogue query "${q.query}", but no query catalogue is available (run through the EZTest engine with db.queries)`, 'NO_HANDLER');
    const binds = Object.fromEntries(Object.entries(q.binds ?? {}).map(([name, v]) => [name, bindFromStep(v, ctx)]));
    const compiled = await opts.db.namedQuery(q.query, q.connection, { binds, ...(given.length ? { params: given } : {}) });
    connection = compiled.connection;
    bound = { sql: compiled.sql, params: compiled.params };
  } else {
    const dialect: Dialect = (await opts.db.dialect?.(q.connection)) ?? 'sqlite';
    bound = q.procedure ? { sql: procedureSql(q.procedure, given.length, dialect), params: given } : bindSql(q.sql, given, ctx.vars(), dialect);
  }
  const rows = await opts.db.query(connection, bound.sql, bound.params as DbQueryParams);
  let v: unknown = rows;
  switch (q.capture ?? 'rows') {
    case 'row':
      if (!rows.length) throw new EzTestError('query returned no rows', 'NO_ROWS');
      v = rows[0];
      break;
    case 'cell': {
      if (!rows.length) throw new EzTestError('query returned no rows', 'NO_ROWS');
      v = Object.values(rows[0])[0] ?? null;
      break;
    }
    case 'count': v = rows.length; break;
  }
  // Masked copies are plain objects again; column lookups stay case-insensitive (Oracle returns UPPER CASE names).
  v = wrapRows(maskDeep(v, mask));
  ctx.ledger.set(k, v);
  return { captured: { [k]: v } };
}

// ------------------------------------------------------------------ WebSocket

export async function wsAction(step: Step, ctx: StepContext, timeout: number, opts?: Pick<RunOptions, 'apiAuth' | 'clientCertificates'>): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const session = ctx.session;
  if (!session) throw new EzTestError('websocket steps need a browser session', 'NO_SESSION');
  const name = String(a.socket ?? 'ws');
  const op = String(a.op);
  const get = () => {
    const s = session.sockets.get(name);
    if (!s) throw new EzTestError(`No websocket "${name}" (connect it first: Connect to websocket "/ws" as ${name})`, 'NO_SOCKET');
    return s;
  };
  switch (op) {
    case 'connect': {
      let url = ctx.interpolate(String(a.url));
      if (!/^wss?:/i.test(url)) url = resolveUrl(url, ctx.baseUrl).replace(/^http/i, 'ws');
      await session.sockets.get(name)?.close().catch(() => undefined);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((a.headers ?? {}) as Record<string, string>)) {
        headers[k] = ctx.interpolate(v);
      }
      if (a.asRole !== undefined) {
        if (!opts?.apiAuth) throw new EzTestError(`Websocket as role "${String(a.asRole)}" needs API credentials for the role (identity.roles.${String(a.asRole)}.api)`, 'NO_API_AUTH');
        Object.assign(headers, await opts.apiAuth(String(a.asRole), ctx));
      }
      const cert = selectClientCertificate(opts?.clientCertificates, url.replace(/^ws/i, 'http'), a.clientCertificate !== undefined ? String(a.clientCertificate) : undefined);
      session.sockets.set(name, await WsClient.connect(url, {
        timeoutMs: timeout, headers,
        ...(Array.isArray(a.protocols) ? { protocols: (a.protocols as string[]).map((p) => ctx.interpolate(p)) } : {}),
        ...(cert ? { tls: { ...(cert.pfx ? { pfx: cert.pfx } : {}), ...(cert.cert ? { cert: cert.cert } : {}), ...(cert.key ? { key: cert.key } : {}), ...(cert.passphrase !== undefined ? { passphrase: cert.passphrase } : {}), ...(cert.ca ? { ca: cert.ca } : {}) } } : {}),
        ...(a.pingIntervalMs !== undefined ? { pingIntervalMs: Number(a.pingIntervalMs) } : {}),
      }));
      return {};
    }
    case 'send': {
      const msg = ctx.interpolate(step.value ?? '');
      get().send(msg);
      session.wsFrames.push({ seq: session.nextSeq(), url: name, direction: 'sent', payload: session.mask(msg), at: new Date().toISOString(), socket: name });
      return {};
    }
    case 'expect': {
      const want = ctx.interpolate(String(a.contains ?? ''));
      const m = await get().waitForMessage((x) => x.text.includes(want), Number(a.timeoutMs ?? timeout));
      const text = session.mask(m.text);
      session.wsFrames.push({ seq: session.nextSeq(), url: name, direction: 'received', payload: text, at: new Date().toISOString(), socket: name });
      if (step.captureAs) {
        const parsed = m.json();
        const v = parsed === undefined ? text : maskDeep(parsed, session.mask);
        ctx.ledger.set(step.captureAs, v);
        return { captured: { [step.captureAs]: v } };
      }
      return {};
    }
    case 'close':
      await get().close();
      session.sockets.delete(name);
      return {};
    case 'gql-subscribe': case 'gql-event': case 'gql-stop': case 'gql-validate': case 'gql-introspect':
      return graphqlAction(step, ctx, timeout, opts);
    default:
      throw new NotSupportedError(`websocket op "${op}"`);
  }
}

// ------------------------------------------------------------------ GraphQL (subscriptions, introspection, validation)

const GQL = new WeakMap<object, Map<string, { client: GraphQLWsClient; sub: GraphQLSubscription }>>();

/** Auth headers and the client certificate for a GraphQL endpoint (as API steps get them). */
async function endpointAuth(a: Record<string, unknown>, url: string, ctx: StepContext, opts?: Pick<RunOptions, 'apiAuth' | 'clientCertificates'>) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((a.headers ?? {}) as Record<string, string>)) headers[k] = ctx.interpolate(v);
  if (a.asRole !== undefined) {
    if (!opts?.apiAuth) throw new EzTestError(`GraphQL as role "${String(a.asRole)}" needs API credentials for the role (identity.roles.${String(a.asRole)}.api)`, 'NO_API_AUTH');
    Object.assign(headers, await opts.apiAuth(String(a.asRole), ctx));
  }
  const cert = selectClientCertificate(opts?.clientCertificates, url.replace(/^ws/i, 'http'), a.clientCertificate !== undefined ? String(a.clientCertificate) : undefined);
  return { headers, cert };
}

async function graphqlAction(step: Step, ctx: StepContext, timeout: number, opts?: Pick<RunOptions, 'apiAuth' | 'clientCertificates'>): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const session = ctx.session!;
  let subs = GQL.get(session);
  if (!subs) {
    subs = new Map();
    GQL.set(session, subs);
    const own = subs;
    session.cleanups.push(async () => {
      for (const s of own.values()) await s.client.close().catch(() => undefined);
      own.clear();
    });
  }
  const name = String(a.socket ?? '');
  switch (String(a.op)) {
    case 'gql-subscribe': {
      let url = ctx.interpolate(String(a.url));
      if (!/^wss?:/i.test(url)) url = resolveUrl(url, ctx.baseUrl).replace(/^http/i, 'ws');
      const { headers, cert } = await endpointAuth(a, url, ctx, opts);
      await subs.get(name)?.client.close().catch(() => undefined);
      const client = await GraphQLWsClient.connect(url, {
        timeoutMs: timeout, headers,
        // Servers that authenticate in connection_init read the same header there.
        ...(headers.authorization || headers.Authorization ? { connectionParams: { authorization: headers.authorization ?? headers.Authorization } } : {}),
        ...(cert ? { tls: { ...(cert.pfx ? { pfx: cert.pfx } : {}), ...(cert.cert ? { cert: cert.cert } : {}), ...(cert.key ? { key: cert.key } : {}), ...(cert.passphrase !== undefined ? { passphrase: cert.passphrase } : {}), ...(cert.ca ? { ca: cert.ca } : {}) } } : {}),
      });
      const variables = a.variables ? interpolateDeep(a.variables as Record<string, unknown>, (s) => ctx.interpolate(s)) as Record<string, unknown> : undefined;
      const sub = client.subscribe(ctx.interpolate(String(a.query)), variables);
      subs.set(name, { client, sub });
      return {};
    }
    case 'gql-event': {
      const s = subs.get(name);
      if (!s) throw new EzTestError(`No GraphQL subscription "${name}" (start it first: Subscribe to GraphQL "subscription { ... }" at /graphql as ${name})`, 'NO_SUBSCRIPTION');
      const filters = ((a.filters ?? []) as Array<{ path: string; op: string; value: string }>).map((f) => ({ ...f, value: ctx.interpolate(f.value) }));
      const pred = (e: GraphQLEvent) => filters.every((f) => {
        let v: unknown;
        try {
          v = getPath(e, f.path);
        } catch {
          return false;
        }
        const text = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return f.op === '!=' ? text !== f.value : f.op === 'contains' ? text.includes(f.value) : text === f.value;
      });
      const wait = Number(a.timeoutMs ?? timeout);
      const e = await s.sub.next(pred, wait);
      if (!e) {
        if (s.sub.error) throw new EzTestError(`GraphQL subscription "${name}" failed: ${s.sub.error.map((x) => x.message).join('; ')}`, 'GRAPHQL_SUBSCRIPTION');
        const seen = s.sub.events.length ? `; ${s.sub.events.length} event(s) arrived, the last: ${session.mask(JSON.stringify(s.sub.events.at(-1)?.data ?? null)).slice(0, 200)}` : '; no events arrived';
        throw new EzTestError(`No GraphQL event on "${name}"${filters.length ? ` matched ${filters.map((f) => `${f.path} ${f.op} ${f.value}`).join(' and ')}` : ''} within ${wait} ms${s.sub.completed ? ' (the server completed the subscription)' : ''}${seen}`, 'GRAPHQL_TIMEOUT');
      }
      if (e.errors?.length) throw new EzTestError(`GraphQL event on "${name}" has errors: ${e.errors.map((x) => x.message).join('; ')}`, 'GRAPHQL_ERROR');
      session.wsFrames.push({ seq: session.nextSeq(), url: name, direction: 'received', payload: session.mask(JSON.stringify(e.data ?? null)), at: new Date(e.receivedAt).toISOString(), socket: name });
      const key = step.captureAs ?? 'event';
      const v = maskDeep({ data: e.data ?? null, ...(e.extensions ? { extensions: e.extensions } : {}) }, session.mask);
      ctx.ledger.set(key, v);
      return { captured: { [key]: v } };
    }
    case 'gql-stop': {
      const s = subs.get(name);
      if (!s) throw new EzTestError(`No GraphQL subscription "${name}"`, 'NO_SUBSCRIPTION');
      s.sub.unsubscribe();
      await s.client.close().catch(() => undefined);
      subs.delete(name);
      return {};
    }
    case 'gql-validate': case 'gql-introspect': {
      const url = resolveUrl(ctx.interpolate(String(a.url)), ctx.baseUrl);
      const { headers, cert } = await endpointAuth(a, url, ctx, opts);
      const gql = new GraphQLClient(new ApiClient({ headers, timeoutMs: timeout, ...(cert ? { clientCertificates: [{ origin: new URL(url).origin, ...(cert.pfx ? { pfx: cert.pfx } : {}), ...(cert.cert ? { cert: cert.cert } : {}), ...(cert.key ? { key: cert.key } : {}), ...(cert.passphrase !== undefined ? { passphrase: cert.passphrase } : {}), ...(cert.ca ? { ca: cert.ca } : {}) }] } : {}) }), url);
      const schema = await gql.introspect();
      if (a.op === 'gql-introspect') {
        const v = {
          queryType: schema.queryType?.name ?? null, mutationType: schema.mutationType?.name ?? null, subscriptionType: schema.subscriptionType?.name ?? null,
          types: schema.types.filter((t) => !t.name.startsWith('__')).map((t) => t.name).sort(),
          fields: Object.fromEntries(schema.types.filter((t) => !t.name.startsWith('__') && t.fields).map((t) => [t.name, t.fields!.map((f) => f.name)])),
        };
        const key = step.captureAs ?? 'schema';
        ctx.ledger.set(key, v);
        return { captured: { [key]: v } };
      }
      const errors = validateGraphQL(ctx.interpolate(String(a.query)), schema);
      if (errors.length) throw new EzTestError(`GraphQL document is not valid against the schema of ${url} (${errors.length} problem${errors.length === 1 ? '' : 's'}): ${formatGraphQLErrors(errors).join(' | ')}`, 'GRAPHQL_INVALID', { errors });
      return {};
    }
    default:
      throw new NotSupportedError(`GraphQL op "${String(a.op)}"`);
  }
}

// ------------------------------------------------------------------ email / SMS

export async function messageAction(step: Step, ctx: StepContext, opts: RunOptions, timeout: number): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const s = (v: unknown) => (v === undefined ? undefined : ctx.interpolate(String(v)));
  const since = a.since === 'any' ? undefined : Date.now() - Number(a.lookbackMs ?? 60_000);
  const within = Number(a.timeoutMs ?? Math.max(timeout, 10_000));
  const mask = ctx.session?.mask ?? ((x: string) => x);
  let v: Record<string, unknown>;
  if (step.action === 'email') {
    if (!opts.mail) throw new EzTestError('No mail provider configured (config email: { provider: sink } or RunOptions.mail)', 'NO_HANDLER');
    const m = await opts.mail.latest({ to: s(a.to), subject: s(a.subject), since, timeoutMs: within });
    v = { id: m.id, from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), date: m.date };
  } else {
    if (!opts.sms) throw new EzTestError('No SMS provider configured (config sms: { provider: twilio } or RunOptions.sms)', 'NO_HANDLER');
    const m = await opts.sms.latest({ to: s(a.to), from: s(a.from), contains: s(a.contains), since, timeoutMs: within });
    v = { id: m.id, from: m.from, to: m.to, body: m.body, text: m.body, date: m.date };
  }
  v = maskDeep(v, mask) as Record<string, unknown>;
  const k = step.captureAs ?? step.action;
  ctx.ledger.set(k, v);
  const ref = await ctx.evidence.store('data', `messages/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify(v, null, 2),
    { journeyId: ctx.journey.id, stepId: step.id, description: `${step.action} received` });
  return { captured: { [k]: v }, evidence: [ref.id] };
}

// ------------------------------------------------------------------ compare datasets

function rowsOf(v: unknown, what: string): Array<Record<string, unknown>> {
  const body = v && typeof v === 'object' && !Array.isArray(v) && 'status' in v && 'body' in v ? (v as { body: unknown }).body : v;
  if (!Array.isArray(body)) throw new EzTestError(`${what} is not a list of rows`, 'NOT_ROWS');
  return body as Array<Record<string, unknown>>;
}

export async function compareDataAction(step: Step, ctx: StepContext, opts: RunOptions = { outputDir: '.' }): Promise<ActionOutcome> {
  const a = step.args ?? {};
  const vars = ctx.vars();
  const eq = a.expectedQuery as { name: string; connection?: string; params?: string[]; binds?: Record<string, string> } | undefined;
  const expected = eq ? await namedQueryRows(eq, ctx, opts) : rowsOf(evaluateExpression(String(a.expected), vars), String(a.expected));
  const actual = rowsOf(evaluateExpression(String(a.actual), vars), String(a.actual));
  const map = (a.map ?? {}) as Record<string, string>;
  let renamed = Object.keys(map).length ? actual.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [map[k] ?? k, x]))) : actual;
  // Column names that differ only in case (Oracle upper-cases them) are matched to the expected side's names.
  if (a.caseInsensitiveColumns && expected.length) {
    const canon = new Map<string, string>();
    for (const r of expected) for (const k of Object.keys(r)) if (!canon.has(k.toLowerCase())) canon.set(k.toLowerCase(), k);
    renamed = renamed.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [canon.get(k.toLowerCase()) ?? k, x])));
  }
  const keyCols = (Array.isArray(a.key) ? a.key : [a.key]).map((k) => (a.caseInsensitiveColumns && expected.length ? (Object.keys(expected[0]).find((c) => c.toLowerCase() === String(k).toLowerCase()) ?? String(k)) : String(k)));
  const ignore = new Set(((a.ignore as string[] | undefined) ?? []).map((c) => c.toLowerCase()));
  const columns = a.columns
    ? (a.columns as string[])
    : ignore.size
      ? [...new Set(expected.flatMap((r) => Object.keys(r)))].filter((c) => !ignore.has(c.toLowerCase()) && !keyCols.includes(c))
      : undefined;
  const o: CompareOptions = {
    key: keyCols.length === 1 ? keyCols[0] : keyCols,
    ...(columns ? { columns } : {}),
    ...(a.tolerance !== undefined ? { tolerance: Number(a.tolerance) } : {}),
    ...(a.ignoreCase ? { ignoreCase: true, trim: true } : {}),
    failOnExtra: a.failOnExtra !== false,
  };
  const r = compareRows(expected, renamed, o);
  const ref = await ctx.evidence.store('data', `compare/${safeName(ctx.journey.id)}/${safeName(step.id)}.json`, JSON.stringify(r, null, 2),
    { journeyId: ctx.journey.id, stepId: step.id, description: 'dataset comparison' });
  if (step.captureAs) ctx.ledger.set(step.captureAs, r);
  if (!r.passed) {
    const diff = describeDifferences(r, 5, ctx.session?.mask);
    throw new EzTestError(`Data comparison failed: ${r.summary}${diff ? ` - ${diff}` : ''}`, 'COMPARE_FAILED', { details: r });
  }
  return { captured: step.captureAs ? { [step.captureAs]: r } : undefined, evidence: [ref.id] };
}

// ------------------------------------------------------------------ downloads as rows

/**
 * Rows of a downloaded (or any captured) CSV/TSV/XLSX file. `src` is a download
 * record from the ledger ({ path }) or a path. Files are read from where the run saved
 * them (the run directory), never from a user Downloads folder.
 */
export async function readRowsFile(src: unknown, what: string, sheet?: string, delimiter?: string): Promise<Array<Record<string, string>>> {
  const path = typeof src === 'string' ? src : src && typeof src === 'object' && typeof (src as { path?: unknown }).path === 'string' ? (src as { path: string }).path : undefined;
  if (!path) throw new EzTestError(`${what} is not a downloaded file (download it first, e.g. Download the Export link as ${what})`, 'NOT_A_FILE');
  const name = (src && typeof src === 'object' && typeof (src as { filename?: unknown }).filename === 'string' ? (src as { filename: string }).filename : path).toLowerCase();
  const bytes = await readFile(path);
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm') || isZip) {
    const t = await readXlsxTable(new Uint8Array(bytes), sheet ? { sheet } : {});
    return t.rows.map((r) => r.values);
  }
  if (name.endsWith('.xls')) throw new NotSupportedError('legacy .xls files (save the export as .xlsx or .csv)');
  const text = bytes.toString('utf8');
  const delim = delimiter ?? (name.endsWith('.tsv') ? '\t' : sniffDelimiter(text));
  return parseCsv(text, { delimiter: delim === '\\t' ? '\t' : delim }).rows;
}

function sniffDelimiter(text: string): string {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length - 1] as const);
  const best = counts.sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/** Run a named query from the catalogue (<queriesDir>/<NAME>.sql) and return its rows. */
async function namedQueryRows(q: { name: string; connection?: string; params?: string[]; binds?: Record<string, string> }, ctx: StepContext, opts: RunOptions): Promise<Array<Record<string, unknown>>> {
  if (!opts.db) throw new EzTestError('No db handler configured (RunOptions.db)', 'NO_HANDLER');
  if (!/^[A-Za-z0-9_.-]+$/.test(q.name)) throw new EzTestError(`Invalid query name "${q.name}"`, 'BAD_QUERY_NAME');
  const value = (p: string) => {
    const m = /^\$\{([\w.]+)\}$/.exec(p);
    if (m) return sqlParam(lookupVar(ctx.vars(), m[1]), m[1]);
    return ctx.interpolate(p);
  };
  const params0 = (q.params ?? []).map(value);
  const binds = q.binds ? Object.fromEntries(Object.entries(q.binds).map(([k, v]) => [k, value(v)])) : undefined;
  // Through the engine: the named-query catalogue (headers, fragments, :name binds, default connection).
  if (opts.db.namedQuery) {
    const compiled = await opts.db.namedQuery(q.name, q.connection ?? '', binds ? { binds: binds as Record<string, string | number | boolean | null> } : params0.length ? { params: params0 } : {});
    return opts.db.query(compiled.connection, compiled.sql, compiled.params as DbQueryParams);
  }
  const dir = opts.queriesDir ?? resolve(opts.baseDir ?? process.cwd(), 'queries');
  let sql: string;
  try {
    sql = await readFile(resolve(dir, `${q.name}.sql`), 'utf8');
  } catch {
    throw new EzTestError(`Named query "${q.name}" not found (${resolve(dir, `${q.name}.sql`)})`, 'QUERY_NOT_FOUND');
  }
  sql = sql.replace(/^\s*--.*$/gm, '').trim().replace(/;\s*$/, '');
  const connection = q.connection ?? 'default';
  const dialect: Dialect = (await opts.db.dialect?.(connection)) ?? 'sqlite';
  const params = (q.params ?? []).map((p) => {
    const m = /^\$\{([\w.]+)\}$/.exec(p);
    if (m) return sqlParam(lookupVar(ctx.vars(), m[1]), m[1]);
    return ctx.interpolate(p);
  });
  const bound = bindSql(sql, params, ctx.vars(), dialect);
  return opts.db.query(connection, bound.sql, bound.params);
}

// ------------------------------------------------------------------ variables

const LINK_RE = /https?:\/\/[^\s"'<>)\]]+/g;

/**
 * "Set variable x to <expr>" and extraction:
 *   args.extract = { from: <expression>, kind: link | code | regex | jsonPath | header | status, pattern?, path?, name?, index? }
 */
export async function setAction(step: Step, ctx: StepContext): Promise<ActionOutcome> {
  const name = step.captureAs;
  if (!name) throw new EzTestError(`Step "${step.intent}" needs a variable name (captureAs)`, 'MISSING_CAPTURE_KEY');
  const ex = step.args?.extract as { from?: string; kind?: string; pattern?: string; path?: string; name?: string; index?: number } | undefined;
  let v: unknown;
  if (ex) {
    const src = evaluateExpression(String(ex.from), ctx.vars());
    const textOf = (x: unknown): string => {
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        const o = x as Record<string, unknown>;
        if (typeof o.text === 'string' || typeof o.html === 'string' || typeof o.body === 'string') {
          return [o.subject, o.text, o.html, o.body].filter((p) => typeof p === 'string').join('\n');
        }
      }
      return asText(x);
    };
    switch (ex.kind ?? 'regex') {
      case 'link': {
        const links = [...new Set(textOf(src).match(LINK_RE) ?? [])].map((l) => l.replace(/[.,;:]+$/, '').replace(/&amp;/g, '&'));
        const want = ex.pattern ? links.filter((l) => regex(ctx.interpolate(ex.pattern!)).test(l)) : links;
        v = want[ex.index ?? 0];
        if (v === undefined) throw new EzTestError(`no link${ex.pattern ? ` matching ${ex.pattern}` : ''} found in ${ex.from}`, 'NO_MATCH');
        break;
      }
      case 'code': {
        const re = ex.pattern ? regex(ctx.interpolate(ex.pattern)) : /\b(\d{4,8})\b/;
        const m = re.exec(textOf(src));
        if (!m) throw new EzTestError(`no code ${ex.pattern ? `matching ${ex.pattern} ` : ''}found in ${ex.from}`, 'NO_MATCH');
        v = m[1] ?? m[0];
        break;
      }
      case 'regex': {
        const m = regex(ctx.interpolate(ex.pattern ?? '')).exec(textOf(src));
        if (!m) throw new EzTestError(`"${ex.pattern}" does not match ${ex.from}`, 'NO_MATCH');
        v = m[1] ?? m[0];
        break;
      }
      case 'jsonPath': {
        const body = src && typeof src === 'object' && !Array.isArray(src) && 'status' in src && 'body' in src ? (src as { body: unknown }).body : src;
        v = getPath(body, ctx.interpolate(ex.path ?? '$'));
        if (v === undefined) throw new EzTestError(`${ex.path} not found in ${ex.from}`, 'NO_MATCH');
        break;
      }
      case 'header': {
        const h = (src as { headers?: Record<string, string> })?.headers ?? {};
        const key = Object.keys(h).find((k) => k.toLowerCase() === String(ex.name).toLowerCase());
        if (!key) throw new EzTestError(`${ex.from} has no header "${ex.name}"`, 'NO_MATCH');
        v = h[key];
        break;
      }
      case 'status': v = (src as { status?: number })?.status; break;
      case 'rows': {
        const rex = ex as { sheet?: string; delimiter?: string };
        v = await readRowsFile(src, String(ex.from), rex.sheet === undefined ? undefined : ctx.interpolate(rex.sheet), rex.delimiter);
        break;
      }
      default: throw new NotSupportedError(`extract "${ex.kind}"`);
    }
  } else {
    if (step.value === undefined) throw new EzTestError(`Step "${step.intent}" needs an expression`, 'MISSING_VALUE');
    v = evaluateExpression(step.value, ctx.vars());
  }
  ctx.ledger.set(name, v);
  return { captured: { [name]: v } };
}
