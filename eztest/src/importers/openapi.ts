/**
 * OpenAPI 3.x / Swagger 2.0 -> .ez API journeys. One journey per tag (or one
 * for untagged operations); create (POST) before read, update and delete, so
 * a later "/orders/{id}" step reuses the id the POST returned. Each operation
 * becomes an API call with example (or seeded, deterministic) path, query,
 * header and body values, an expected status, and a contract expectation
 * ("conforms to OpenAPI ...") so the run also validates responses.
 */
import { relative, resolve } from 'node:path';
import { quoteText } from '../intent/quotes.js';
import { generateValue } from '../contracts/generate.js';
import { buildSpec, parseSpecText, resolveSchemaRef, type ApiOperation, type ApiSpec } from '../contracts/openapi.js';
import { JourneyDraft } from './builder.js';
import { assembleReport } from './report.js';
import type { ImporterOptions, ImportReport } from './types.js';

export interface OpenApiImportOptions extends ImporterOptions {
  /** Identity Vault role the calls are made as ("as <role>"), for secured operations. */
  role?: string;
  /** Spec path written into the contract expectations (default: the file as given). */
  specRef?: string;
  /** Base URL header (default: none, so the config's baseUrl applies; the spec's servers are listed in a comment). */
  baseUrl?: string;
  /** Seed for generated values (default 42). */
  seed?: string | number;
  /** Group journeys by "tag" (default), or one journey per "operation". */
  groupBy?: 'tag' | 'operation';
  /** Absolute path of the spec (relative $refs resolve against it; default: `file` from the working directory). */
  absPath?: string;
  /** Also add steps for documented error responses that need no special input (401 without a role). Default false. */
  errorCases?: boolean;
}

const ORDER: Record<string, number> = { POST: 0, PUT: 2, PATCH: 2, GET: 1, HEAD: 1, OPTIONS: 1, DELETE: 3, TRACE: 4 };

function keyFor(op: ApiOperation, used: Set<string>): string {
  const base = (op.operationId ?? `${op.method.toLowerCase()}_${op.path.replace(/\{[^}]+\}/g, 'by').replace(/[^A-Za-z0-9]+/g, '_')}`)
    .replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').replace(/^_+|_+$/g, '') || 'response';
  let k = base;
  for (let n = 2; used.has(k); n++) k = `${base}${n}`;
  used.add(k);
  return k;
}

function scalarText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Import one spec document. */
export function importOpenApi(text: string, opts: OpenApiImportOptions = {}): ImportReport {
  const file = opts.file ?? 'openapi.yaml';
  const spec: ApiSpec = buildSpec(parseSpecText(text, file), opts.absPath ?? resolve(file));
  const ids = opts.ids ?? new Set<string>();
  const specRef = opts.specRef ?? file;
  const baseUrl = opts.baseUrl;
  const groups = new Map<string, ApiOperation[]>();
  for (const op of spec.operations) {
    const g = opts.groupBy === 'operation' ? op.id : op.tags[0] ?? 'api';
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(op);
  }
  const drafts: JourneyDraft[] = [];
  const warnings = [...spec.warnings.map((w) => `${file}: ${w}`)];
  for (const [group, ops] of groups) {
    ops.sort((a, b) => a.path.split('/').length - b.path.split('/').length || ORDER[a.method] - ORDER[b.method] || a.path.localeCompare(b.path));
    const name = opts.groupBy === 'operation' ? `${spec.title || 'API'}: ${ops[0].summary ?? ops[0].id}` : `${spec.title || 'API'}: ${group}`;
    const d = new JourneyDraft(name, {
      kind: 'openapi', file, line: 1, ids, tags: ['api', 'openapi', ...(opts.groupBy === 'operation' ? [] : [group]), ...(opts.tags ?? [])],
      ...(baseUrl ? { baseUrl } : {}), description: `Generated from ${spec.title || file} ${spec.apiVersion}`.trim(),
    });
    if (!baseUrl && spec.servers.length) d.comment(`servers in the spec: ${spec.servers.join(', ')} (the run uses baseUrl from the config)`);
    const used = new Set<string>();
    const created = new Map<string, { key: string; idProp: string }>();
    for (const op of ops) {
      const key = keyFor(op, used);
      const src = { line: 1, original: `${op.method} ${op.path}${op.summary ? ` (${op.summary})` : ''}` };
      if (op.deprecated) d.comment(`${op.id} is deprecated`);
      // Path parameters: the id a POST to the parent collection returned, else an example or seeded value.
      const parent = op.path.replace(/\/\{[^}]+\}$/, '');
      let path = op.path;
      for (const p of op.pathParams) {
        const decl = op.parameters.find((x) => x.in === 'path' && x.name === p);
        const prior = created.get(parent);
        const value = prior && op.path.endsWith(`{${p}}`) ? `\${${prior.key}.body.${prior.idProp}}` : encodeURIComponent(scalarText(decl?.example ?? generateValue(spec, decl?.schema, { seed: `${opts.seed ?? 42}|${op.id}|${p}` }, p)));
        path = path.replace(`{${p}}`, value);
      }
      const clauses: string[] = [];
      const query = op.parameters.filter((p) => p.in === 'query' && p.required);
      if (query.length) clauses.push(`with query ${query.map((p) => `${p.name}=${quoteText(scalarText(p.example ?? generateValue(spec, p.schema, { seed: `${opts.seed ?? 42}|${op.id}|${p.name}` }, p.name)))}`).join(', ')}`);
      for (const h of op.parameters.filter((p) => p.in === 'header' && p.required && !/^(?:authorization|content-type|accept)$/i.test(p.name))) {
        clauses.push(`with header ${quoteText(h.name)} = ${quoteText(scalarText(h.example ?? generateValue(spec, h.schema, { seed: `${opts.seed ?? 42}|${op.id}|${h.name}` }, h.name)))}`);
      }
      if (op.requestBody) {
        const [ct, media] = Object.entries(op.requestBody.content).find(([c]) => /json/.test(c)) ?? Object.entries(op.requestBody.content)[0] ?? [];
        const example = media ? media.example ?? (media.examples ? Object.values(media.examples)[0] : undefined) ?? generateValue(spec, media.schema, { seed: `${opts.seed ?? 42}|${op.id}|body` }) : undefined;
        if (ct && /x-www-form-urlencoded/.test(ct) && example && typeof example === 'object') {
          clauses.push(`with form ${Object.entries(example as Record<string, unknown>).map(([k, v]) => `${k}=${quoteText(scalarText(v))}`).join(', ')}`);
        } else if (ct && /json/.test(ct) && example !== undefined) {
          clauses.push(`with body ${quoteText(JSON.stringify(example))}`);
        } else if (op.requestBody.required) {
          d.addTodo(src, `request body ${ct ?? ''} cannot be generated; add "with body from file ..."`);
          continue;
        }
      }
      const role = op.security.length && opts.role ? ` as ${opts.role}` : '';
      // "with body" alone must come before the role (call-api grammar); other clauses follow the role.
      const onlyBody = clauses.length === 1 && clauses[0].startsWith('with body ');
      const line = onlyBody
        ? `Call API ${quoteText(`${op.method} ${path}`)} ${clauses[0]}${role} and store as ${key}`
        : `Call API ${quoteText(`${op.method} ${path}`)}${role}${clauses.length ? ` ${clauses.join(' ')}` : ''} and store as ${key}`;
      if (op.security.length && !opts.role) d.comment(`${op.id} needs ${op.security.join('/')} credentials: re-run the import with --role <role> or add "as <role>"`);
      if (!d.step(line, src, { action: 'api' })) continue;
      const success = Object.keys(op.responses).filter((c) => /^2\d\d$/.test(c)).sort()[0];
      if (success) d.expect(`response ${key} status is ${success}`, src);
      d.expect(`response ${key} conforms to OpenAPI ${quoteText(specRef)}`, src);
      // Remember POST results that carry an id, for later /{id} operations.
      if (op.method === 'POST' && success) {
        const schema = resolveSchemaRef(spec, Object.values(op.responses[success].content)[0]?.schema);
        const props = (schema?.properties ?? {}) as Record<string, unknown>;
        const idProp = ['id', 'uuid', 'key'].find((p) => p in props);
        if (idProp) created.set(op.path, { key, idProp });
      }
      if (opts.errorCases && op.security.length && op.responses['401']) {
        const ek = keyFor({ ...op, operationId: `${key}_unauthorized` } as ApiOperation, used);
        if (d.step(`Call API ${quoteText(`${op.method} ${path}`)} with errors allowed and store as ${ek}`, { ...src, original: `${src.original} without credentials` }, { action: 'api' })) {
          d.expect(`response ${ek} status is 401`, src);
          d.expect(`response ${ek} conforms to OpenAPI ${quoteText(specRef)}`, src);
        }
      }
    }
    drafts.push(d);
  }
  const report = assembleReport(drafts, [file], warnings);
  report.summary = { ...(report.summary ?? {}), openapi: { title: spec.title, version: spec.version, operations: spec.operations.length, journeys: report.journeys.length } };
  return report;
}

/** True for JSON/YAML text that is an OpenAPI or Swagger document. */
export function looksLikeOpenApi(text: string): boolean {
  return /^\s*["']?(?:openapi|swagger)["']?\s*:\s*["']?(?:3\.[01]|2\.0)/m.test(text) || /"(?:openapi|swagger)"\s*:\s*"(?:3\.[01]|2\.0)/.test(text.slice(0, 2000));
}

export function specRefFrom(file: string, outDir?: string, cwd = process.cwd()): string {
  const abs = resolve(cwd, file);
  // Journeys resolve relative files against the project directory (baseDir), so keep the path project-relative.
  const rel = relative(cwd, abs);
  return outDir && rel.startsWith('..') ? abs : rel.split('\\').join('/');
}
