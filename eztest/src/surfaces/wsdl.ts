/**
 * WSDL 1.1 and WSDL 2.0 import, written from the W3C notes and
 * recommendation. fast-xml-parser reads the documents; namespaces are
 * resolved by EZTest (QName references in attributes included). The result
 * is a flat list of SOAP operations per endpoint (SOAP 1.1 or 1.2 binding,
 * soapAction, style, body element), the schemas of the types section (for
 * XSD validation, src/surfaces/xsd.ts) and request skeletons.
 *
 * Supported: wsdl:import, inline xs:schema with xs:import/xs:include,
 * document/literal (wrapped and bare), rpc/literal; SOAP 1.1 and 1.2 bindings
 * (WSDL 1.1 soap: / soap12: extensions, WSDL 2.0 wsoap:). Not supported:
 * encoded use (SOAP-encoding), HTTP and MIME bindings other than MTOM.
 */
import { XMLParser } from 'fast-xml-parser';
import { EzTestError } from '../core/index.js';
import { childElements, parseXml, type XElement } from './xml-dom.js';
import { fileSchemaLoader, XS_NS, XsdSchemaSet, type SchemaLoader } from './xsd.js';

export const WSDL11_NS = 'http://schemas.xmlsoap.org/wsdl/';
export const WSDL20_NS = 'http://www.w3.org/ns/wsdl';
const SOAP11_BIND = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12_BIND = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const WSOAP = 'http://www.w3.org/ns/wsdl/soap';
const SOAP_ENV: Record<'1.1' | '1.2', string> = { '1.1': 'http://schemas.xmlsoap.org/soap/envelope/', '1.2': 'http://www.w3.org/2003/05/soap-envelope' };

export interface QName {
  ns: string;
  local: string;
}

export interface WsdlMessagePart {
  name: string;
  element?: QName;
  type?: QName;
}

export interface WsdlOperation {
  name: string;
  service: string;
  port: string;
  binding: string;
  /** Endpoint address from the WSDL (may be overridden by configuration). */
  endpoint?: string;
  soapVersion: '1.1' | '1.2';
  soapAction?: string;
  style: 'document' | 'rpc';
  /** rpc style: namespace of the operation wrapper element. */
  rpcNamespace?: string;
  input: WsdlMessagePart[];
  output: WsdlMessagePart[];
  faults: Array<{ name: string; parts: WsdlMessagePart[] }>;
  documentation?: string;
}

export interface WsdlModel {
  version: '1.1' | '2.0';
  targetNamespace: string;
  name?: string;
  location?: string;
  operations: WsdlOperation[];
  services: Array<{ name: string; ports: Array<{ name: string; binding: string; address?: string; soapVersion: '1.1' | '1.2' }> }>;
  schemas: XsdSchemaSet;
  /** Constructs found that EZTest does not handle (e.g. encoded use, HTTP bindings). */
  warnings: string[];
}

type Node = Record<string, unknown>;
type Scope = Map<string, string>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Every element is a list (attributes never), so repeated and single children read the same way.
  isArray: (_name, jpath, _leaf, isAttribute) => !isAttribute && String(jpath).includes('.'),
});

function scopeOf(node: Node, parent: Scope): Scope {
  let s = parent;
  for (const [k, v] of Object.entries(node)) {
    if (k === '@_xmlns' || k.startsWith('@_xmlns:')) {
      if (s === parent) s = new Map(parent);
      s.set(k === '@_xmlns' ? '' : k.slice(8), String(v));
    }
  }
  return s;
}

function splitQ(name: string): { prefix: string; local: string } {
  const i = name.indexOf(':');
  return i < 0 ? { prefix: '', local: name } : { prefix: name.slice(0, i), local: name.slice(i + 1) };
}

/** Child elements of a node with namespace `ns` and local name `local`, each with its scope. */
function kids(node: Node, scope: Scope, ns: string, local: string): Array<{ n: Node; s: Scope }> {
  const out: Array<{ n: Node; s: Scope }> = [];
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_') || k.startsWith('#')) continue;
    const q = splitQ(k);
    if (q.local !== local) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      const n = (typeof item === 'object' && item !== null ? item : { '#text': item }) as Node;
      const s = scopeOf(n, scope);
      if ((s.get(q.prefix) ?? (q.prefix === '' ? '' : undefined)) === ns) out.push({ n, s });
    }
  }
  return out;
}

function attr(n: Node, name: string): string | undefined {
  const v = n[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

/** An attribute with any prefix bound to `ns` (e.g. wsoap:version). */
function nsAttr(n: Node, s: Scope, ns: string, local: string): string | undefined {
  for (const [k, v] of Object.entries(n)) {
    if (!k.startsWith('@_')) continue;
    const q = splitQ(k.slice(2));
    if (q.local === local && q.prefix && s.get(q.prefix) === ns) return String(v);
  }
  return undefined;
}

function resolveQ(value: string | undefined, s: Scope): QName | undefined {
  if (!value) return undefined;
  const q = splitQ(value.trim());
  const ns = s.get(q.prefix) ?? (q.prefix === '' ? '' : undefined);
  if (ns === undefined) throw new EzTestError(`WSDL: undeclared prefix "${q.prefix}" in "${value}"`, 'WSDL_PARSE');
  return { ns, local: q.local };
}

const key = (q: QName) => `{${q.ns}}${q.local}`;

function docText(n: Node, s: Scope, wsdlNs: string): string | undefined {
  const d = kids(n, s, wsdlNs, 'documentation')[0];
  if (!d) return undefined;
  const t = typeof d.n['#text'] === 'string' ? (d.n['#text'] as string) : undefined;
  return t?.trim() || undefined;
}

interface LoadedDoc {
  root: Node;
  scope: Scope;
  ns: string;
  tns: string;
  location?: string;
  dom: XElement;
}

/** Load and parse a WSDL (file path, URL or text) with its imports and schemas. */
export async function loadWsdl(source: string | { text: string; location?: string }, loader: SchemaLoader = fileSchemaLoader): Promise<WsdlModel> {
  const docs: LoadedDoc[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  const schemas = new XsdSchemaSet(loader);

  const add = async (text: string, location?: string) => {
    if (location) {
      if (seen.has(location)) return;
      seen.add(location);
    }
    let parsed: Node;
    try {
      parsed = parser.parse(text) as Node;
    } catch (e) {
      throw new EzTestError(`WSDL ${location ?? ''} is not well-formed XML: ${(e as Error).message}`, 'WSDL_PARSE');
    }
    const rootKey = Object.keys(parsed).find((k) => !k.startsWith('?'));
    if (!rootKey) throw new EzTestError('WSDL document is empty', 'WSDL_PARSE');
    const rawRoot = parsed[rootKey];
    const root = (Array.isArray(rawRoot) ? rawRoot[0] : rawRoot) as Node;
    const scope = scopeOf(root, new Map([['xml', 'http://www.w3.org/XML/1998/namespace']]));
    const q = splitQ(rootKey);
    const ns = scope.get(q.prefix) ?? '';
    if (!((ns === WSDL11_NS && q.local === 'definitions') || (ns === WSDL20_NS && q.local === 'description'))) {
      throw new EzTestError(`Not a WSDL document (root <${rootKey}> in ${ns || 'no namespace'})`, 'WSDL_PARSE');
    }
    const dom = parseXml(text).root;
    docs.push({ root, scope, ns, tns: attr(root, 'targetNamespace') ?? '', location, dom });
    // Schemas of the types section (read through the namespace-aware DOM, which keeps every declaration).
    for (const types of childElements(dom, 'types', ns)) {
      for (const sch of childElements(types, 'schema', XS_NS)) await schemas.addSchema(sch, location);
    }
    for (const imp of [...kids(root, scope, ns, 'import'), ...kids(root, scope, ns, 'include')]) {
      const loc = attr(imp.n, 'location');
      if (!loc) continue;
      const r = await loader(loc, location);
      await add(r.text, r.location);
    }
  };

  if (typeof source === 'string' && !/^\s*</.test(source)) {
    const r = await loader(source);
    await add(r.text, r.location);
  } else {
    const s = typeof source === 'string' ? { text: source } : source;
    await add(s.text, s.location);
  }
  const main = docs[0];
  const version: '1.1' | '2.0' = main.ns === WSDL20_NS ? '2.0' : '1.1';
  const model: WsdlModel = { version, targetNamespace: main.tns, name: attr(main.root, 'name'), location: main.location, operations: [], services: [], schemas, warnings };
  if (schemas.unsupported.length) warnings.push(`schema features not enforced by the validator: ${schemas.unsupported.join(', ')}`);
  if (version === '1.1') readWsdl11(docs, model);
  else readWsdl20(docs, model);
  return model;
}

// ------------------------------------------------------------------ WSDL 1.1

function readWsdl11(docs: LoadedDoc[], model: WsdlModel): void {
  const W = WSDL11_NS;
  const messages = new Map<string, WsdlMessagePart[]>();
  const portTypes = new Map<string, { n: Node; s: Scope }>();
  const bindings = new Map<string, { n: Node; s: Scope }>();
  for (const d of docs) {
    for (const m of kids(d.root, d.scope, W, 'message')) {
      messages.set(key({ ns: d.tns, local: attr(m.n, 'name') ?? '' }), kids(m.n, m.s, W, 'part').map((p) => ({
        name: attr(p.n, 'name') ?? '',
        ...(attr(p.n, 'element') ? { element: resolveQ(attr(p.n, 'element'), p.s) } : {}),
        ...(attr(p.n, 'type') ? { type: resolveQ(attr(p.n, 'type'), p.s) } : {}),
      })));
    }
    for (const pt of kids(d.root, d.scope, W, 'portType')) portTypes.set(key({ ns: d.tns, local: attr(pt.n, 'name') ?? '' }), pt);
    for (const b of kids(d.root, d.scope, W, 'binding')) bindings.set(key({ ns: d.tns, local: attr(b.n, 'name') ?? '' }), b);
  }
  const msgParts = (ref: string | undefined, s: Scope, partsFilter?: string): WsdlMessagePart[] => {
    const q = resolveQ(ref, s);
    if (!q) return [];
    const parts = messages.get(key(q));
    if (!parts) throw new EzTestError(`WSDL: message ${key(q)} is not defined`, 'WSDL_PARSE');
    if (!partsFilter) return parts;
    const want = new Set(partsFilter.trim().split(/\s+/));
    return parts.filter((p) => want.has(p.name));
  };
  for (const d of docs) {
    for (const svc of kids(d.root, d.scope, W, 'service')) {
      const service = { name: attr(svc.n, 'name') ?? '', ports: [] as WsdlModel['services'][number]['ports'] };
      for (const port of kids(svc.n, svc.s, W, 'port')) {
        const a11 = kids(port.n, port.s, SOAP11_BIND, 'address')[0];
        const a12 = kids(port.n, port.s, SOAP12_BIND, 'address')[0];
        if (!a11 && !a12) {
          model.warnings.push(`port ${attr(port.n, 'name')}: not a SOAP port (HTTP/other bindings are not supported); skipped`);
          continue;
        }
        const soapVersion: '1.1' | '1.2' = a12 ? '1.2' : '1.1';
        const address = attr((a12 ?? a11)!.n, 'location');
        const bq = resolveQ(attr(port.n, 'binding'), port.s)!;
        const b = bindings.get(key(bq));
        if (!b) throw new EzTestError(`WSDL: binding ${key(bq)} is not defined`, 'WSDL_PARSE');
        const bindNs = soapVersion === '1.2' ? SOAP12_BIND : SOAP11_BIND;
        const sb = kids(b.n, b.s, bindNs, 'binding')[0];
        const defaultStyle = (sb && attr(sb.n, 'style')) === 'rpc' ? 'rpc' : 'document';
        const ptq = resolveQ(attr(b.n, 'type'), b.s)!;
        const pt = portTypes.get(key(ptq));
        if (!pt) throw new EzTestError(`WSDL: portType ${key(ptq)} is not defined`, 'WSDL_PARSE');
        service.ports.push({ name: attr(port.n, 'name') ?? '', binding: bq.local, ...(address ? { address } : {}), soapVersion });
        for (const bop of kids(b.n, b.s, W, 'operation')) {
          const name = attr(bop.n, 'name') ?? '';
          const pop = kids(pt.n, pt.s, W, 'operation').find((o) => attr(o.n, 'name') === name);
          if (!pop) throw new EzTestError(`WSDL: operation ${name} of binding ${bq.local} is not in portType ${ptq.local}`, 'WSDL_PARSE');
          const so = kids(bop.n, bop.s, bindNs, 'operation')[0];
          const style = ((so && attr(so.n, 'style')) ?? defaultStyle) === 'rpc' ? 'rpc' : 'document';
          const bin = kids(bop.n, bop.s, W, 'input')[0];
          const bout = kids(bop.n, bop.s, W, 'output')[0];
          const bodyOf = (x?: { n: Node; s: Scope }) => (x ? kids(x.n, x.s, bindNs, 'body')[0] : undefined);
          const inBody = bodyOf(bin);
          const outBody = bodyOf(bout);
          if ([inBody, outBody].some((bb) => bb && attr(bb.n, 'use') === 'encoded')) model.warnings.push(`operation ${name}: use="encoded" (SOAP encoding) is not supported; requests are built as literal`);
          const pin = kids(pop.n, pop.s, W, 'input')[0];
          const pout = kids(pop.n, pop.s, W, 'output')[0];
          model.operations.push({
            name, service: service.name, port: attr(port.n, 'name') ?? '', binding: bq.local, ...(address ? { endpoint: address } : {}), soapVersion,
            ...(so && attr(so.n, 'soapAction') !== undefined ? { soapAction: attr(so.n, 'soapAction') } : {}),
            style, ...(style === 'rpc' ? { rpcNamespace: (inBody && attr(inBody.n, 'namespace')) ?? d.tns } : {}),
            input: pin ? msgParts(attr(pin.n, 'message'), pin.s, inBody ? attr(inBody.n, 'parts') : undefined) : [],
            output: pout ? msgParts(attr(pout.n, 'message'), pout.s, outBody ? attr(outBody.n, 'parts') : undefined) : [],
            faults: kids(pop.n, pop.s, W, 'fault').map((f) => ({ name: attr(f.n, 'name') ?? '', parts: msgParts(attr(f.n, 'message'), f.s) })),
            ...(docText(pop.n, pop.s, W) ? { documentation: docText(pop.n, pop.s, W) } : {}),
          });
        }
      }
      model.services.push(service);
    }
  }
}

// ------------------------------------------------------------------ WSDL 2.0

function readWsdl20(docs: LoadedDoc[], model: WsdlModel): void {
  const W = WSDL20_NS;
  const interfaces = new Map<string, { n: Node; s: Scope }>();
  const bindings = new Map<string, { n: Node; s: Scope }>();
  for (const d of docs) {
    for (const i of kids(d.root, d.scope, W, 'interface')) interfaces.set(key({ ns: d.tns, local: attr(i.n, 'name') ?? '' }), i);
    for (const b of kids(d.root, d.scope, W, 'binding')) bindings.set(key({ ns: d.tns, local: attr(b.n, 'name') ?? '' }), b);
  }
  const ifaceOps = (q: QName, depth = 0): Array<{ n: Node; s: Scope }> => {
    const i = interfaces.get(key(q));
    if (!i || depth > 10) return [];
    const ext = (attr(i.n, 'extends') ?? '').trim().split(/\s+/).filter(Boolean).map((e) => resolveQ(e, i.s)!);
    return [...kids(i.n, i.s, W, 'operation'), ...ext.flatMap((e) => ifaceOps(e, depth + 1))];
  };
  const part = (x: { n: Node; s: Scope } | undefined): WsdlMessagePart[] => {
    if (!x) return [];
    const el = attr(x.n, 'element');
    if (!el || el === '#any' || el === '#none' || el === '#other') return [];
    return [{ name: 'body', element: resolveQ(el, x.s) }];
  };
  for (const d of docs) {
    for (const svc of kids(d.root, d.scope, W, 'service')) {
      const service = { name: attr(svc.n, 'name') ?? '', ports: [] as WsdlModel['services'][number]['ports'] };
      for (const ep of kids(svc.n, svc.s, W, 'endpoint')) {
        const bq = resolveQ(attr(ep.n, 'binding'), ep.s)!;
        const b = bindings.get(key(bq));
        if (!b) throw new EzTestError(`WSDL: binding ${key(bq)} is not defined`, 'WSDL_PARSE');
        if (attr(b.n, 'type') !== WSOAP) {
          model.warnings.push(`endpoint ${attr(ep.n, 'name')}: binding type ${attr(b.n, 'type')} is not SOAP; skipped`);
          continue;
        }
        const soapVersion: '1.1' | '1.2' = nsAttr(b.n, b.s, WSOAP, 'version') === '1.1' ? '1.1' : '1.2';
        const address = attr(ep.n, 'address');
        service.ports.push({ name: attr(ep.n, 'name') ?? '', binding: bq.local, ...(address ? { address } : {}), soapVersion });
        const iq = resolveQ(attr(b.n, 'interface') ?? attr(svc.n, 'interface'), b.s)!;
        const bops = kids(b.n, b.s, W, 'operation');
        for (const op of ifaceOps(iq)) {
          const name = attr(op.n, 'name') ?? '';
          const bop = bops.find((x) => resolveQ(attr(x.n, 'ref'), x.s)?.local === name);
          const action = bop ? nsAttr(bop.n, bop.s, WSOAP, 'action') : undefined;
          const style = /rpc/.test(attr(op.n, 'style') ?? '') ? 'rpc' : 'document';
          model.operations.push({
            name, service: service.name, port: attr(ep.n, 'name') ?? '', binding: bq.local, ...(address ? { endpoint: address } : {}), soapVersion,
            ...(action !== undefined ? { soapAction: action } : {}), style: 'document', ...(style === 'rpc' ? {} : {}),
            input: part(kids(op.n, op.s, W, 'input')[0]), output: part(kids(op.n, op.s, W, 'output')[0]),
            faults: [...kids(op.n, op.s, W, 'outfault'), ...kids(op.n, op.s, W, 'infault')].map((f) => ({ name: resolveQ(attr(f.n, 'ref'), f.s)?.local ?? '', parts: [] })),
            ...(docText(op.n, op.s, W) ? { documentation: docText(op.n, op.s, W) } : {}),
          });
        }
      }
      model.services.push(service);
    }
  }
}

// ------------------------------------------------------------------ requests

/** The operation by name (and optionally service/port); throws listing what exists. */
export function findOperation(model: WsdlModel, name: string, o: { service?: string; port?: string; soapVersion?: '1.1' | '1.2' } = {}): WsdlOperation {
  const all = model.operations.filter((op) => op.name === name && (!o.service || op.service === o.service) && (!o.port || op.port === o.port));
  if (!all.length) {
    const names = [...new Set(model.operations.map((op) => op.name))];
    throw new EzTestError(`Operation "${name}" is not in the WSDL${o.port ? ` (port ${o.port})` : ''}; operations: ${names.join(', ') || 'none'}`, 'WSDL_OPERATION');
  }
  return all.find((op) => op.soapVersion === (o.soapVersion ?? op.soapVersion)) ?? all[0];
}

/** The Body content skeleton of an operation's input (document: the part elements; rpc: the wrapper). */
export function bodySkeleton(model: WsdlModel, op: WsdlOperation, o: { allChoices?: boolean } = {}): string {
  if (op.style === 'rpc') {
    const inner = op.input.map((p) => {
      if (p.element) return model.schemas.skeleton(p.element.ns, p.element.local, { prefix: "ns1", ...o });
      const t = p.type ? model.schemas.resolveType(`{${p.type.ns}}${p.type.local}`) : undefined;
      const v = t && t.kind === 'simple' ? model.schemas.sampleValue(t) : '?';
      return `<${p.name}>${v}</${p.name}>`;
    }).join('');
    return `<op:${op.name} xmlns:op="${op.rpcNamespace ?? model.targetNamespace}">${inner}</op:${op.name}>`;
  }
  return op.input.filter((p) => p.element).map((p) => model.schemas.skeleton(p.element!.ns, p.element!.local, o)).join("\n");
}

/** A whole request envelope for an operation (SOAP version from its binding). */
export function requestSkeleton(model: WsdlModel, op: WsdlOperation): string {
  const env = SOAP_ENV[op.soapVersion];
  const body = bodySkeleton(model, op).split('\n').map((l) => `    ${l}`).join('\n');
  return `<soapenv:Envelope xmlns:soapenv="${env}">\n  <soapenv:Header/>\n  <soapenv:Body>\n${body}\n  </soapenv:Body>\n</soapenv:Envelope>\n`;
}
