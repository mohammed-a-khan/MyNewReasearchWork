/**
 * OpenAPI 3.0 / 3.1 and Swagger 2.0 specs: loading (YAML or JSON, local and
 * relative-file $refs), one normalised operation model for all three
 * versions, request-to-operation matching, and request/response validation
 * with JSON pointers in every violation. Schemas are validated with ajv
 * (draft-07 for 3.0/2.0 after converting OpenAPI-only keywords; 2020-12 for 3.1).
 * Nothing is fetched from the network and nothing is evaluated.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import AjvModule from 'ajv';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { EzTestError } from '../core/index.js';

type Json = Record<string, unknown>;
type ValidateFn = ((data: unknown) => boolean) & { errors?: AjvError[] | null };
interface AjvError { instancePath: string; keyword: string; message?: string; params?: Record<string, unknown> }
interface AjvLike { compile(schema: object): ValidateFn; addSchema(schema: object, key?: string): unknown; addFormat(name: string, f: unknown): unknown }

const AjvCtor = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (o: object) => AjvLike;
const Ajv2020Ctor = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (o: object) => AjvLike;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: AjvLike) => void;

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
export const HTTP_METHODS: HttpMethod[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export interface ApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  /** JSON Schema of the value (converted). */
  schema?: Json;
  description?: string;
  example?: unknown;
  deprecated?: boolean;
}

export interface ApiMedia {
  schema?: Json;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface ApiResponseSpec {
  description?: string;
  headers: Record<string, { required: boolean; schema?: Json }>;
  /** Media type -> schema. Empty when the response has no body. */
  content: Record<string, ApiMedia>;
}

export interface ApiOperation {
  /** operationId, or "METHOD /path" when the spec has none. */
  id: string;
  operationId?: string;
  method: Uppercase<HttpMethod>;
  /** Path template as written in the spec, e.g. /orders/{id}. */
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated: boolean;
  parameters: ApiParameter[];
  requestBody?: { required: boolean; content: Record<string, ApiMedia> };
  /** Status code ("200", "2XX", "default") -> response. */
  responses: Record<string, ApiResponseSpec>;
  /** Security requirement names (informational). */
  security: string[];
  /** Matching: literal segments count higher than templated ones. */
  readonly specificity: number;
  readonly pathRe: RegExp;
  readonly pathParams: string[];
}

export interface ApiSpec {
  /** Absolute path of the root file (or "inline"). */
  file: string;
  /** "2.0", "3.0.x" or "3.1.x". */
  version: string;
  title: string;
  apiVersion: string;
  /** Base paths from servers / basePath (e.g. "/v1"); "" when none. */
  basePaths: string[];
  /** Full server URLs as written (for imports). */
  servers: string[];
  operations: ApiOperation[];
  /** Named schemas reachable as `#/definitions/<name>` from operation schemas. */
  definitions: Record<string, Json>;
  /** The raw root document (after YAML parsing), for lint rules. */
  raw: Json;
  securitySchemes: Record<string, Json>;
  /** Problems found while loading (unresolvable refs, ...). Loading never silently drops them. */
  warnings: string[];
}

export interface Violation {
  /** Where the problem is: request or response. */
  side: 'request' | 'response';
  kind: 'unknown-operation' | 'status' | 'content-type' | 'header' | 'body' | 'parameter';
  /** JSON pointer into the body (body violations), or the parameter/header name. */
  pointer?: string;
  message: string;
}

export interface ValidationResult {
  operation?: string;
  method: string;
  path: string;
  status?: number;
  valid: boolean;
  violations: Violation[];
}

// ------------------------------------------------------------------ loading

interface Doc {
  file: string;
  root: unknown;
}

function readDoc(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new EzTestError(`Cannot read API spec ${file}: ${(e as Error).message}`, 'SPEC_NOT_FOUND');
  }
  return parseSpecText(text, file);
}

/** Parse spec text (JSON or YAML). */
export function parseSpecText(text: string, file = 'inline'): unknown {
  try {
    return /^\s*[{[]/.test(text) ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 1000 });
  } catch (e) {
    throw new EzTestError(`API spec ${file} is not valid JSON or YAML: ${(e as Error).message}`, 'SPEC_INVALID');
  }
}

function unescapePointer(p: string): string {
  return decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~');
}

function atPointer(root: unknown, pointer: string): unknown {
  if (!pointer || pointer === '#' || pointer === '/') return root;
  const parts = pointer.replace(/^#?\//, '').split('/').map(unescapePointer);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Json)) cur = (cur as Json)[p];
    else return undefined;
  }
  return cur;
}

class Loader {
  private readonly docs = new Map<string, Doc>();
  readonly warnings: string[] = [];
  /** Mangled definition name per (file#pointer) of a schema ref. */
  private readonly names = new Map<string, string>();
  readonly definitions: Record<string, Json> = {};
  private readonly pending: Array<{ key: string; doc: Doc; pointer: string }> = [];

  constructor(readonly openapi31: boolean, readonly defsKeyword: 'definitions' | '$defs') {}

  doc(file: string, root?: unknown): Doc {
    let d = this.docs.get(file);
    if (!d) {
      d = { file, root: root ?? readDoc(file) };
      this.docs.set(file, d);
    }
    return d;
  }

  /** Resolve a $ref relative to a document: [doc, pointer]. */
  locate(ref: string, from: Doc): { doc: Doc; pointer: string } {
    const [filePart, pointer = ''] = ref.split('#');
    if (/^https?:/i.test(filePart)) throw new EzTestError(`Remote $ref "${ref}" is not fetched; download it next to the spec`, 'SPEC_REF');
    const doc = filePart ? this.doc(resolve(dirname(from.file === 'inline' ? process.cwd() + '/x' : from.file), filePart)) : from;
    return { doc, pointer: pointer ? `#${pointer}` : '#' };
  }

  /** Dereference a non-schema object ($ref chains followed). */
  deref<T = Json>(value: unknown, from: Doc, seen = new Set<string>()): { value: T | undefined; doc: Doc } {
    let v = value;
    let doc = from;
    while (v && typeof v === 'object' && typeof (v as Json).$ref === 'string') {
      const ref = (v as Json).$ref as string;
      const at = this.locate(ref, doc);
      const key = `${at.doc.file}${at.pointer}`;
      if (seen.has(key)) throw new EzTestError(`Circular $ref ${ref}`, 'SPEC_REF');
      seen.add(key);
      doc = at.doc;
      v = atPointer(doc.root, at.pointer);
      if (v === undefined) {
        this.warnings.push(`unresolved $ref ${ref} (in ${from.file})`);
        return { value: undefined, doc };
      }
    }
    return { value: v as T, doc };
  }

  private nameFor(doc: Doc, pointer: string, rootFile: string): string {
    const key = `${doc.file}${pointer}`;
    let n = this.names.get(key);
    if (n) return n;
    const local = /^#\/(?:components\/schemas|definitions)\/([^/]+)$/.exec(pointer);
    let base = local && doc.file === rootFile ? unescapePointer(local[1]) : `${doc.file.split(/[\\/]/).pop()?.replace(/\.\w+$/, '') ?? 'ext'}_${pointer.replace(/^#\/?/, '').replace(/[^\w.-]+/g, '_')}`;
    base = base.replace(/[^\w.-]+/g, '_') || 'schema';
    n = base;
    for (let i = 2; [...this.names.values()].includes(n); i++) n = `${base}_${i}`;
    this.names.set(key, n);
    this.pending.push({ key: n, doc, pointer });
    return n;
  }

  /**
   * Convert an OpenAPI schema into JSON Schema: refs become refs into the bundled
   * definitions, OpenAPI 3.0 `nullable`, boolean exclusive bounds and
   * vendor/doc keywords are translated or dropped.
   */
  schema(s: unknown, doc: Doc, rootFile: string, specId: string): Json | undefined {
    if (s === true || s === false) return s as unknown as Json;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
    const o = s as Json;
    if (typeof o.$ref === 'string') {
      const at = this.locate(o.$ref, doc);
      if (atPointer(at.doc.root, at.pointer) === undefined) {
        this.warnings.push(`unresolved schema $ref ${o.$ref} (in ${doc.file})`);
        return {};
      }
      const name = this.nameFor(at.doc, at.pointer, rootFile);
      const ref: Json = { $ref: `${specId}#/${this.defsKeyword}/${name}` };
      // OpenAPI 3.1 allows siblings next to $ref.
      if (this.openapi31) {
        const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== '$ref'));
        if (Object.keys(rest).length) return { allOf: [ref, this.schema(rest, doc, rootFile, specId) ?? {}] };
      }
      return ref;
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith('x-')) continue;
      switch (k) {
        case 'nullable': case 'discriminator': case 'xml': case 'externalDocs': case 'deprecated':
          break;
        case 'properties': case 'patternProperties': case 'definitions': case '$defs':
          out[k] = Object.fromEntries(Object.entries((v ?? {}) as Json).map(([pk, pv]) => [pk, this.schema(pv, doc, rootFile, specId) ?? {}]));
          break;
        case 'items':
          out.items = Array.isArray(v) ? v.map((x) => this.schema(x, doc, rootFile, specId) ?? {}) : this.schema(v, doc, rootFile, specId) ?? {};
          break;
        case 'additionalProperties': case 'not': case 'contains': case 'propertyNames': case 'if': case 'then': case 'else': case 'additionalItems': case 'unevaluatedProperties': case 'unevaluatedItems':
          out[k] = typeof v === 'boolean' ? v : this.schema(v, doc, rootFile, specId) ?? {};
          break;
        case 'allOf': case 'anyOf': case 'oneOf': case 'prefixItems':
          out[k] = (Array.isArray(v) ? v : []).map((x) => this.schema(x, doc, rootFile, specId) ?? {});
          break;
        case 'exclusiveMinimum': case 'exclusiveMaximum':
          if (typeof v === 'boolean') {
            const bound = k === 'exclusiveMinimum' ? 'minimum' : 'maximum';
            if (v && typeof o[bound] === 'number') out[k] = o[bound];
          } else out[k] = v;
          break;
        case 'minimum': case 'maximum':
          if (!(o[k === 'minimum' ? 'exclusiveMinimum' : 'exclusiveMaximum'] === true)) out[k] = v;
          break;
        default:
          out[k] = v;
      }
    }
    // OpenAPI 3.0 nullable: true -> allow null.
    if (o.nullable === true) {
      if (typeof out.type === 'string') out.type = [out.type, 'null'];
      else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null'];
      else if (!out.type) return { anyOf: [out, { type: 'null' }] };
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    }
    return out;
  }

  /** Convert every schema referenced so far (and what those reference) into `definitions`. */
  drain(rootFile: string, specId: string): void {
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      this.definitions[p.key] = this.schema(atPointer(p.doc.root, p.pointer), p.doc, rootFile, specId) ?? {};
    }
  }
}

let specCounter = 0;

/** Load an API spec from a file. */
export function loadApiSpec(file: string): ApiSpec {
  const abs = resolve(file);
  return buildSpec(readDoc(abs), abs);
}

/** Build a spec from an already-parsed document (file is used to resolve relative $refs). */
export function buildSpec(root: unknown, file = 'inline'): ApiSpec {
  if (!root || typeof root !== 'object') throw new EzTestError(`API spec ${file} is empty`, 'SPEC_INVALID');
  const r = root as Json;
  const version = typeof r.openapi === 'string' ? r.openapi : typeof r.swagger === 'string' ? r.swagger : '';
  if (!/^(?:2\.0|3\.[01]\.\d+|3\.[01])$/.test(version)) {
    throw new EzTestError(`${file} is not an OpenAPI 3.0/3.1 or Swagger 2.0 document (openapi/swagger field is "${version || 'missing'}")`, 'SPEC_INVALID');
  }
  const is31 = version.startsWith('3.1');
  const isSwagger = version === '2.0';
  const loader = new Loader(is31, is31 ? '$defs' : 'definitions');
  const doc = loader.doc(file, root);
  const specId = `eztest-spec-${++specCounter}`;
  const sch = (s: unknown, d: Doc = doc) => loader.schema(s, d, file, specId);
  const info = (r.info ?? {}) as Json;

  const servers: string[] = [];
  const basePaths: string[] = [];
  if (isSwagger) {
    const bp = typeof r.basePath === 'string' ? r.basePath.replace(/\/$/, '') : '';
    basePaths.push(bp);
    const host = typeof r.host === 'string' ? r.host : undefined;
    const scheme = Array.isArray(r.schemes) && r.schemes.length ? String(r.schemes[0]) : 'https';
    if (host) servers.push(`${scheme}://${host}${bp}`);
  } else {
    for (const s of (Array.isArray(r.servers) ? r.servers : []) as Json[]) {
      let url = String(s.url ?? '');
      for (const [k, v] of Object.entries((s.variables ?? {}) as Record<string, Json>)) url = url.split(`{${k}}`).join(String(v.default ?? ''));
      servers.push(url);
      try {
        basePaths.push(new URL(url, 'http://x').pathname.replace(/\/$/, ''));
      } catch {
        basePaths.push('');
      }
    }
  }
  if (!basePaths.length) basePaths.push('');

  const globalConsumes = Array.isArray(r.consumes) ? (r.consumes as string[]) : ['application/json'];
  const globalProduces = Array.isArray(r.produces) ? (r.produces as string[]) : ['application/json'];
  const globalSecurity = Array.isArray(r.security) ? (r.security as Json[]) : [];
  const operations: ApiOperation[] = [];
  const paths = (r.paths ?? {}) as Json;
  for (const [path, rawItem] of Object.entries(paths)) {
    if (!path.startsWith('/')) continue;
    const { value: item, doc: itemDoc } = loader.deref<Json>(rawItem, doc);
    if (!item) continue;
    const shared = (Array.isArray(item.parameters) ? item.parameters : []) as unknown[];
    for (const m of HTTP_METHODS) {
      const op = item[m] as Json | undefined;
      if (!op || typeof op !== 'object') continue;
      const params = new Map<string, ApiParameter>();
      let body: ApiOperation['requestBody'];
      const formFields: Record<string, Json> = {};
      const formRequired: string[] = [];
      const consumes = Array.isArray(op.consumes) ? (op.consumes as string[]) : globalConsumes;
      const produces = Array.isArray(op.produces) ? (op.produces as string[]) : globalProduces;
      for (const raw of [...shared, ...((Array.isArray(op.parameters) ? op.parameters : []) as unknown[])]) {
        const { value: p, doc: pd } = loader.deref<Json>(raw, itemDoc);
        if (!p || typeof p.name !== 'string' || typeof p.in !== 'string') continue;
        if (p.in === 'body') {
          body = { required: p.required === true, content: Object.fromEntries(consumes.map((ct) => [ct, { schema: sch(p.schema, pd) }])) };
          continue;
        }
        if (p.in === 'formData') {
          formFields[p.name] = sch(swaggerParamSchema(p), pd) ?? {};
          if (p.required) formRequired.push(p.name);
          continue;
        }
        const schema = isSwagger ? sch(swaggerParamSchema(p), pd) : p.schema ? sch(p.schema, pd) : contentSchema(p.content, (s) => sch(s, pd));
        params.set(`${p.in}:${p.name}`, {
          name: p.name, in: p.in as ApiParameter['in'], required: p.in === 'path' || p.required === true, ...(schema ? { schema } : {}),
          ...(typeof p.description === 'string' ? { description: p.description } : {}),
          ...(p.example !== undefined ? { example: p.example } : p.schema && (p.schema as Json).example !== undefined ? { example: (p.schema as Json).example } : p['x-example'] !== undefined ? { example: p['x-example'] } : {}),
          ...(p.deprecated === true ? { deprecated: true } : {}),
        });
      }
      if (Object.keys(formFields).length) {
        body = { required: formRequired.length > 0, content: Object.fromEntries(consumes.map((ct) => [ct, { schema: { type: 'object', properties: formFields, ...(formRequired.length ? { required: formRequired } : {}) } }])) };
      }
      if (!isSwagger && op.requestBody) {
        const { value: rb, doc: rbd } = loader.deref<Json>(op.requestBody, itemDoc);
        if (rb) body = { required: rb.required === true, content: media(rb.content, (s) => sch(s, rbd)) };
      }
      const responses: Record<string, ApiResponseSpec> = {};
      for (const [code, rawRes] of Object.entries((op.responses ?? {}) as Json)) {
        const { value: res, doc: rd } = loader.deref<Json>(rawRes, itemDoc);
        if (!res) continue;
        const headers: ApiResponseSpec['headers'] = {};
        for (const [hn, rawH] of Object.entries((res.headers ?? {}) as Json)) {
          const { value: h, doc: hd } = loader.deref<Json>(rawH, rd);
          if (!h) continue;
          headers[hn.toLowerCase()] = { required: h.required === true, ...(isSwagger ? { schema: sch(swaggerParamSchema(h), hd) } : h.schema ? { schema: sch(h.schema, hd) } : {}) };
        }
        const content: Record<string, ApiMedia> = isSwagger
          ? res.schema
            ? Object.fromEntries(produces.map((ct) => [ct, { schema: sch(res.schema, rd), ...(res.examples && (res.examples as Json)[ct] !== undefined ? { example: (res.examples as Json)[ct] } : {}) }]))
            : {}
          : media(res.content, (s) => sch(s, rd));
        responses[String(code).toUpperCase() === 'DEFAULT' ? 'default' : String(code).toUpperCase()] = { ...(typeof res.description === 'string' ? { description: res.description } : {}), headers, content };
      }
      const security = (Array.isArray(op.security) ? (op.security as Json[]) : globalSecurity).flatMap((s) => Object.keys(s));
      const segs = path.split('/').filter(Boolean);
      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
      const reSrc = path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}|\{[^}]+\}/g, '([^/]+)');
      operations.push({
        id: typeof op.operationId === 'string' && op.operationId ? op.operationId : `${m.toUpperCase()} ${path}`,
        ...(typeof op.operationId === 'string' && op.operationId ? { operationId: op.operationId } : {}),
        method: m.toUpperCase() as Uppercase<HttpMethod>,
        path,
        ...(typeof op.summary === 'string' ? { summary: op.summary } : {}),
        ...(typeof op.description === 'string' ? { description: op.description } : {}),
        tags: Array.isArray(op.tags) ? (op.tags as string[]) : [],
        deprecated: op.deprecated === true,
        parameters: [...params.values()],
        ...(body ? { requestBody: body } : {}),
        responses,
        security,
        specificity: segs.filter((s) => !s.includes('{')).length * 100 + segs.length,
        pathRe: new RegExp(`^${reSrc}/?$`),
        pathParams,
      });
    }
  }
  loader.drain(file, specId);
  const securitySchemes = (isSwagger ? r.securityDefinitions : ((r.components ?? {}) as Json).securitySchemes) as Record<string, Json> | undefined;
  const spec: ApiSpec = {
    file, version, title: String(info.title ?? ''), apiVersion: String(info.version ?? ''), basePaths, servers, operations,
    definitions: loader.definitions, raw: r, securitySchemes: securitySchemes ?? {}, warnings: loader.warnings,
  };
  validators.set(spec, new SpecValidator(spec, specId, is31));
  return spec;
}

function swaggerParamSchema(p: Json): Json {
  if (p.schema) return p.schema as Json;
  const out: Json = {};
  for (const k of ['type', 'format', 'items', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf', 'default']) {
    if (p[k] !== undefined) out[k] = p[k];
  }
  if (out.type === 'file') return {};
  return out;
}

function media(content: unknown, sch: (s: unknown) => Json | undefined): Record<string, ApiMedia> {
  const out: Record<string, ApiMedia> = {};
  for (const [ct, m] of Object.entries((content ?? {}) as Record<string, Json>)) {
    out[ct.toLowerCase()] = {
      ...(m?.schema ? { schema: sch(m.schema) } : {}),
      ...(m?.example !== undefined ? { example: m.example } : {}),
      ...(m?.examples && typeof m.examples === 'object' ? { examples: Object.fromEntries(Object.entries(m.examples as Json).map(([k, e]) => [k, (e as Json)?.value ?? e])) } : {}),
    };
  }
  return out;
}

function contentSchema(content: unknown, sch: (s: unknown) => Json | undefined): Json | undefined {
  const first = Object.values((content ?? {}) as Record<string, Json>)[0];
  return first?.schema ? sch(first.schema) : undefined;
}

// ------------------------------------------------------------------ matching

/** Strip the scheme/host and a server base path; returns the path to match against operation templates. */
export function requestPath(spec: ApiSpec, url: string): string[] {
  let path: string;
  try {
    path = new URL(url, 'http://placeholder').pathname;
  } catch {
    path = url.split('?')[0];
  }
  path = decodeURI(path).replace(/\/{2,}/g, '/');
  const out = new Set<string>();
  for (const bp of [...spec.basePaths].sort((a, b) => b.length - a.length)) {
    if (bp && (path === bp || path.startsWith(bp + '/'))) out.add(path.slice(bp.length) || '/');
  }
  out.add(path);
  return [...out];
}

/** The operation a request is for (most specific path template wins), with its path parameters. */
export function matchOperation(spec: ApiSpec, method: string, url: string): { operation: ApiOperation; params: Record<string, string> } | undefined {
  const m = method.toUpperCase();
  for (const p of requestPath(spec, url)) {
    const hits = spec.operations
      .filter((o) => o.method === m && o.pathRe.test(p))
      .sort((a, b) => b.specificity - a.specificity);
    if (hits.length) {
      const op = hits[0];
      const mm = op.pathRe.exec(p)!;
      return { operation: op, params: Object.fromEntries(op.pathParams.map((n, i) => [n, decodeURIComponent(mm[i + 1])])) };
    }
  }
  return undefined;
}

/** True when some operation has this path (any method): used to tell 405-style mismatches from unknown paths. */
export function pathKnown(spec: ApiSpec, url: string): boolean {
  return requestPath(spec, url).some((p) => spec.operations.some((o) => o.pathRe.test(p)));
}

export function findOperation(spec: ApiSpec, idOrRequest: string): ApiOperation | undefined {
  const byId = spec.operations.find((o) => o.id === idOrRequest || o.operationId === idOrRequest);
  if (byId) return byId;
  const m = /^([A-Za-z]+)\s+(\S+)$/.exec(idOrRequest.trim());
  if (!m) return undefined;
  return spec.operations.find((o) => o.method === m[1].toUpperCase() && o.path === m[2]) ?? matchOperation(spec, m[1], m[2])?.operation;
}

/** The documented response for a status: exact code, then "2XX", then "default". */
export function responseFor(op: ApiOperation, status: number): { code: string; response: ApiResponseSpec } | undefined {
  const exact = op.responses[String(status)];
  if (exact) return { code: String(status), response: exact };
  const range = op.responses[`${String(status)[0]}XX`];
  if (range) return { code: `${String(status)[0]}XX`, response: range };
  const def = op.responses.default;
  return def ? { code: 'default', response: def } : undefined;
}

// ------------------------------------------------------------------ validation

const validators = new WeakMap<ApiSpec, SpecValidator>();

function mediaFor(content: Record<string, ApiMedia>, contentType: string | undefined): { type: string; media: ApiMedia } | undefined {
  const keys = Object.keys(content);
  if (!keys.length) return undefined;
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const exact = keys.find((k) => k === ct);
  if (exact) return { type: exact, media: content[exact] };
  const suffix = ct.includes('+json') ? keys.find((k) => k === 'application/json') : undefined;
  if (suffix) return { type: suffix, media: content[suffix] };
  const wild = keys.find((k) => k.endsWith('/*') && ct.startsWith(k.slice(0, -1))) ?? keys.find((k) => k === '*/*');
  return wild ? { type: wild, media: content[wild] } : undefined;
}

function isJsonType(ct: string): boolean {
  return /^application\/(?:[\w.+-]+\+)?json\b|\*\/\*/i.test(ct);
}

class SpecValidator {
  private readonly ajv: AjvLike;
  private readonly cache = new WeakMap<object, ValidateFn>();

  constructor(readonly spec: ApiSpec, readonly specId: string, is31: boolean) {
    this.ajv = is31 ? new Ajv2020Ctor({ allErrors: true, strict: false, validateFormats: true }) : new AjvCtor({ allErrors: true, strict: false, validateFormats: true });
    addFormats(this.ajv);
    for (const f of ['int32', 'int64']) this.ajv.addFormat(f, { type: 'number', validate: (n: number) => Number.isInteger(n) });
    for (const f of ['float', 'double', 'binary', 'password', 'decimal']) this.ajv.addFormat(f, { validate: () => true });
    this.ajv.addFormat('byte', /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
    this.ajv.addSchema({ $id: specId, [is31 ? '$defs' : 'definitions']: spec.definitions });
  }

  check(schema: Json, data: unknown): AjvError[] {
    let fn = this.cache.get(schema);
    if (!fn) {
      try {
        fn = this.ajv.compile(schema);
      } catch (e) {
        throw new EzTestError(`API spec ${this.spec.file}: schema does not compile: ${(e as Error).message}`, 'SPEC_SCHEMA');
      }
      this.cache.set(schema, fn);
    }
    return fn(data) ? [] : [...(fn.errors ?? [])];
  }
}

function validatorOf(spec: ApiSpec): SpecValidator {
  const v = validators.get(spec);
  if (!v) throw new EzTestError('API spec was not built by buildSpec/loadApiSpec', 'SPEC_INVALID');
  return v;
}

/** Turn ajv errors into violations with JSON pointers (missing properties point at the property itself). */
function bodyViolations(errors: AjvError[], side: Violation['side'], prefix = ''): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  // anyOf/oneOf produce one error per branch plus a summary; keep the specific ones and drop exact duplicates.
  for (const e of errors) {
    const missing = e.keyword === 'required' && typeof e.params?.missingProperty === 'string' ? `/${String(e.params.missingProperty).replace(/~/g, '~0').replace(/\//g, '~1')}` : '';
    const extra = e.keyword === 'additionalProperties' && typeof e.params?.additionalProperty === 'string' ? `/${String(e.params.additionalProperty)}` : '';
    const pointer = `${prefix}${e.instancePath}${missing}${extra}` || '/';
    let message: string;
    if (missing) message = `required property is missing`;
    else if (extra) message = `property is not allowed by the spec`;
    else if (e.keyword === 'enum') message = `must be one of ${JSON.stringify(e.params?.allowedValues)}`;
    else if (e.keyword === 'type') message = `must be ${String(e.params?.type)}`;
    else message = e.message ?? `fails ${e.keyword}`;
    const key = `${pointer} ${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ side, kind: 'body', pointer, message: `${pointer}: ${message}` });
  }
  return out;
}

function coerce(raw: string, schema: Json | undefined): unknown {
  const t = Array.isArray(schema?.type) ? (schema!.type as string[]).find((x) => x !== 'null') : (schema?.type as string | undefined);
  if (t === 'integer' || t === 'number') return raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (t === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (t === 'array') return raw.split(',');
  return raw;
}

export interface ExchangeInput {
  method: string;
  url: string;
  /** Request headers (names matter; values are validated against header parameter schemas). */
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  requestContentType?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  /** Parsed JSON body, or text. */
  responseBody?: unknown;
}

/** Validate one request/response exchange against the spec. */
export function validateExchange(spec: ApiSpec, x: ExchangeInput, opts: { operation?: string; request?: boolean; response?: boolean } = {}): ValidationResult {
  const v = validatorOf(spec);
  const violations: Violation[] = [];
  const path = (() => {
    try {
      return new URL(x.url, 'http://placeholder').pathname;
    } catch {
      return x.url;
    }
  })();
  const base: Omit<ValidationResult, 'valid' | 'violations'> = { method: x.method.toUpperCase(), path, ...(x.status !== undefined ? { status: x.status } : {}) };
  let op: ApiOperation | undefined;
  let pathParams: Record<string, string> = {};
  if (opts.operation) {
    op = findOperation(spec, opts.operation);
    if (!op) return { ...base, valid: false, violations: [{ side: 'request', kind: 'unknown-operation', message: `the spec has no operation "${opts.operation}"` }] };
    const mm = op.pathRe.exec(requestPath(spec, x.url).find((p) => op!.pathRe.test(p)) ?? '');
    if (mm) pathParams = Object.fromEntries(op.pathParams.map((n, i) => [n, decodeURIComponent(mm[i + 1])]));
  } else {
    const hit = matchOperation(spec, x.method, x.url);
    if (!hit) {
      const why = pathKnown(spec, x.url) ? `method ${x.method.toUpperCase()} is not documented for ${path}` : `no operation in the spec matches ${x.method.toUpperCase()} ${path}`;
      return { ...base, valid: false, violations: [{ side: 'request', kind: 'unknown-operation', message: why }] };
    }
    op = hit.operation;
    pathParams = hit.params;
  }
  base.operation = op.id;

  if (opts.request !== false) {
    const query = (() => {
      try {
        return new URL(x.url, 'http://placeholder').searchParams;
      } catch {
        return new URLSearchParams();
      }
    })();
    const headers = Object.fromEntries(Object.entries(x.requestHeaders ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
    for (const p of op.parameters) {
      let raw: string | undefined;
      if (p.in === 'path') raw = pathParams[p.name];
      else if (p.in === 'query') raw = query.has(p.name) ? query.getAll(p.name).join(',') : undefined;
      else if (p.in === 'header') raw = headers[p.name.toLowerCase()];
      else continue;
      if (raw === undefined) {
        // Headers the runner adds itself (authorization, content-type) are not visible here; only report required query/path params.
        if (p.required && p.in !== 'header') violations.push({ side: 'request', kind: 'parameter', pointer: p.name, message: `required ${p.in} parameter "${p.name}" is missing` });
        continue;
      }
      if (p.schema && Object.keys(p.schema).length) {
        const errs = v.check(p.schema, coerce(raw, p.schema));
        if (errs.length) violations.push({ side: 'request', kind: 'parameter', pointer: p.name, message: `${p.in} parameter "${p.name}" = "${raw}" ${errs[0].message ?? 'is invalid'}` });
      }
    }
    if (op.requestBody) {
      const has = x.requestBody !== undefined && x.requestBody !== '';
      if (!has && op.requestBody.required) violations.push({ side: 'request', kind: 'body', pointer: '/', message: 'the request body is required' });
      if (has) {
        const ct = x.requestContentType ?? (typeof x.requestBody === 'object' ? 'application/json' : 'text/plain');
        const m = mediaFor(op.requestBody.content, ct);
        if (!m) violations.push({ side: 'request', kind: 'content-type', message: `request content type "${ct}" is not one of ${Object.keys(op.requestBody.content).join(', ')}` });
        else if (m.media.schema && isJsonType(m.type)) {
          let body = x.requestBody;
          if (typeof body === 'string') {
            try {
              body = JSON.parse(body);
            } catch {
              /* validated as text */
            }
          }
          violations.push(...bodyViolations(v.check(m.media.schema, body), 'request'));
        }
      }
    }
  }

  if (opts.response !== false && x.status !== undefined) {
    const r = responseFor(op, x.status);
    if (!r) {
      violations.push({ side: 'response', kind: 'status', message: `status ${x.status} is not documented for ${op.id} (documented: ${Object.keys(op.responses).join(', ') || 'none'})` });
    } else {
      const headers = Object.fromEntries(Object.entries(x.responseHeaders ?? {}).map(([k, val]) => [k.toLowerCase(), val]));
      for (const [name, h] of Object.entries(r.response.headers)) {
        const val = headers[name];
        if (val === undefined) {
          if (h.required) violations.push({ side: 'response', kind: 'header', pointer: name, message: `required response header "${name}" is missing` });
          continue;
        }
        if (h.schema && Object.keys(h.schema).length) {
          const errs = v.check(h.schema, coerce(val, h.schema));
          if (errs.length) violations.push({ side: 'response', kind: 'header', pointer: name, message: `response header "${name}" = "${val}" ${errs[0].message ?? 'is invalid'}` });
        }
      }
      const content = r.response.content;
      const body = x.responseBody;
      const hasBody = body !== undefined && body !== null && body !== '';
      if (Object.keys(content).length && hasBody) {
        const ct = headers['content-type'] ?? (typeof body === 'object' ? 'application/json' : 'text/plain');
        const m = mediaFor(content, ct);
        if (!m) violations.push({ side: 'response', kind: 'content-type', message: `response content type "${ct}" is not documented for ${op.id} ${r.code} (documented: ${Object.keys(content).join(', ')})` });
        else if (m.media.schema && isJsonType(m.type)) {
          let data: unknown = body;
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch {
              violations.push({ side: 'response', kind: 'body', pointer: '/', message: '/: the body is not valid JSON' });
              data = undefined;
            }
          }
          if (data !== undefined) violations.push(...bodyViolations(v.check(m.media.schema, data), 'response'));
        }
      } else if (Object.keys(content).length && !hasBody && x.status !== 204 && x.status !== 304 && x.method.toUpperCase() !== 'HEAD') {
        const anySchema = Object.values(content).some((m) => m.schema && Object.keys(m.schema).length);
        if (anySchema) violations.push({ side: 'response', kind: 'body', pointer: '/', message: `/: the response has no body, but ${op.id} ${r.code} documents one` });
      }
    }
  }
  return { ...base, valid: violations.length === 0, violations };
}

/** Validate a value against one of the spec's named schemas (e.g. a message payload against #/components/schemas/Order). */
export function validateAgainstDefinition(spec: ApiSpec, name: string, data: unknown): Violation[] {
  const v = validatorOf(spec);
  const def = spec.definitions[name];
  if (!def) throw new EzTestError(`The spec has no schema "${name}" (known: ${Object.keys(spec.definitions).slice(0, 20).join(', ')})`, 'SPEC_SCHEMA');
  return bodyViolations(v.check({ $ref: `${v.specId}#/${spec.version.startsWith('3.1') ? '$defs' : 'definitions'}/${name}` }, data), 'response');
}

/** Validate a value against one of the spec's schemas that an operation response uses (for imports and mocks). */
export function validateSchemaIn(spec: ApiSpec, schema: Json, data: unknown): Violation[] {
  return bodyViolations(validatorOf(spec).check(schema, data), 'response');
}

/** The schema a $ref inside the bundle points to (for generators). */
export function resolveSchemaRef(spec: ApiSpec, schema: Json | undefined): Json | undefined {
  let s = schema;
  for (let i = 0; i < 50 && s && typeof s.$ref === 'string'; i++) {
    const name = /#\/(?:definitions|\$defs)\/(.+)$/.exec(s.$ref as string)?.[1];
    s = name ? spec.definitions[name] : undefined;
  }
  return s;
}

// ------------------------------------------------------------------ cache

const fileCache = new Map<string, { mtimeMs: number; spec: ApiSpec }>();

/** Load a spec once per file (reloaded when the file changes). */
export function cachedSpec(file: string): ApiSpec {
  const abs = resolve(file);
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(abs).mtimeMs;
  } catch {
    // loadApiSpec reports the missing file
  }
  const hit = fileCache.get(abs);
  if (hit && hit.mtimeMs === mtimeMs) return hit.spec;
  const spec = loadApiSpec(abs);
  fileCache.set(abs, { mtimeMs, spec });
  return spec;
}

/** One-line summary of a validation result. */
export function describeViolations(r: ValidationResult, max = 5): string {
  if (r.valid) return `${r.method} ${r.path} conforms to ${r.operation ?? 'the spec'}`;
  const list = r.violations.slice(0, max).map((v) => `${v.side} ${v.message}`);
  const more = r.violations.length > max ? ` (+${r.violations.length - max} more)` : '';
  return `${r.method} ${r.path}${r.status !== undefined ? ` -> ${r.status}` : ''} breaks the API contract${r.operation ? ` (${r.operation})` : ''}: ${list.join('; ')}${more}`;
}
