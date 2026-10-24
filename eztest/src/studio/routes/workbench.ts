/**
 * API & DB workbench: compose REST, GraphQL and SOAP requests (auth as a
 * configured role, resolved on the server: tokens never reach the browser),
 * a JSONPath tester and JSON Schema validation, a SQL console that is
 * read-only unless writes are enabled for the session and confirmed per
 * statement, and "Save as step", which turns a request or query into
 * validated .ez lines and inserts them into a journey.
 *
 * Read-only enforcement per dialect (on top of the statement check):
 *   sqlite   -> the file is opened read-only
 *   postgres -> SET TRANSACTION READ ONLY
 *   mssql    -> run inside a transaction that is always rolled back
 *   oracle   -> SET TRANSACTION READ ONLY, always rolled back (DML fails with ORA-01456;
 *               DDL, which would commit implicitly, is blocked by the statement check)
 *
 * The Queries panel lists the named-query catalogue (db.queries), runs a query
 * with bound params through the same read-only path, and saves it as a step.
 *
 * Every call goes through EZTest's own surface clients (ApiClient, SOAP
 * helpers, DbClient), so behaviour matches what a run does.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { LoadedConfig } from '../../config/index.js';
import {
  ApiClient,
  DbRegistry,
  SqliteDbClient,
  loadSqlite,
  buildSoapEnvelope,
  parseSoapResponse,
  queryPath,
  validateSchema,
  type ApiAuth,
  type DbClient,
  type DbConnectionSpec,
  type RequestOptions,
  type OracleDbClient,
  type MysqlDbClient,
  type SqlDialect,
  type SqlValue,
} from '../../surfaces/index.js';
import { QueryCatalogue, type QueryValue } from '../../queries/index.js';
import { isPlsql } from '../../surfaces/db-sql.js';
import { queryStepToText } from '../../intent/index.js';
import { formatOf, validateText } from '../authoring.js';
import type { Step } from '../../core/index.js';
import { stepToText } from '../../intent/index.js';
import type { StudioApp } from '../app.js';
import { HttpError, sendJson } from '../http.js';
import { relPosix } from '../security.js';
import { activeEnvironment, listEnvironments } from './project-environments.js';
import { vaultFor } from './assurance-shared.js';
import type { StudioRoute } from './route.js';

const MAX_BODY_CHARS = 2_000_000;
const MAX_ROWS = 1000;

// ------------------------------------------------------------------ helpers

function vars(body: Record<string, unknown>, loaded: LoadedConfig): Record<string, string> {
  const v: Record<string, string> = { baseUrl: loaded.config.baseUrl ?? '' };
  const given = body.variables;
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    for (const [k, x] of Object.entries(given as Record<string, unknown>)) if (/^[A-Za-z_][\w.-]*$/.test(k)) v[k] = String(x ?? '');
  }
  return v;
}

/** `{{name}}` (double-brace) and `${name}` placeholders from the workbench variables. Unknown names stay as written. */
export function substitute(text: string, v: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}|\$\{([A-Za-z_][\w.-]*)\}/g, (whole, a?: string, b?: string) => {
    const k = (a ?? b) as string;
    return k in v ? v[k] : whole;
  });
}

function pairs(v: unknown): Array<[string, string]> {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x ?? {}) as Record<string, unknown>)
    .filter((x) => x.enabled !== false && typeof x.name === 'string' && x.name.trim())
    .map((x) => [String(x.name).trim(), String(x.value ?? '')] as [string, string]);
}

const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

async function roleAuth(app: StudioApp, loaded: LoadedConfig, role: unknown): Promise<ApiAuth | undefined> {
  if (typeof role !== 'string' || !role) return undefined;
  if (!loaded.config.identity.roles[role]) throw new HttpError(400, `Unknown role "${role}"`);
  if (!loaded.config.identity.roles[role].api) throw new HttpError(400, `Role "${role}" has no API credentials (identity.roles.${role}.api)`);
  return { type: 'oauth2', tokenProvider: await vaultFor(app, loaded).tokenProvider(role) };
}

function targetOf(rawUrl: string, loaded: LoadedConfig): { base?: string; path: string; display: string } {
  if (/^https?:\/\//i.test(rawUrl)) return { path: rawUrl, display: rawUrl };
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) throw new HttpError(400, 'Only http(s) URLs are allowed');
  const base = loaded.config.baseUrl;
  if (!base) throw new HttpError(400, 'Relative URLs need a baseUrl in the configuration (or type a full http(s) URL)');
  return { base, path: rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`, display: new URL(rawUrl, base).toString() };
}

// ------------------------------------------------------------------ send

export async function sendRequest(app: StudioApp, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const loaded = await app.config();
  const m = loaded.masker;
  const v = vars(body, loaded);
  const kind = body.kind === 'graphql' || body.kind === 'soap' ? body.kind : 'rest';
  const method = kind === 'rest' ? String(body.method ?? 'GET').toUpperCase() : 'POST';
  if (!/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(method)) throw new HttpError(400, `Unsupported method ${method}`);
  const url = substitute(String(body.url ?? '').trim(), v);
  if (!url) throw new HttpError(400, 'Enter a URL');
  const t = targetOf(url, loaded);
  const headers: Record<string, string> = {};
  for (const [k, x] of pairs(body.headers)) headers[k.toLowerCase()] = substitute(x, v);
  const query: Record<string, string> = {};
  for (const [k, x] of pairs(body.query)) query[k] = substitute(x, v);
  const timeoutMs = Math.min(120_000, Math.max(1000, Number(body.timeoutMs) || 30_000));
  const auth = await roleAuth(app, loaded, body.role);
  const api = new ApiClient({ baseUrl: t.base, timeoutMs, retry: false, masker: m, auth });
  const o: RequestOptions = { headers, query: Object.keys(query).length ? query : undefined };
  const text = typeof body.body === 'string' ? substitute(body.body, v) : '';
  if (kind === 'graphql') {
    const g = (body.graphql ?? {}) as Record<string, unknown>;
    const q = substitute(String(g.query ?? ''), v);
    if (!q.trim()) throw new HttpError(400, 'Enter a GraphQL query');
    let variables: unknown = {};
    if (typeof g.variables === 'string' && g.variables.trim()) {
      try {
        variables = JSON.parse(substitute(g.variables, v));
      } catch {
        throw new HttpError(400, 'GraphQL variables must be JSON');
      }
    }
    o.json = { query: q, variables, ...(typeof g.operationName === 'string' && g.operationName ? { operationName: g.operationName } : {}) };
    headers.accept ??= 'application/graphql-response+json, application/json';
  } else if (kind === 'soap') {
    const s = (body.soap ?? {}) as Record<string, unknown>;
    const version = s.version === '1.2' ? '1.2' : '1.1';
    const xml = substitute(String(s.body ?? text), v).trim();
    if (!xml) throw new HttpError(400, 'Enter the SOAP body (or a full envelope)');
    o.body = /<(?:\w+:)?Envelope[\s>]/.test(xml) ? xml : buildSoapEnvelope({ version, body: xml });
    const action = typeof s.action === 'string' ? s.action : '';
    if (version === '1.1') {
      headers['content-type'] ??= 'text/xml; charset=utf-8';
      headers.soapaction ??= `"${action}"`;
    } else headers['content-type'] ??= `application/soap+xml; charset=utf-8${action ? `; action="${action.replace(/"/g, '')}"` : ''}`;
    headers.accept ??= 'text/xml, application/soap+xml';
  } else if (method !== 'GET' && method !== 'HEAD' && text) {
    const bt = body.bodyType;
    if (bt === 'json') {
      try {
        o.json = JSON.parse(text);
      } catch (e) {
        throw new HttpError(400, `The body is not valid JSON: ${(e as Error).message}`);
      }
    } else if (bt === 'form') {
      o.form = Object.fromEntries(new URLSearchParams(text));
    } else o.body = text;
  }
  const started = Date.now();
  let res;
  try {
    res = await api.request(method, t.path, o);
  } catch (e) {
    return { ok: false, error: m.mask((e as Error).message), durationMs: Date.now() - started, request: { method, url: m.mask(t.display) } };
  }
  const truncated = res.text.length > MAX_BODY_CHARS;
  const textOut = m.mask(truncated ? res.text.slice(0, MAX_BODY_CHARS) : res.text);
  let json: unknown;
  if (/json/i.test(res.headers['content-type'] ?? '')) {
    try {
      json = m.maskDeep(JSON.parse(res.text));
    } catch {
      json = undefined;
    }
  }
  let soap: unknown;
  if (kind === 'soap') {
    try {
      const p = parseSoapResponse(res.text);
      soap = m.maskDeep({ fault: p.fault, body: p.body });
    } catch {
      soap = undefined;
    }
  }
  const respHeaders = Object.fromEntries(Object.entries(res.headers).map(([k, x]) => [k, SENSITIVE_HEADER.test(k) ? '••••' : m.mask(x)]));
  const reqHeaders = Object.fromEntries(Object.entries(headers).map(([k, x]) => [k, SENSITIVE_HEADER.test(k) ? '••••' : m.mask(x)]));
  if (auth) reqHeaders.authorization = `Bearer •••• (token of role ${String(body.role)}, resolved on the server)`;
  return {
    ok: true,
    status: res.status,
    statusText: res.statusText,
    durationMs: res.durationMs,
    size: Buffer.byteLength(res.text),
    headers: respHeaders,
    contentType: res.headers['content-type'] ?? '',
    text: textOut,
    truncated,
    json,
    soap,
    request: { method, url: m.mask(res.url), headers: reqHeaders, kind },
  };
}

// ------------------------------------------------------------------ SQL

/** Remove comments and string literals so keywords inside them do not count. */
function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]');
}

const WRITE_WORDS = /\b(?:insert|update|delete|merge|upsert|replace|create|drop|alter|truncate|grant|revoke|attach|detach|vacuum|reindex|exec|execute|call|copy|lock|set|begin|commit|rollback|savepoint|release)\b/i;

/** Classify one statement as read or write; anything not clearly a read is a write. */
export function classifySql(sql: string): { kind: 'read' | 'write'; reason: string; multiple: boolean } {
  const s = stripSql(sql).trim().replace(/;\s*$/, '');
  if (!s) throw new HttpError(400, 'Enter a SQL statement');
  // An Oracle PL/SQL block is one statement with inner ";" and may change anything: a write.
  if (isPlsql(sql)) return { kind: 'write', reason: 'a PL/SQL block can change the database', multiple: false };
  if (s.includes(';')) return { kind: 'write', reason: 'multiple statements are not allowed in the console', multiple: true };
  const first = /^\s*\(?\s*([A-Za-z]+)/.exec(s)?.[1]?.toLowerCase() ?? '';
  if (first === 'pragma') return /=|\(/.test(s) ? { kind: 'write', reason: 'PRAGMA with a value changes the database', multiple: false } : { kind: 'read', reason: 'PRAGMA query', multiple: false };
  if (['select', 'with', 'explain', 'show', 'describe', 'desc', 'values', 'table'].includes(first)) {
    if (WRITE_WORDS.test(s)) return { kind: 'write', reason: 'the statement contains a data-changing keyword', multiple: false };
    if (/\binto\b/i.test(s) && first === 'select') return { kind: 'write', reason: 'SELECT … INTO creates a table', multiple: false };
    return { kind: 'read', reason: `${first.toUpperCase()} statement`, multiple: false };
  }
  return { kind: 'write', reason: `${(first || 'this').toUpperCase()} changes the database`, multiple: false };
}

const WRITES = new WeakMap<StudioApp, boolean>();

function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (v instanceof Date) return v.toISOString();
  return v;
}

const ENFORCED: Record<string, string> = {
  postgres: 'READ ONLY transaction',
  mssql: 'transaction rolled back',
  oracle: 'READ ONLY transaction (rolled back)',
  mysql: 'READ ONLY transaction (rolled back)',
};

async function openForSql(app: StudioApp, loaded: LoadedConfig, name: string, readOnly: boolean): Promise<{ client: DbClient; close(): Promise<void>; enforced: string }> {
  const specs = loaded.config.db.connections as unknown as Record<string, DbConnectionSpec>;
  const spec = specs[name];
  if (!spec) throw new HttpError(400, `Unknown connection "${name}". Known: ${Object.keys(specs).join(', ') || 'none'}`);
  if (spec.driver === 'sqlite' && readOnly && spec.file !== ':memory:') {
    const mod = loadSqlite();
    if (!existsSync(spec.file)) throw new HttpError(404, `The SQLite file of "${name}" does not exist`);
    const db = new mod.DatabaseSync(spec.file, { readOnly: true });
    const client = new SqliteDbClient({ database: db, own: true, name });
    return { client, close: () => client.close(), enforced: 'read-only SQLite connection' };
  }
  // secret:// passwords resolve on the server through the configured secret stores.
  const reg = new DbRegistry(specs, { resolveSecret: (ref) => vaultFor(app, loaded).registry.resolve(ref) });
  const client = await reg.get(name);
  return { client, close: () => reg.closeAll(), enforced: ENFORCED[spec.driver] ?? 'statement check' };
}

class Rollback extends Error {
  constructor(readonly rows: Array<Record<string, unknown>>) {
    super('rollback');
  }
}

export async function runSql(app: StudioApp, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const loaded = await app.config();
  const name = String(body.connection ?? '');
  const sql = String(body.sql ?? '');
  const cls = classifySql(sql);
  const params = Array.isArray(body.params) ? (body.params as SqlValue[]) : [];
  if (cls.multiple) throw new HttpError(400, 'Run one statement at a time');
  const writesOn = WRITES.get(app) === true;
  if (cls.kind === 'write') {
    if (!writesOn) throw new HttpError(403, `Blocked: ${cls.reason}. The console is read-only; enable "Allow writes" for this session first.`, { blocked: true, kind: 'write' });
    if (body.confirm !== true) throw new HttpError(409, 'Confirm this write statement', { confirm: true, kind: 'write', reason: cls.reason });
  }
  const conn = await openForSql(app, loaded, name, cls.kind === 'read');
  const started = Date.now();
  try {
    if (cls.kind === 'write') {
      const r = await conn.client.execute(sql, params);
      app.hub.publish('workbench', { type: 'sql-write', connection: name });
      return { kind: 'write', rowsAffected: r.rowsAffected, lastInsertId: r.lastInsertId, durationMs: Date.now() - started, columns: [], rows: [] };
    }
    let rows: Array<Record<string, unknown>>;
    const driver = (loaded.config.db.connections[name] as { driver: string }).driver;
    if (driver === 'postgres') {
      rows = await conn.client.transaction(async (tx) => {
        await tx.execute('SET TRANSACTION READ ONLY');
        return tx.query(sql, params);
      });
    } else if (driver === 'oracle') {
      rows = await (conn.client as OracleDbClient).readOnly((tx) => tx.query(sql, params));
    } else if (driver === 'mysql') {
      rows = await (conn.client as MysqlDbClient).readOnly((tx) => tx.query(sql, params));
    } else if (driver === 'mssql') {
      try {
        await conn.client.transaction(async (tx) => {
          throw new Rollback(await tx.query(sql, params));
        });
        rows = [];
      } catch (e) {
        if (!(e instanceof Rollback)) throw e;
        rows = e.rows;
      }
    } else rows = await conn.client.query(sql, params);
    const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))];
    const truncated = rows.length > MAX_ROWS;
    const out = rows.slice(0, MAX_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, jsonSafe(x)])));
    return { kind: 'read', enforced: conn.enforced, columns, rows: loaded.masker.maskDeep(out), rowCount: rows.length, truncated, durationMs: Date.now() - started };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, loaded.masker.mask((e as Error).message));
  } finally {
    await conn.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ named-query catalogue

async function catalogueFor(app: StudioApp, loaded: LoadedConfig): Promise<QueryCatalogue> {
  try {
    return await QueryCatalogue.fromConfig(loaded.config.db.queries, app.cwd, loaded.config.db.connections);
  } catch (e) {
    throw new HttpError(422, (e as Error).message);
  }
}

export async function listCatalogue(app: StudioApp): Promise<Record<string, unknown>> {
  const loaded = await app.config();
  const cat = await catalogueFor(app, loaded);
  return {
    dir: loaded.config.db.queries.dir,
    queries: cat.all().map((q) => ({
      name: q.name,
      connection: q.connection ?? null,
      description: q.description ?? '',
      fragment: q.fragment,
      source: q.source,
      params: cat.paramsOf(q.name).map((p) => ({ name: p.name, type: p.type, ...(p.default !== undefined ? { default: p.default instanceof Date ? p.default.toISOString() : p.default } : {}) })),
      sql: cat.expand(q.name),
    })),
  };
}

function bindValues(v: unknown): Record<string, QueryValue> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, QueryValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z_]\w*$/.test(k)) throw new HttpError(400, `Invalid param name "${k}"`);
    out[k] = x === null || typeof x === 'number' || typeof x === 'boolean' ? x : String(x ?? '');
  }
  return out;
}

/** Run a catalogue query through the console path (bound params, read-only unless writes are on and confirmed). */
export async function runCatalogueQuery(app: StudioApp, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const loaded = await app.config();
  const cat = await catalogueFor(app, loaded);
  const name = String(body.name ?? '');
  const q = (() => {
    try {
      return cat.get(name);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  })();
  const connection = String(body.connection || q.connection || '');
  const spec = loaded.config.db.connections[connection] as { driver: SqlDialect } | undefined;
  if (!spec) throw new HttpError(400, connection ? `Unknown connection "${connection}"` : `Query "${name}" has no connection header; pick a connection`);
  const v = vars(body, loaded);
  const binds = Object.fromEntries(Object.entries(bindValues(body.binds)).map(([k, x]) => [k, typeof x === 'string' ? substitute(x, v) : x]));
  let compiled;
  try {
    compiled = cat.compile(name, { binds }, spec.driver);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const params = compiled.params.map((x) => (x instanceof Date ? x.toISOString() : x)) as SqlValue[];
  const r = await runSql(app, { connection, sql: compiled.sql, params, confirm: body.confirm === true });
  return { ...r, query: name, connection, sql: compiled.text };
}

// ------------------------------------------------------------------ save as step

const KEY = /^[A-Za-z_][\w.-]*$/;

function quoteFor(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('`')) return `\`${s}\``;
  throw new HttpError(400, 'The value contains every kind of quote and cannot be written as a step');
}

/** JSONPath ($.a[0].b) to the ledger's dotted path (a.0.b); wildcards and filters are not expressible. */
export function jsonPathToLedger(path: string): string {
  const p = path.trim();
  if (!p.startsWith('$')) throw new HttpError(400, `JSONPath must start with "$": ${p}`);
  const parts: string[] = [];
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/gy;
  re.lastIndex = 1;
  let consumed = 1;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(p))) {
    parts.push(mm[1] ?? mm[2] ?? mm[3]);
    consumed = re.lastIndex;
  }
  if (consumed !== p.length) throw new HttpError(400, `Only simple JSONPaths ($.a.b[0]) can become steps: ${p}`);
  if (parts.some((x) => !/^[\w-]+$/.test(x))) throw new HttpError(400, `Keys with dots or spaces cannot become steps: ${p}`);
  return parts.join('.');
}

export function buildStepLines(body: Record<string, unknown>): string[] {
  const kind = body.kind;
  const capture = String(body.captureAs ?? (kind === 'sql' || kind === 'query' ? 'rows' : 'response')).trim();
  if (!KEY.test(capture)) throw new HttpError(400, 'Store as: letters, digits, "_" or "-", starting with a letter');
  const asserts = Array.isArray(body.assertions) ? (body.assertions as Array<Record<string, unknown>>) : [];
  const lines: string[] = [];
  if (kind === 'query') {
    const name = String(body.query ?? '');
    if (!/^[A-Za-z_][\w.-]*$/.test(name)) throw new HttpError(400, 'Pick a query');
    const conn = String(body.connection ?? '');
    if (conn && !/^[\w.-]+$/.test(conn)) throw new HttpError(400, 'Invalid connection');
    const binds: Record<string, string | number | boolean | null> = {};
    for (const [k, x] of Object.entries(bindValues(body.binds))) binds[k] = x instanceof Date ? x.toISOString() : x;
    lines.push(queryStepToText({ db: { connection: conn, sql: '', query: name, ...(Object.keys(binds).length ? { binds } : {}) }, captureAs: capture })!);
    for (const a of asserts) {
      if (a.type === 'rows') {
        const n = Number(a.value);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'Row count must be a whole number');
        lines.push(`Expect the query ${capture} returns ${n} rows`);
      }
    }
    return lines;
  }
  if (kind === 'sql') {
    const conn = String(body.connection ?? '');
    if (!/^[\w.-]+$/.test(conn)) throw new HttpError(400, 'Pick a connection');
    const sql = String(body.sql ?? '').trim().replace(/;\s*$/, '').replace(/\s+/g, ' ');
    if (!sql) throw new HttpError(400, 'Enter a SQL statement');
    lines.push(stepToText({ id: 'workbench', intent: '', action: 'db', db: { connection: conn, sql, ...(Array.isArray(body.params) && body.params.length ? { params: body.params } : {}) }, captureAs: capture, postconditions: [], evidence: [] } as unknown as Step));
    for (const a of asserts) {
      if (a.type === 'rows') {
        const n = Number(a.value);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'Row count must be a whole number');
        lines.push(`Expect the query ${capture} returns ${n} rows`);
      } else if (a.type === 'value') {
        lines.push(`Expect the captured value ${capture}.${jsonPathToLedger(String(a.path ?? ''))} equals ${quoteFor(String(a.value ?? ''))}`);
      }
    }
    return lines;
  }
  const method = kind === 'graphql' || kind === 'soap' ? 'POST' : String(body.method ?? 'GET').toUpperCase();
  const url = String(body.url ?? '').trim();
  if (!url.startsWith('/')) throw new HttpError(400, 'Steps call paths relative to the baseUrl: use a URL starting with "/"');
  if (/\s/.test(url)) throw new HttpError(400, 'The URL must not contain spaces');
  const call: Record<string, unknown> = { method, url };
  if (typeof body.role === 'string' && body.role) call.asRole = body.role;
  if (kind === 'graphql') {
    const g = (body.graphql ?? {}) as Record<string, unknown>;
    const q = String(g.query ?? '').trim();
    if (!q) throw new HttpError(400, 'Enter a GraphQL query');
    let variables: Record<string, unknown> | undefined;
    if (typeof g.variables === 'string' && g.variables.trim()) {
      try {
        variables = JSON.parse(g.variables) as Record<string, unknown>;
      } catch {
        throw new HttpError(400, 'GraphQL variables must be JSON');
      }
    }
    call.graphql = { query: q.replace(/\s+/g, ' '), ...(variables && Object.keys(variables).length ? { variables } : {}) };
  } else if (kind === 'soap') {
    const so = (body.soap ?? {}) as Record<string, unknown>;
    const xml = String(so.body ?? '').trim().replace(/>\s+</g, '><');
    if (!xml) throw new HttpError(400, 'Enter the SOAP body');
    call.soap = { action: typeof so.action === 'string' ? so.action : '', body: xml, ...(so.version === '1.2' ? { version: '1.2' } : {}) };
  } else {
    const headers = Object.fromEntries(pairs(body.headers).filter(([k]) => !['accept', 'content-type'].includes(k.toLowerCase())));
    if (Object.keys(headers).length) call.headers = headers;
    const query = Object.fromEntries(pairs(body.query));
    if (Object.keys(query).length) call.query = query;
    if (method !== 'GET' && method !== 'HEAD' && typeof body.body === 'string' && body.body.trim()) {
      if (body.bodyType === 'form') call.form = Object.fromEntries(new URLSearchParams(body.body));
      else if (body.bodyType === 'json') {
        try {
          call.body = JSON.parse(body.body);
        } catch {
          throw new HttpError(400, 'The body is not valid JSON');
        }
      } else call.body = body.body;
    }
  }
  // The official serializer writes the phrasing the parser reads back (docs/ez-language.md). Its
  // "with body" clause is only parsed last among the option clauses, so it is appended there.
  const hasOptions = !!(call.headers || call.query || call.form);
  const bodyValue = call.body;
  if (hasOptions) delete call.body;
  let line = stepToText({ id: 'workbench', intent: '', action: 'api', api: call, captureAs: capture, postconditions: [], evidence: [] } as unknown as Step);
  if (hasOptions && bodyValue !== undefined) {
    const at = line.lastIndexOf(' and store as ');
    line = `${line.slice(0, at)} with body ${quoteFor(typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue))}${line.slice(at)}`;
  }
  lines.push(line);
  for (const a of asserts) {
    if (a.type === 'status') {
      const n = Number(a.value);
      if (!Number.isInteger(n) || n < 100 || n > 599) throw new HttpError(400, 'Status must be a 3-digit HTTP status');
      lines.push(`Expect the ${capture} response status is ${n}`);
    } else if (a.type === 'jsonpath') {
      const p = String(a.path ?? '').trim();
      if (!p.startsWith('$') || p.includes('"')) throw new HttpError(400, `JSONPath must start with "$": ${p}`);
      lines.push(`Expect response ${capture} "${p}" equals ${quoteFor(String(a.value ?? ''))}`);
    }
  }
  return lines;
}

function validateLines(lines: string[]): { ok: boolean; errors: Array<{ line?: number; message: string; suggestions: string[] }> } {
  const text = ['Journey: Workbench step check', '', ...lines].join('\n');
  const r = validateText(text, 'ez');
  return { ok: r.ok, errors: r.errors.map((e) => ({ ...e, line: e.line !== undefined ? e.line - 2 : undefined })) };
}

// ------------------------------------------------------------------ routes

export const workbenchRoutes: StudioRoute[] = [
  {
    method: 'GET',
    path: '/api/workbench/context',
    summary: 'Environments, roles, connections and journeys for the workbench',
    async handler({ res, app }) {
      const envs = await listEnvironments(app);
      try {
        const loaded = await app.config();
        const c = loaded.config;
        const { listJourneys } = await import('../authoring.js');
        const journeys = (await listJourneys(app.cwd, c.journeysDir)).filter((j) => j.format === 'ez').map((j) => ({ path: j.path, name: j.name ?? j.path }));
        sendJson(res, 200, {
          environment: activeEnvironment(app).name ?? null,
          environments: envs.map((e) => e.name),
          baseUrl: c.baseUrl ? loaded.masker.mask(c.baseUrl) : undefined,
          roles: Object.entries(c.identity.roles).map(([name, r]) => ({ name, api: !!r.api })),
          connections: Object.entries(c.db.connections).map(([name, x]) => ({ name, driver: x.driver })),
          journeys,
          writesEnabled: WRITES.get(app) === true,
        });
      } catch (e) {
        sendJson(res, 200, { environment: activeEnvironment(app).name ?? null, environments: envs.map((e) => e.name), roles: [], connections: [], journeys: [], writesEnabled: false, error: (e as Error).message });
      }
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/send',
    summary: 'Send a REST, GraphQL or SOAP request through the EZTest API client (auth as a role, secrets masked)',
    async handler({ res, app, body }) {
      sendJson(res, 200, await sendRequest(app, body));
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/jsonpath',
    summary: 'Evaluate a JSONPath against JSON',
    handler({ res, body }) {
      let data = body.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          throw new HttpError(400, 'The data is not valid JSON');
        }
      }
      try {
        const values = queryPath(data, String(body.path ?? '$'));
        sendJson(res, 200, { values, count: values.length, ledgerPath: (() => { try { return jsonPathToLedger(String(body.path ?? '$')); } catch { return undefined; } })() });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/schema',
    summary: 'Validate JSON against a JSON Schema',
    handler({ res, body }) {
      const parse = (v: unknown, what: string) => {
        if (typeof v !== 'string') return v;
        try {
          return JSON.parse(v);
        } catch {
          throw new HttpError(400, `The ${what} is not valid JSON`);
        }
      };
      try {
        sendJson(res, 200, validateSchema(parse(body.data, 'data'), parse(body.schema, 'schema') as Record<string, unknown>));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    },
  },
  {
    method: 'GET',
    path: '/api/workbench/sql/mode',
    summary: 'Whether SQL writes are enabled for this Studio session',
    handler({ res, app }) {
      sendJson(res, 200, { writesEnabled: WRITES.get(app) === true });
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/sql/mode',
    summary: 'Enable or disable SQL writes for this Studio session (each write still needs confirmation)',
    handler({ res, app, body }) {
      const on = body.allowWrites === true;
      if (on && body.confirm !== true) throw new HttpError(409, 'Confirm enabling writes', { confirm: true });
      WRITES.set(app, on);
      sendJson(res, 200, { writesEnabled: on });
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/sql/classify',
    summary: 'Read or write? (the console blocks writes by default)',
    handler({ res, body }) {
      sendJson(res, 200, classifySql(String(body.sql ?? '')));
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/sql',
    summary: 'Run one parameterized SQL statement on a configured connection (read-only by default)',
    async handler({ res, app, body }) {
      sendJson(res, 200, await runSql(app, body));
    },
  },
  {
    method: 'GET',
    path: '/api/workbench/queries',
    summary: 'The named-query catalogue (db.queries): names, connections, params and expanded SQL',
    async handler({ res, app }) {
      sendJson(res, 200, await listCatalogue(app));
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/queries/run',
    summary: 'Run a catalogue query with bound params (read-only by default, like the SQL console)',
    async handler({ res, app, body }) {
      sendJson(res, 200, await runCatalogueQuery(app, body));
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/step',
    summary: 'Turn a request or query (with assertions) into validated .ez step lines',
    handler({ res, body }) {
      const lines = buildStepLines(body);
      sendJson(res, 200, { lines, ...validateLines(lines) });
    },
  },
  {
    method: 'POST',
    path: '/api/workbench/insert',
    summary: 'Insert step lines into an .ez journey (the result must validate)',
    async handler({ res, app, body }) {
      const abs = await app.journeyPath(body.path);
      if (formatOf(abs) !== 'ez') throw new HttpError(400, 'Steps can be inserted into .ez journeys only');
      if (!existsSync(abs)) throw new HttpError(404, 'Journey not found');
      const lines = Array.isArray(body.lines) ? body.lines.map(String).filter((l) => l.trim()) : [];
      if (!lines.length) throw new HttpError(400, 'No lines to insert');
      if (lines.some((l) => /[\r\n]/.test(l))) throw new HttpError(400, 'One step per line');
      const check = validateLines(lines);
      if (!check.ok) throw new HttpError(422, `The step does not validate: ${check.errors.map((e) => e.message).join('; ')}`);
      const before = await readFile(abs, 'utf8');
      const rows = before.replace(/\s+$/, '').split('\n');
      const at = Number.isInteger(body.afterLine) && (body.afterLine as number) >= 1 && (body.afterLine as number) <= rows.length ? (body.afterLine as number) : rows.length;
      rows.splice(at, 0, ...lines);
      const after = rows.join('\n') + '\n';
      const r = validateText(after, 'ez');
      if (!r.ok) throw new HttpError(422, `The journey would not validate: ${r.errors.map((e) => `${e.line ? `line ${e.line}: ` : ''}${e.message}`).join('; ')}`);
      await writeFile(abs, after);
      sendJson(res, 200, { ok: true, path: relPosix(app.cwd, abs), insertedAt: at + 1, lines, journey: r.journey });
    },
  },
];
