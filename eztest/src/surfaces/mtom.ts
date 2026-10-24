/**
 * MTOM / XOP (W3C SOAP Message Transmission Optimization Mechanism and XML-
 * binary Optimized Packaging), basic support written from the
 * recommendations: base64 element content is moved into binary MIME parts of
 * a multipart/related message and referenced with xop:Include; received
 * MTOM messages are put back together (xop:Include replaced by base64 text).
 *
 * Limits: one level of multipart/related, no Content-Transfer-Encoding other
 * than binary/8bit/base64, attachments held in memory.
 */
import { randomUUID } from 'node:crypto';
import { EzTestError } from '../core/index.js';
import { findElements, getAttr, parseXml, serializeXml, textContent, type XElement } from './xml-dom.js';

export const XOP_NS = 'http://www.w3.org/2004/08/xop/include';

export interface MimeAttachment {
  /** Content-ID without angle brackets. */
  id: string;
  contentType: string;
  data: Uint8Array;
}

export interface MtomMessage {
  body: Uint8Array;
  /** The HTTP Content-Type header for the request. */
  contentType: string;
  attachments: MimeAttachment[];
}

/**
 * Turn a SOAP envelope into an MTOM message: the text of every element whose local name is in
 * `binaryElements` (base64 content) is moved into its own MIME part.
 */
export function buildMtom(envelopeXml: string, o: { soapVersion?: '1.1' | '1.2'; binaryElements: string[]; action?: string; contentTypes?: Record<string, string> }): MtomMessage {
  const doc = parseXml(envelopeXml);
  const attachments: MimeAttachment[] = [];
  const wanted = new Set(o.binaryElements);
  for (const el of findElements(doc.root, (e) => wanted.has(e.local))) {
    const b64 = textContent(el).replace(/\s+/g, '');
    if (!b64) continue;
    const id = `${randomUUID()}@eztest`;
    attachments.push({ id, contentType: o.contentTypes?.[el.local] ?? 'application/octet-stream', data: new Uint8Array(Buffer.from(b64, 'base64')) });
    const include: XElement = { type: 'element', name: 'xop:Include', prefix: 'xop', local: 'Include', ns: XOP_NS, attrs: [{ name: 'href', prefix: '', local: 'href', ns: '', value: `cid:${encodeURIComponent(id).replace(/%40/g, '@')}` }], nsDecls: [{ prefix: 'xop', uri: XOP_NS }], children: [], parent: el };
    el.children = [include];
  }
  const soapType = o.soapVersion === '1.2' ? 'application/soap+xml' : 'text/xml';
  const boundary = `MIMEBoundary_${randomUUID().replace(/-/g, '')}`;
  const rootId = `root.${randomUUID()}@eztest`;
  const rootXml = serializeXml(doc, { declaration: true });
  const actionParam = o.soapVersion === '1.2' && o.action ? `; action="${o.action.replace(/"/g, '')}"` : '';
  const parts: Buffer[] = [];
  const crlf = '\r\n';
  parts.push(Buffer.from(`--${boundary}${crlf}Content-Type: application/xop+xml; charset=UTF-8; type="${soapType}"${actionParam}${crlf}Content-Transfer-Encoding: 8bit${crlf}Content-ID: <${rootId}>${crlf}${crlf}`));
  parts.push(Buffer.from(rootXml, 'utf8'));
  for (const a of attachments) {
    parts.push(Buffer.from(`${crlf}--${boundary}${crlf}Content-Type: ${a.contentType}${crlf}Content-Transfer-Encoding: binary${crlf}Content-ID: <${a.id}>${crlf}${crlf}`));
    parts.push(Buffer.from(a.data));
  }
  parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`));
  return {
    body: new Uint8Array(Buffer.concat(parts)),
    contentType: `multipart/related; type="application/xop+xml"; start="<${rootId}>"; start-info="${soapType}"; boundary="${boundary}"${actionParam}`,
    attachments,
  };
}

function headerParam(ct: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(ct);
  return m ? m[1] ?? m[2] : undefined;
}

/** True for a multipart/related (MTOM/SwA) Content-Type. */
export function isMultipartRelated(contentType: string | undefined): boolean {
  return !!contentType && /^\s*multipart\/related/i.test(contentType);
}

/**
 * Parse a multipart/related message: the root part (start parameter, else the first part) is the
 * envelope; xop:Include elements are replaced by the base64 of the part they reference.
 */
export function parseMtom(body: Uint8Array, contentType: string): { envelopeXml: string; attachments: MimeAttachment[] } {
  const boundary = headerParam(contentType, 'boundary');
  if (!boundary) throw new EzTestError('multipart/related message without a boundary', 'MTOM_PARSE');
  const buf = Buffer.from(body);
  const delim = Buffer.from(`--${boundary}`);
  const parts: Array<{ headers: Record<string, string>; data: Buffer }> = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) throw new EzTestError('multipart/related boundary not found in the body', 'MTOM_PARSE');
  for (;;) {
    let start = pos + delim.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;
    const next = buf.indexOf(delim, start);
    if (next < 0) throw new EzTestError('Unterminated MIME part', 'MTOM_PARSE');
    let end = next;
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    const part = buf.subarray(start, end);
    let sep = part.indexOf('\r\n\r\n');
    let skip = 4;
    if (sep < 0) {
      sep = part.indexOf('\n\n');
      skip = 2;
    }
    const headers: Record<string, string> = {};
    for (const line of part.subarray(0, Math.max(0, sep)).toString('latin1').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    let data = sep < 0 ? Buffer.alloc(0) : part.subarray(sep + skip);
    if (/base64/i.test(headers['content-transfer-encoding'] ?? '')) data = Buffer.from(data.toString('latin1').replace(/\s+/g, ''), 'base64');
    parts.push({ headers, data });
    pos = next;
  }
  if (!parts.length) throw new EzTestError('multipart/related message has no parts', 'MTOM_PARSE');
  const cid = (h: Record<string, string>) => (h['content-id'] ?? '').replace(/^<|>$/g, '');
  const start = headerParam(contentType, 'start')?.replace(/^<|>$/g, '');
  const root = (start && parts.find((p) => cid(p.headers) === start)) || parts[0];
  const attachments = parts.filter((p) => p !== root).map((p) => ({ id: cid(p.headers), contentType: p.headers['content-type'] ?? 'application/octet-stream', data: new Uint8Array(p.data) }));
  const doc = parseXml(root.data.toString('utf8'));
  for (const inc of findElements(doc.root, (e) => e.local === 'Include' && e.ns === XOP_NS)) {
    const href = decodeURIComponent((getAttr(inc, 'href') ?? '').replace(/^cid:/i, ''));
    const att = attachments.find((a) => a.id === href);
    if (!att) throw new EzTestError(`xop:Include references a missing part "${href}"`, 'MTOM_PARSE');
    const parent = inc.parent!;
    parent.children = parent.children.flatMap((c) => (c === inc ? [{ type: 'text' as const, value: Buffer.from(att.data).toString('base64'), parent }] : [c]));
  }
  return { envelopeXml: serializeXml(doc), attachments };
}
