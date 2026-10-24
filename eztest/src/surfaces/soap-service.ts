/**
 * SOAP services from a WSDL: request building (skeleton + named values or a
 * raw body), XSD validation of requests and responses, WS-Security, MTOM,
 * the HTTP exchange and response checks. Backs the step
 *   Call SOAP operation "GetPolicy" on "policy" with PolicyId = "P-100" and store as policy
 * with services configured under `soap.services` (docs/soap.md).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { EzTestError } from '../core/index.js';
import { envProxyFetch } from './proxy.js';
import { parseSoapResponse, SOAP_NS, type SoapFault } from './soap.js';
import { buildMtom, isMultipartRelated, parseMtom } from './mtom.js';
import { applyWsSecurity, verifyWsSecurity, type WsSecurityOptions, type WsVerifyResult } from './wssecurity.js';
import { bodySkeleton, findOperation, loadWsdl, type WsdlModel, type WsdlOperation } from './wsdl.js';
import { childElements, firstChild, parseXml, removeNode, serializeXml, textContent, type XElement, type XNode } from './xml-dom.js';
import { fileSchemaLoader, type XsdIssue, type XsdResult } from './xsd.js';

export interface SoapServiceConfig {
  /** WSDL file (relative to the project) or URL. */
  wsdl: string;
  /** Endpoint URL; default: the address in the WSDL. */
  endpoint?: string;
  service?: string;
  port?: string;
  /** Prefer the SOAP 1.1 or 1.2 binding when the WSDL has both. */
  soapVersion?: '1.1' | '1.2';
  /** Extra HTTP headers (values may be secret references). */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** XSD validation of requests and responses. Default "both". */
  validate?: 'both' | 'request' | 'response' | 'off';
  security?: {
    username?: string;
    password?: string;
    passwordType?: 'text' | 'digest';
    /** Add a Timestamp (a number: lifetime in seconds). */
    timestamp?: boolean | number;
    sign?: { key: string; certificate: string; parts?: Array<'Body' | 'Timestamp' | 'UsernameToken'> };
    /** Check signed responses: trusted signer certificates (PEM files) and whether a signature is required. */
    verify?: { certificates?: string[]; require?: boolean };
  };
  /** Send base64 content of these elements as MTOM/XOP attachments. */
  mtom?: { elements: string[] };
}

export interface SoapCallInput {
  /** Values for the request skeleton: element local name or dotted path ("Holder.Name") -> value. */
  params?: Record<string, string>;
  /** Body content XML (inside soap:Body), used as given. */
  body?: string;
  /** A file with the body content, or a whole envelope. */
  file?: string;
  /** Do not fail on a SOAP fault. */
  allowFault?: boolean;
}

export interface SoapCallResult {
  operation: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  /** Response Body content with namespace prefixes removed (fast-xml-parser shape). */
  body: Record<string, unknown>;
  fault?: SoapFault;
  /** Raw response envelope (MTOM: reassembled). */
  xml: string;
  requestXml: string;
  validation: { request?: XsdResult; response?: XsdResult };
  security?: WsVerifyResult;
  attachments?: Array<{ id: string; contentType: string; size: number }>;
  durationMs: number;
}

export interface SoapServiceOptions {
  baseDir: string;
  fetch?: typeof fetch;
  /** Resolve secret references (secret://..., ENC(...)) in passwords and headers. */
  resolveSecret?: (ref: string) => Promise<string>;
  /** Called with every secret value so evidence masks it. */
  addSecret?: (value: string) => void;
}

const isSecretRef = (v: string) => /^secret:\/\/|^ENC\(/.test(v);

/** Validate the Body of an envelope against the operation's message parts. */
export function validateEnvelope(model: WsdlModel, op: WsdlOperation, xml: string, direction: 'input' | 'output'): XsdResult {
  const doc = parseXml(xml);
  const env = doc.root;
  const body = firstChild(env, 'Body', env.ns);
  const errors: XsdIssue[] = [];
  if (!body) return { valid: false, errors: [{ path: '/Envelope', message: 'No soap:Body' }] };
  const kids = childElements(body);
  if (kids.some((k) => k.local === 'Fault')) return { valid: true, errors: [] };
  const parts = direction === 'input' ? op.input : op.output;
  if (op.style === 'rpc') {
    const wrapper = kids[0];
    const want = direction === 'input' ? op.name : `${op.name}Response`;
    if (!wrapper || wrapper.local !== want) return { valid: false, errors: [{ path: '/Envelope/Body', message: `Expected the rpc wrapper <${want}>, found ${wrapper ? `<${wrapper.local}>` : 'nothing'}` }] };
    for (const p of parts) {
      const el = childElements(wrapper).find((c) => c.local === (p.element?.local ?? p.name));
      const path = `/Envelope/Body/${want}/${p.name}`;
      if (!el) {
        errors.push({ path, message: `Missing part ${p.name}` });
        continue;
      }
      const r = p.element ? model.schemas.validate(el, path) : p.type ? model.schemas.validateAgainstType(el, `{${p.type.ns}}${p.type.local}`, path) : { valid: true, errors: [] };
      errors.push(...r.errors);
    }
    return { valid: errors.length === 0, errors };
  }
  const elementParts = parts.filter((p) => p.element);
  for (const [i, p] of elementParts.entries()) {
    const el = kids[i];
    const path = `/Envelope/Body/${p.element!.local}`;
    if (!el) {
      errors.push({ path, message: `Missing body element <${p.element!.local}>` });
      continue;
    }
    if (el.local !== p.element!.local || el.ns !== p.element!.ns) {
      errors.push({ path: `/Envelope/Body/${el.local}`, message: `Expected <${p.element!.local}> in ${p.element!.ns || 'no namespace'}, found <${el.local}> in ${el.ns || 'no namespace'}` });
      continue;
    }
    errors.push(...model.schemas.validate(el, path).errors);
  }
  if (kids.length > elementParts.length) errors.push({ path: `/Envelope/Body/${kids[elementParts.length].local}`, message: `Unexpected body element <${kids[elementParts.length].local}>` });
  return { valid: errors.length === 0, errors };
}

/** Flatten a nested object of values into dotted paths ({ Holder: { Name: "x" } } -> { "Holder.Name": "x" }). */
export function flattenParams(v: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) flattenParams(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = v === null || v === undefined ? '' : String(v);
  return out;
}

const OPTIONAL = 'optional';

/**
 * Fill a body skeleton (from bodySkeleton) with values: each key is an element's local name or a
 * dotted path ending in it. Optional elements nobody filled are removed; required leaves nobody
 * filled are an error naming them.
 */
export function fillSkeleton(skeletonXml: string, params: Record<string, string>, o: { requireAll?: boolean } = {}): string {
  const doc = parseXml(`<ezroot>${skeletonXml}</ezroot>`);
  const filled = new Set<XElement>();
  const all: XElement[] = [];
  const walk = (e: XElement) => {
    for (const c of childElements(e)) {
      all.push(c);
      walk(c);
    }
  };
  walk(doc.root);
  const pathOf = (e: XElement) => {
    const parts: string[] = [];
    for (let x: XElement | undefined = e; x && x !== doc.root; x = x.parent) parts.unshift(x.local);
    return parts;
  };
  for (const [k, v] of Object.entries(params)) {
    const want = k.split('.').filter(Boolean);
    const hits = all.filter((e) => {
      const p = pathOf(e);
      return p.length >= want.length && want.every((w, i) => p[p.length - want.length + i] === w);
    });
    if (!hits.length) throw new EzTestError(`The request has no element "${k}" (elements: ${[...new Set(all.map((e) => e.local))].join(', ')})`, 'SOAP_PARAM');
    const leaves = hits.filter((h) => !childElements(h).length);
    if (leaves.length > 1) throw new EzTestError(`"${k}" matches ${leaves.length} elements (${leaves.map((h) => pathOf(h).join('.')).join(', ')}); use a longer path`, 'SOAP_PARAM');
    const el = leaves[0] ?? hits[0];
    if (childElements(el).length) throw new EzTestError(`"${k}" is a structure, not a value: set its fields (${childElements(el).map((c) => `${k}.${c.local}`).join(', ')})`, 'SOAP_PARAM');
    el.children = [{ type: 'text', value: v, parent: el }];
    filled.add(el);
  }
  const hasFilled = (e: XElement): boolean => filled.has(e) || childElements(e).some(hasFilled);
  const prevComment = (e: XElement): string | undefined => {
    const sib = e.parent!.children;
    for (let i = sib.indexOf(e) - 1; i >= 0; i--) {
      const s = sib[i];
      if (s.type === 'text' && !s.value.trim()) continue;
      return s.type === 'comment' ? s.value.trim() : undefined;
    }
    return undefined;
  };
  const missing: string[] = [];
  const prune = (e: XElement, optionalAncestor: boolean) => {
    for (const c of childElements(e)) {
      const optional = prevComment(c) === OPTIONAL;
      if (optional && !hasFilled(c)) {
        removeNode(c);
        continue;
      }
      if (!childElements(c).length && !filled.has(c) && !optionalAncestor) missing.push(pathOf(c).join('.'));
      prune(c, optionalAncestor && !hasFilled(c));
    }
  };
  prune(doc.root, false);
  if (missing.length && o.requireAll !== false) {
    throw new EzTestError(`The request needs values for: ${missing.join(', ')} (e.g. with ${missing.slice(0, 2).map((m) => `${m.split('.').pop()} = "..."`).join(', ')})`, 'SOAP_PARAM_MISSING', { missing });
  }
  // Drop the skeleton's comments and indentation.
  const clean = (e: XElement) => {
    e.children = e.children.filter((c: XNode) => c.type !== 'comment' && !(c.type === 'text' && !c.value.trim() && childElements(e).length));
    for (const c of childElements(e)) clean(c);
  };
  clean(doc.root);
  return doc.root.children.map((c) => serializeXml(c)).join('');
}

export class SoapServiceClient {
  private modelP?: Promise<WsdlModel>;

  constructor(readonly name: string, readonly cfg: SoapServiceConfig, readonly opts: SoapServiceOptions) {
    if (!cfg?.wsdl) throw new EzTestError(`soap.services.${name}: "wsdl" is required`, 'CONFIG');
  }

  private path(p: string): string {
    return /^https?:\/\//i.test(p) || isAbsolute(p) ? p : resolve(this.opts.baseDir, p);
  }

  model(): Promise<WsdlModel> {
    this.modelP ??= loadWsdl(this.path(this.cfg.wsdl), fileSchemaLoader).catch((e) => {
      this.modelP = undefined;
      throw e;
    });
    return this.modelP;
  }

  async operation(name: string): Promise<WsdlOperation> {
    return findOperation(await this.model(), name, { service: this.cfg.service, port: this.cfg.port, soapVersion: this.cfg.soapVersion });
  }

  private async secret(v: string | undefined): Promise<string | undefined> {
    if (v === undefined) return undefined;
    if (!isSecretRef(v)) return v;
    if (!this.opts.resolveSecret) throw new EzTestError(`soap.services.${this.name}: "${v}" is a secret reference but no secret store is available`, 'CONFIG');
    const r = await this.opts.resolveSecret(v);
    this.opts.addSecret?.(r);
    return r;
  }

  /** The request envelope for an operation (before WS-Security). */
  async buildEnvelope(operation: string, input: SoapCallInput): Promise<{ op: WsdlOperation; xml: string }> {
    const model = await this.model();
    const op = await this.operation(operation);
    let body: string;
    if (input.file !== undefined) {
      const text = await readFile(this.path(input.file), 'utf8');
      if (/<(?:[\w.-]+:)?Envelope\b/.test(text)) return { op, xml: text };
      body = text;
    } else if (input.body !== undefined) body = input.body;
    else body = fillSkeleton(bodySkeletonForFill(model, op), input.params ?? {});
    const ns = SOAP_NS[op.soapVersion];
    return { op, xml: `<soapenv:Envelope xmlns:soapenv="${ns}"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>` };
  }

  private async wsSecurity(): Promise<WsSecurityOptions | undefined> {
    const s = this.cfg.security;
    if (!s || (!s.username && !s.timestamp && !s.sign)) return undefined;
    const o: WsSecurityOptions = {};
    if (s.username) o.username = { username: s.username, password: (await this.secret(s.password)) ?? '', passwordType: s.passwordType ?? 'text' };
    if (s.timestamp || s.sign) o.timestamp = s.timestamp === undefined ? true : s.timestamp;
    if (s.sign) {
      const privateKey = await this.secretOrFile(s.sign.key);
      const certificate = await readFile(this.path(s.sign.certificate), 'utf8');
      o.signature = { privateKey, certificate, ...(s.sign.parts ? { parts: s.sign.parts } : {}) };
    }
    return o;
  }

  private async secretOrFile(v: string): Promise<string> {
    if (isSecretRef(v)) return (await this.secret(v))!;
    return readFile(this.path(v), 'utf8');
  }

  /** Call an operation: build, validate, secure, send, verify, validate the response. */
  async call(operation: string, input: SoapCallInput = {}): Promise<SoapCallResult> {
    const model = await this.model();
    const built = await this.buildEnvelope(operation, input);
    const { op } = built;
    const validate = this.cfg.validate ?? 'both';
    const validation: SoapCallResult['validation'] = {};
    if (validate === 'both' || validate === 'request') {
      validation.request = validateEnvelope(model, op, built.xml, 'input');
      if (!validation.request.valid) {
        throw new EzTestError(`The ${operation} request does not match the schema: ${validation.request.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join('; ')}`, 'SOAP_REQUEST_INVALID', { errors: validation.request.errors });
      }
    }
    const sec = await this.wsSecurity();
    const requestXml = sec ? applyWsSecurity(built.xml, sec) : built.xml;
    const url = this.cfg.endpoint ?? op.endpoint;
    if (!url) throw new EzTestError(`soap.services.${this.name}: the WSDL has no address for ${op.port}; set "endpoint"`, 'CONFIG');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) headers[k] = (await this.secret(v)) ?? '';
    const action = op.soapAction ?? '';
    let payload: string | Uint8Array = requestXml;
    if (this.cfg.mtom?.elements.length) {
      const m = buildMtom(requestXml, { soapVersion: op.soapVersion, binaryElements: this.cfg.mtom.elements, action });
      payload = m.body;
      headers['content-type'] = m.contentType;
    } else headers['content-type'] = op.soapVersion === '1.1' ? 'text/xml; charset=utf-8' : `application/soap+xml; charset=utf-8${action ? `; action="${action.replace(/"/g, '')}"` : ''}`;
    if (op.soapVersion === '1.1') headers.soapaction = `"${action.replace(/"/g, '')}"`;
    headers.accept = 'text/xml, application/soap+xml, multipart/related';
    const f = this.opts.fetch ?? envProxyFetch;
    const started = Date.now();
    let res: Response;
    try {
      res = await f(url, { method: 'POST', headers, body: payload as BodyInit, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new EzTestError(`SOAP call ${operation} to ${url} failed: ${(e as Error).message}`, 'SOAP_HTTP');
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const durationMs = Date.now() - started;
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (resHeaders[k] = v));
    const ct = resHeaders['content-type'] ?? '';
    let xml: string;
    let attachments: SoapCallResult['attachments'];
    if (isMultipartRelated(ct)) {
      const m = parseMtom(bytes, ct);
      xml = m.envelopeXml;
      attachments = m.attachments.map((a) => ({ id: a.id, contentType: a.contentType, size: a.data.length }));
    } else xml = Buffer.from(bytes).toString('utf8');
    if (!xml.trim()) throw new EzTestError(`SOAP call ${operation} returned HTTP ${res.status} with an empty body`, 'SOAP_EMPTY');
    const parsed = parseSoapResponse(xml);
    const out: SoapCallResult = {
      operation, url, status: res.status, headers: resHeaders, body: parsed.body, ...(parsed.fault ? { fault: parsed.fault } : {}), xml, requestXml, validation, durationMs,
      ...(attachments ? { attachments } : {}),
    };
    const verify = this.cfg.security?.verify;
    if (verify) {
      const trusted = await Promise.all((verify.certificates ?? []).map((c) => readFile(this.path(c), 'utf8')));
      out.security = verifyWsSecurity(xml, { trustedCertificates: trusted, requireSignature: verify.require ?? true });
      // An unsigned fault is reported as the fault (services often cannot sign their errors); anything else must verify.
      if (!out.security.ok && !(parsed.fault && !out.security.signed)) throw new EzTestError(`The ${operation} response failed WS-Security checks: ${out.security.errors.join('; ')}`, 'SOAP_SECURITY', { security: out.security });
    }
    if (parsed.fault) {
      if (!input.allowFault) throw new EzTestError(`SOAP fault from ${operation}: ${parsed.fault.code}: ${parsed.fault.reason}`, 'SOAP_FAULT', { fault: parsed.fault });
      return out;
    }
    if (!res.ok) throw new EzTestError(`SOAP call ${operation} returned HTTP ${res.status} without a fault`, 'SOAP_HTTP');
    if (validate === 'both' || validate === 'response') {
      validation.response = validateEnvelope(model, op, xml, 'output');
      if (!validation.response.valid) {
        throw new EzTestError(`The ${operation} response does not match the schema: ${validation.response.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join('; ')}`, 'SOAP_RESPONSE_INVALID', { errors: validation.response.errors });
      }
    }
    return out;
  }
}

/** Skeleton for filling: like bodySkeleton, but every choice option is present (the filled one is kept). */
function bodySkeletonForFill(model: WsdlModel, op: WsdlOperation): string {
  return bodySkeleton(model, op, { allChoices: true });
}

/** The text of the first element with this local name in a response (helper for tests and steps). */
export function responseValue(xml: string, local: string): string | undefined {
  const find = (e: XElement): XElement | undefined => (e.local === local ? e : childElements(e).map(find).find(Boolean));
  const el = find(parseXml(xml).root);
  return el ? textContent(el) : undefined;
}
