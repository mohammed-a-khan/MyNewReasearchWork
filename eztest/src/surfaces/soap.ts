/** SOAP 1.1 / 1.2: envelope building, request, response parsing and fault detection. */
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { EzTestError } from '../core/index.js';
import type { ApiClient, ApiResponse, RequestOptions } from './api.js';

// The SOAP stack (re-exported here so the surfaces index stays as it is).
export * from './xml-dom.js';
export * from './c14n.js';
export * from './xmldsig.js';
export * from './wssecurity.js';
export * from './mtom.js';
export * from './xsd.js';
export * from './wsdl.js';
export * from './soap-service.js';

export type SoapVersion = '1.1' | '1.2';
export const SOAP_NS: Record<SoapVersion, string> = {
  '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
  '1.2': 'http://www.w3.org/2003/05/soap-envelope',
};

export interface SoapEnvelopeOptions {
  version?: SoapVersion;
  /** Raw XML string (inserted verbatim) or an object converted to XML (values escaped). */
  body: string | Record<string, unknown>;
  header?: string | Record<string, unknown>;
  /** Extra namespace declarations on the Envelope: { tns: 'http://...' }. */
  namespaces?: Record<string, string>;
}

const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: false, suppressEmptyNode: true });

function toXml(v: string | Record<string, unknown>): string {
  return typeof v === 'string' ? v : (builder.build(v) as string);
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function buildSoapEnvelope(o: SoapEnvelopeOptions): string {
  const version = o.version ?? '1.1';
  const ns = Object.entries(o.namespaces ?? {})
    .map(([p, uri]) => {
      if (!/^[A-Za-z_][\w.-]*$/.test(p)) throw new EzTestError(`Invalid namespace prefix "${p}"`, 'SOAP_BAD_NS');
      return ` xmlns:${p}="${escapeXml(uri)}"`;
    })
    .join('');
  const header = o.header !== undefined ? `<soap:Header>${toXml(o.header)}</soap:Header>` : '';
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP_NS[version]}"${ns}>${header}<soap:Body>${toXml(o.body)}</soap:Body></soap:Envelope>`;
}

export interface SoapFault {
  code: string;
  reason: string;
  detail?: unknown;
}

export interface SoapResponse {
  version?: SoapVersion;
  /** Parsed document with namespace prefixes removed. */
  document: Record<string, unknown>;
  header?: unknown;
  body: Record<string, unknown>;
  fault?: SoapFault;
  http?: ApiResponse;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false, // keep "00123" a string; typing is the caller's decision
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

const textOf = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return textOf((v as Record<string, unknown>)['#text']);
  return String(v);
};

export function parseSoapResponse(xml: string): SoapResponse {
  if (!xml || !xml.trim()) throw new EzTestError('Empty SOAP response', 'SOAP_EMPTY');
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml, true) as Record<string, unknown>;
  } catch (e) {
    throw new EzTestError(`SOAP response is not well-formed XML: ${(e as Error).message}`, 'SOAP_PARSE');
  }
  const env = doc.Envelope as Record<string, unknown> | undefined;
  if (!env || typeof env !== 'object') throw new EzTestError('SOAP response has no Envelope', 'SOAP_NO_ENVELOPE');
  // removeNSPrefix drops xmlns attributes, so read the Envelope start tag for the SOAP namespace.
  const envTag = /<(?:[\w.-]+:)?Envelope\b[^>]*>/.exec(xml)?.[0] ?? '';
  const version: SoapVersion | undefined = envTag.includes(SOAP_NS['1.2']) ? '1.2' : envTag.includes(SOAP_NS['1.1']) ? '1.1' : undefined;
  const body = (env.Body ?? {}) as Record<string, unknown>;
  if (typeof body !== 'object') throw new EzTestError('SOAP Envelope has no Body', 'SOAP_NO_BODY');
  let fault: SoapFault | undefined;
  const f = body.Fault as Record<string, unknown> | undefined;
  if (f && typeof f === 'object') {
    if ('faultcode' in f || 'faultstring' in f) {
      fault = { code: textOf(f.faultcode), reason: textOf(f.faultstring), detail: f.detail };
    } else {
      const code = f.Code as Record<string, unknown> | undefined;
      const reason = f.Reason as Record<string, unknown> | undefined;
      const sub = code?.Subcode as Record<string, unknown> | undefined;
      const texts = reason?.Text;
      fault = {
        code: textOf(code?.Value) + (sub ? `/${textOf(sub.Value)}` : ''),
        reason: Array.isArray(texts) ? textOf(texts[0]) : textOf(texts),
        detail: f.Detail,
      };
    }
  }
  return { version, document: doc, header: env.Header, body, fault };
}

/**
 * XPath-like getter for simple paths on parsed XML: "Envelope/Body/GetPriceResponse/Price",
 * with optional [n] (0-based) indexes and @attr. A leading "/" or "//" is not XPath search; paths are absolute
 * from the given node. Returns the text of leaf nodes.
 */
export function xmlGet(node: unknown, path: string): unknown {
  let cur: unknown = node;
  for (const raw of path.replace(/^\/+/, '').split('/').filter(Boolean)) {
    const m = /^(@?[\w.-]+|#text)(?:\[(\d+)\])?$/.exec(raw);
    if (!m) throw new EzTestError(`Unsupported XML path segment "${raw}"`, 'XML_PATH');
    const name = m[1].startsWith('@') ? '@_' + m[1].slice(1) : m[1];
    if (!cur || typeof cur !== 'object') return undefined;
    let next = (cur as Record<string, unknown>)[name];
    if (m[2] !== undefined) next = Array.isArray(next) ? next[Number(m[2])] : Number(m[2]) === 0 ? next : undefined;
    cur = next;
  }
  if (cur && typeof cur === 'object' && !Array.isArray(cur) && '#text' in (cur as object)) {
    const keys = Object.keys(cur as object).filter((k) => !k.startsWith('@_'));
    if (keys.length === 1) return (cur as Record<string, unknown>)['#text'];
  }
  return cur;
}

export class SoapFaultError extends EzTestError {
  constructor(readonly fault: SoapFault) {
    super(`SOAP fault ${fault.code}: ${fault.reason}`, 'SOAP_FAULT', { code: fault.code });
    this.name = 'SoapFaultError';
  }
}

export interface SoapCallOptions extends SoapEnvelopeOptions, Pick<RequestOptions, 'headers' | 'timeoutMs'> {
  action?: string;
  /** Throw SoapFaultError on a fault (default true). */
  throwOnFault?: boolean;
}

export async function soapRequest(api: ApiClient, path: string, o: SoapCallOptions): Promise<SoapResponse> {
  const version = o.version ?? '1.1';
  const headers: Record<string, string> = { ...o.headers };
  if (version === '1.1') {
    headers['content-type'] = 'text/xml; charset=utf-8';
    headers['soapaction'] = `"${o.action ?? ''}"`;
  } else {
    headers['content-type'] = `application/soap+xml; charset=utf-8${o.action ? `; action="${o.action.replace(/"/g, '')}"` : ''}`;
  }
  headers.accept = 'text/xml, application/soap+xml';
  const res = await api.post(path, { body: buildSoapEnvelope({ ...o, version }), headers, timeoutMs: o.timeoutMs });
  const parsed = parseSoapResponse(res.text);
  parsed.http = res;
  if (parsed.fault && o.throwOnFault !== false) throw new SoapFaultError(parsed.fault);
  if (!parsed.fault && !res.ok) throw new EzTestError(`SOAP call returned HTTP ${res.status} without a fault`, 'SOAP_HTTP');
  return parsed;
}
