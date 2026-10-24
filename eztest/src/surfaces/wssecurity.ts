/**
 * WS-Security 1.0/1.1 (OASIS SOAP Message Security) for SOAP 1.1 and 1.2,
 * written from the OASIS specifications:
 *  - UsernameToken Profile 1.0/1.1: PasswordText and PasswordDigest
 *    (Base64(SHA-1(nonce + created + password))), Nonce and Created;
 *  - Timestamp (Created/Expires);
 *  - X.509 Token Profile: a BinarySecurityToken carrying the certificate and
 *    an XML Signature (own implementation, src/surfaces/xmldsig.ts) over the
 *    Body and the Timestamp, exclusive canonicalization, SHA-256, RSA-SHA256.
 * Verification checks signatures (and which parts they cover), the timestamp
 * window, and UsernameToken credentials on the receiving side.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { EzTestError } from '../core/index.js';
import { C14N_EXC } from './c14n.js';
import { DS_NS, derToPem, elementById, pemToDer, signXml, verifyXmlSignature, type VerifyResult } from './xmldsig.js';
import {
  appendChild, childElements, declareNamespace, findElements, firstChild, getAttr, insertChild, parseFragment, parseXml, serializeXml, setAttr, textContent,
  type XDocument, type XElement,
} from './xml-dom.js';

export const WSSE_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
export const WSU_NS = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd';
const UT_PROFILE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0';
export const PASSWORD_TEXT = `${UT_PROFILE}#PasswordText`;
export const PASSWORD_DIGEST = `${UT_PROFILE}#PasswordDigest`;
const BASE64_BINARY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';
const X509V3 = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

export interface UsernameTokenOptions {
  username: string;
  password: string;
  /** "text" (default) sends the password; "digest" sends Base64(SHA-1(nonce + created + password)). */
  passwordType?: 'text' | 'digest';
  /** Add Nonce and Created (always with digest; default false with text). */
  nonce?: boolean;
}

export interface SignatureOptions {
  /** PEM RSA private key. */
  privateKey: string;
  /** PEM X.509 certificate sent as the BinarySecurityToken. */
  certificate: string;
  /** Parts to sign. Default Body and Timestamp. */
  parts?: Array<'Body' | 'Timestamp' | 'UsernameToken'>;
  /** XML-DSig algorithm URIs (defaults: RSA-SHA256, SHA-256, exclusive c14n). */
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
}

export interface WsSecurityOptions {
  username?: UsernameTokenOptions;
  /** Add a Timestamp; a number is its lifetime in seconds (default 300). */
  timestamp?: boolean | number;
  signature?: SignatureOptions;
  /** soap:mustUnderstand on the Security header. Default true. */
  mustUnderstand?: boolean;
  /** Clock (tests). */
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** PasswordDigest = Base64(SHA-1(nonce bytes + created + password)). */
export function passwordDigest(nonceB64: string, created: string, password: string): string {
  return createHash('sha1').update(Buffer.concat([Buffer.from(nonceB64, 'base64'), Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')])).digest('base64');
}

function envelopeParts(doc: XDocument): { env: XElement; soapNs: string; header?: XElement; body: XElement } {
  const env = doc.root;
  if (env.local !== 'Envelope' || (env.ns !== SOAP11 && env.ns !== SOAP12)) throw new EzTestError('Not a SOAP envelope', 'SOAP_NO_ENVELOPE');
  const body = firstChild(env, 'Body', env.ns);
  if (!body) throw new EzTestError('SOAP Envelope has no Body', 'SOAP_NO_BODY');
  return { env, soapNs: env.ns, header: firstChild(env, 'Header', env.ns), body };
}

function ensureId(el: XElement, prefix: string): string {
  const existing = getAttr(el, 'Id', WSU_NS);
  if (existing) return existing;
  declareNamespace(el, 'wsu', WSU_NS);
  const id = `${prefix}-${randomUUID()}`;
  setAttr(el, 'wsu:Id', id, WSU_NS);
  return id;
}

/** Add a wsse:Security header (UsernameToken, Timestamp, X.509 signature) to a SOAP envelope. */
export function applyWsSecurity(envelopeXml: string, o: WsSecurityOptions): string {
  const doc = parseXml(envelopeXml);
  const { env, soapNs, body } = envelopeParts(doc);
  let header = firstChild(env, 'Header', soapNs);
  if (!header) {
    header = parseFragment(`<${env.prefix ? `${env.prefix}:` : ''}Header/>`, env);
    insertChild(env, header, env.children.indexOf(body));
  }
  // mustUnderstand is a namespace-qualified attribute: with a default-namespace envelope, declare a prefix for it.
  const soapPrefix = env.prefix || 'soapenv';
  const mu = o.mustUnderstand === false ? '' : `${env.prefix ? '' : ` xmlns:soapenv="${soapNs}"`} ${soapPrefix}:mustUnderstand="${soapNs === SOAP12 ? 'true' : '1'}"`;
  const security = parseFragment(`<wsse:Security xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}"${mu}/>`, header);
  insertChild(header, security, 0);
  const now = o.now?.() ?? new Date();
  let timestamp: XElement | undefined;
  if (o.timestamp) {
    const ttl = typeof o.timestamp === 'number' ? o.timestamp : 300;
    timestamp = parseFragment(`<wsu:Timestamp wsu:Id="TS-${randomUUID()}"><wsu:Created>${iso(now)}</wsu:Created><wsu:Expires>${iso(new Date(now.getTime() + ttl * 1000))}</wsu:Expires></wsu:Timestamp>`, security);
    appendChild(security, timestamp);
  }
  let token: XElement | undefined;
  if (o.username) {
    const u = o.username;
    const digest = u.passwordType === 'digest';
    const created = iso(now);
    const nonce = randomBytes(16).toString('base64');
    const withNonce = digest || u.nonce === true;
    const pw = digest ? passwordDigest(nonce, created, u.password) : u.password;
    token = parseFragment(`<wsse:UsernameToken wsu:Id="UT-${randomUUID()}"><wsse:Username>${esc(u.username)}</wsse:Username><wsse:Password Type="${digest ? PASSWORD_DIGEST : PASSWORD_TEXT}">${esc(pw)}</wsse:Password>${withNonce ? `<wsse:Nonce EncodingType="${BASE64_BINARY}">${nonce}</wsse:Nonce><wsu:Created>${created}</wsu:Created>` : ''}</wsse:UsernameToken>`, security);
    appendChild(security, token);
  }
  if (o.signature) {
    const s = o.signature;
    const bstId = `X509-${randomUUID()}`;
    const bst = parseFragment(`<wsse:BinarySecurityToken EncodingType="${BASE64_BINARY}" ValueType="${X509V3}" wsu:Id="${bstId}">${pemToDer(s.certificate)}</wsse:BinarySecurityToken>`, security);
    insertChild(security, bst, timestamp ? 1 : 0);
    const parts = s.parts ?? ['Body', 'Timestamp'];
    const references = parts.map((p) => {
      if (p === 'Body') return { element: body, id: ensureId(body, 'id') };
      if (p === 'Timestamp') {
        if (!timestamp) throw new EzTestError('Signing the Timestamp needs timestamp: true', 'WSS_CONFIG');
        return { element: timestamp, id: getAttr(timestamp, 'Id', WSU_NS)! };
      }
      if (!token) throw new EzTestError('Signing the UsernameToken needs a username token', 'WSS_CONFIG');
      return { element: token, id: getAttr(token, 'Id', WSU_NS)! };
    });
    signXml({
      references, privateKey: s.privateKey, parent: security,
      keyInfoXml: `<wsse:SecurityTokenReference><wsse:Reference URI="#${bstId}" ValueType="${X509V3}"/></wsse:SecurityTokenReference>`,
      ...(s.signatureAlgorithm ? { signatureAlgorithm: s.signatureAlgorithm } : {}), ...(s.digestAlgorithm ? { digestAlgorithm: s.digestAlgorithm } : {}),
      canonicalization: C14N_EXC,
    });
  }
  return serializeXml(doc, { declaration: /^\s*<\?xml/.test(envelopeXml) });
}

export interface WsVerifyOptions {
  /** PEM certificates the signer must be one of. Without them a valid signature is reported as not trusted. */
  trustedCertificates?: string[];
  /** Fail when the message is not signed. Default false. */
  requireSignature?: boolean;
  /** Parts the signature must cover (default: Body, plus Timestamp when there is one). */
  requireParts?: Array<'Body' | 'Timestamp'>;
  /** Allowed clock skew for Timestamp checks (seconds). Default 300. */
  clockSkewSeconds?: number;
  /** Fail when there is no Timestamp. Default false. */
  requireTimestamp?: boolean;
  now?: () => Date;
}

export interface WsVerifyResult {
  /** Everything required checked out. */
  ok: boolean;
  signed: boolean;
  signatureValid?: boolean;
  /** The signer's certificate is one of the trusted ones (undefined when none were configured). */
  trusted?: boolean;
  signedParts: string[];
  certificate?: { subject: string; issuer: string; fingerprint256: string; validTo: string };
  timestamp?: { created: string; expires?: string; fresh: boolean };
  username?: string;
  errors: string[];
  signature?: VerifyResult;
}

function securityHeader(doc: XDocument): XElement | undefined {
  const { header } = envelopeParts(doc);
  return header ? childElements(header, 'Security', WSSE_NS)[0] : undefined;
}

/** Check the WS-Security header of a received envelope: signature, covered parts, trust and timestamp. */
export function verifyWsSecurity(envelopeXml: string, o: WsVerifyOptions = {}): WsVerifyResult {
  const doc = parseXml(envelopeXml);
  const { body } = envelopeParts(doc);
  const sec = securityHeader(doc);
  const errors: string[] = [];
  const out: WsVerifyResult = { ok: false, signed: false, signedParts: [], errors };
  const now = (o.now?.() ?? new Date()).getTime();
  const skew = (o.clockSkewSeconds ?? 300) * 1000;
  const ts = sec ? firstChild(sec, 'Timestamp', WSU_NS) : undefined;
  if (ts) {
    const created = textContent(firstChild(ts, 'Created', WSU_NS) ?? ({ type: 'text', value: '' } as never)).trim();
    const expiresEl = firstChild(ts, 'Expires', WSU_NS);
    const expires = expiresEl ? textContent(expiresEl).trim() : undefined;
    const c = Date.parse(created);
    const e = expires ? Date.parse(expires) : undefined;
    const fresh = Number.isFinite(c) && c - skew <= now && (e === undefined || now - skew <= e);
    out.timestamp = { created, ...(expires ? { expires } : {}), fresh };
    if (!fresh) errors.push(`Timestamp is not valid now (created ${created}${expires ? `, expires ${expires}` : ''})`);
  } else if (o.requireTimestamp) errors.push('No wsu:Timestamp in the Security header');
  const ut = sec ? firstChild(sec, 'UsernameToken', WSSE_NS) : undefined;
  if (ut) out.username = textContent(firstChild(ut, 'Username', WSSE_NS) ?? ({ type: 'text', value: '' } as never)).trim();
  const sig = sec ? firstChild(sec, 'Signature', DS_NS) : undefined;
  if (!sig) {
    if (o.requireSignature) errors.push('The message is not signed (no ds:Signature in the Security header)');
    out.ok = errors.length === 0;
    return out;
  }
  out.signed = true;
  // The signer's certificate: SecurityTokenReference -> BinarySecurityToken, or ds:X509Data.
  let certPem: string | undefined;
  const keyInfo = firstChild(sig, 'KeyInfo', DS_NS);
  const str = keyInfo ? firstChild(keyInfo, 'SecurityTokenReference', WSSE_NS) : undefined;
  const ref = str ? firstChild(str, 'Reference', WSSE_NS) : undefined;
  if (ref) {
    const uri = getAttr(ref, 'URI') ?? '';
    const bst = uri.startsWith('#') ? elementById(doc.root, uri.slice(1)) : undefined;
    if (bst && bst.local === 'BinarySecurityToken') certPem = derToPem(textContent(bst));
    else errors.push(`SecurityTokenReference ${uri} does not point to a BinarySecurityToken`);
  } else if (keyInfo) {
    const x509 = findElements(keyInfo, (e) => e.local === 'X509Certificate' && e.ns === DS_NS)[0];
    if (x509) certPem = derToPem(textContent(x509));
  }
  if (!certPem && o.trustedCertificates?.length === 1) certPem = o.trustedCertificates[0];
  if (!certPem) {
    errors.push('No signing certificate found in the message (and no single trusted certificate to use)');
    return out;
  }
  const cert = new X509Certificate(certPem);
  out.certificate = { subject: cert.subject, issuer: cert.issuer, fingerprint256: cert.fingerprint256, validTo: cert.validTo };
  if (o.trustedCertificates?.length) {
    out.trusted = o.trustedCertificates.some((t) => new X509Certificate(t).fingerprint256 === cert.fingerprint256);
    if (!out.trusted) errors.push(`The signer's certificate (${cert.subject.replace(/\n/g, ', ')}) is not a trusted one`);
  }
  const r = verifyXmlSignature(doc, sig, cert.publicKey);
  out.signature = r;
  out.signatureValid = r.valid;
  errors.push(...r.errors);
  for (const x of r.references) {
    if (!x.valid || !x.element) continue;
    // Only the envelope's own Body / the header's own Timestamp count (not copies moved elsewhere).
    if (x.element === body) out.signedParts.push('Body');
    else if (x.element === ts) out.signedParts.push('Timestamp');
    else if (x.element === ut) out.signedParts.push('UsernameToken');
    else out.signedParts.push(x.uri);
  }
  const need = o.requireParts ?? (['Body', ...(ts ? ['Timestamp'] : [])] as Array<'Body' | 'Timestamp'>);
  for (const p of need) if (!out.signedParts.includes(p)) errors.push(`The signature does not cover the ${p}`);
  out.ok = errors.length === 0;
  return out;
}

/** Receiving side: check a UsernameToken against known passwords (text or digest, with freshness). */
export function checkUsernameToken(envelopeXml: string, passwords: Record<string, string>, o: { now?: () => Date; maxAgeSeconds?: number } = {}): { ok: boolean; username?: string; error?: string } {
  const doc = parseXml(envelopeXml);
  const sec = securityHeader(doc);
  const ut = sec ? firstChild(sec, 'UsernameToken', WSSE_NS) : undefined;
  if (!ut) return { ok: false, error: 'no UsernameToken' };
  const username = textContent(firstChild(ut, 'Username', WSSE_NS) ?? ({ type: 'text', value: '' } as never)).trim();
  const pwEl = firstChild(ut, 'Password', WSSE_NS);
  const known = passwords[username];
  if (!pwEl || known === undefined) return { ok: false, username, error: 'unknown user' };
  const type = getAttr(pwEl, 'Type') ?? PASSWORD_TEXT;
  const given = textContent(pwEl);
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (type === PASSWORD_DIGEST) {
    const nonce = textContent(firstChild(ut, 'Nonce', WSSE_NS) ?? ({ type: 'text', value: '' } as never)).trim();
    const created = textContent(firstChild(ut, 'Created', WSU_NS) ?? ({ type: 'text', value: '' } as never)).trim();
    const age = ((o.now?.() ?? new Date()).getTime() - Date.parse(created)) / 1000;
    if (!nonce || !created || !(Math.abs(age) <= (o.maxAgeSeconds ?? 300))) return { ok: false, username, error: 'stale or missing Nonce/Created' };
    return same(passwordDigest(nonce, created, known), given) ? { ok: true, username } : { ok: false, username, error: 'wrong password digest' };
  }
  return same(given, known) ? { ok: true, username } : { ok: false, username, error: 'wrong password' };
}
