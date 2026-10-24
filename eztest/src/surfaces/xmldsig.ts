/**
 * XML Signature (XML-DSig 1.0 / 1.1 algorithms), written from the W3C
 * recommendation: detached same-document references (URI="#id"), the
 * enveloped-signature transform, exclusive and inclusive canonicalization,
 * SHA-1/SHA-256/SHA-512 digests and RSA PKCS#1 v1.5 signatures (signing uses
 * SHA-256 by default; SHA-1 is accepted when verifying older services).
 * Crypto comes from node:crypto; the XML handling is EZTest's own.
 */
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, X509Certificate, type KeyObject } from 'node:crypto';
import { EzTestError } from '../core/index.js';
import { C14N_EXC, C14N_EXC_COMMENTS, canonicalize, c14nOptionsFor } from './c14n.js';
import { childElements, findElements, firstChild, getAttr, insertChild, appendChild, parseFragment, textContent, type XDocument, type XElement, type XNode } from './xml-dom.js';

export const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
export const ENVELOPED_SIGNATURE = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export const DIGEST_ALGORITHMS: Record<string, string> = {
  'http://www.w3.org/2000/09/xmldsig#sha1': 'sha1',
  'http://www.w3.org/2001/04/xmlenc#sha256': 'sha256',
  'http://www.w3.org/2001/04/xmlenc#sha512': 'sha512',
};
export const SIGNATURE_ALGORITHMS: Record<string, string> = {
  'http://www.w3.org/2000/09/xmldsig#rsa-sha1': 'sha1',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256': 'sha256',
  'http://www.w3.org/2001/04/xmldsig-more#rsa-sha512': 'sha512',
};
export const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

export class XmlSignatureError extends EzTestError {
  constructor(message: string, code = 'XMLDSIG_ERROR') {
    super(message, code);
    this.name = 'XmlSignatureError';
  }
}

/** The element carrying an Id (wsu:Id, Id, ID or id) equal to `id`; throws when ambiguous (signature wrapping). */
export function elementById(root: XElement, id: string): XElement | undefined {
  const hits = findElements(root, (e) => e.attrs.some((a) => (a.local === 'Id' || a.local === 'ID' || a.local === 'id') && a.value === id));
  if (hits.length > 1) throw new XmlSignatureError(`Id "${id}" is used by ${hits.length} elements (possible signature wrapping)`, 'XMLDSIG_DUPLICATE_ID');
  return hits[0];
}

export interface ReferenceSpec {
  /** Element to sign; must carry an Id attribute equal to `id`. */
  element: XElement;
  id: string;
  /** Transform algorithms (default: exclusive canonicalization). */
  transforms?: string[];
  inclusivePrefixes?: string[];
}

export interface SignOptions {
  references: ReferenceSpec[];
  /** RSA private key (PEM text or KeyObject). */
  privateKey: string | KeyObject;
  /** Where the ds:Signature element goes, and where among the parent's children (default: last). */
  parent: XElement;
  index?: number;
  /** ds:KeyInfo content (XML, may use prefixes in scope at `parent`). */
  keyInfoXml?: string;
  canonicalization?: string;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  /** Prefix for the signature elements (default "ds"). */
  prefix?: string;
}

function digestOf(alg: string, data: string): string {
  const h = DIGEST_ALGORITHMS[alg];
  if (!h) throw new XmlSignatureError(`Unsupported digest algorithm ${alg}`, 'XMLDSIG_ALGORITHM');
  return createHash(h).update(data, 'utf8').digest('base64');
}

/** Apply a reference's transforms to an element: the canonical octets that get digested. */
function transformed(el: XElement, transforms: Array<{ algorithm: string; inclusivePrefixes?: string[] }>, signature?: XElement): string {
  let exclude: ((n: XNode) => boolean) | undefined;
  let c14n: { algorithm: string; inclusivePrefixes?: string[] } | undefined;
  for (const t of transforms) {
    if (t.algorithm === ENVELOPED_SIGNATURE) exclude = (n) => n === signature;
    else c14n = t;
  }
  const o = c14nOptionsFor(c14n?.algorithm ?? 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315', c14n?.inclusivePrefixes);
  return canonicalize(el, { ...o, exclude });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** Sign elements of a document; inserts and returns the ds:Signature element. */
export function signXml(o: SignOptions): XElement {
  const p = o.prefix ?? 'ds';
  const q = (n: string) => (p ? `${p}:${n}` : n);
  const c14n = o.canonicalization ?? C14N_EXC;
  const sigAlg = o.signatureAlgorithm ?? RSA_SHA256;
  const digAlg = o.digestAlgorithm ?? SHA256;
  const hash = SIGNATURE_ALGORITHMS[sigAlg];
  if (!hash) throw new XmlSignatureError(`Unsupported signature algorithm ${sigAlg}`, 'XMLDSIG_ALGORITHM');
  const nsDecl = p ? ` xmlns:${p}="${DS_NS}"` : ` xmlns="${DS_NS}"`;
  const incl = (prefixes?: string[]) => (prefixes?.length ? `<ec:InclusiveNamespaces xmlns:ec="${C14N_EXC}" PrefixList="${esc(prefixes.join(' '))}"/>` : '');
  // Insert the signature first (empty values), so enveloped references see the final document.
  const shell = parseFragment(`<${q('Signature')}${nsDecl}><${q('SignedInfo')}/><${q('SignatureValue')}/>${o.keyInfoXml ? `<${q('KeyInfo')}>${o.keyInfoXml}</${q('KeyInfo')}>` : ''}</${q('Signature')}>`, o.parent);
  if (o.index === undefined) appendChild(o.parent, shell);
  else insertChild(o.parent, shell, o.index);
  const refs = o.references.map((r) => {
    const transforms = r.transforms ?? [C14N_EXC];
    const data = transformed(r.element, transforms.map((a) => ({ algorithm: a, inclusivePrefixes: r.inclusivePrefixes })), shell);
    const t = transforms.map((a) => `<${q('Transform')} Algorithm="${a}">${a === C14N_EXC || a === C14N_EXC_COMMENTS ? incl(r.inclusivePrefixes) : ''}</${q('Transform')}>`).join('');
    return `<${q('Reference')} URI="#${esc(r.id)}"><${q('Transforms')}>${t}</${q('Transforms')}><${q('DigestMethod')} Algorithm="${digAlg}"/><${q('DigestValue')}>${digestOf(digAlg, data)}</${q('DigestValue')}></${q('Reference')}>`;
  }).join('');
  const signedInfo = parseFragment(`<${q('SignedInfo')}><${q('CanonicalizationMethod')} Algorithm="${c14n}"/><${q('SignatureMethod')} Algorithm="${sigAlg}"/>${refs}</${q('SignedInfo')}>`, shell);
  shell.children[0] = signedInfo;
  signedInfo.parent = shell;
  const canonical = canonicalize(signedInfo, c14nOptionsFor(c14n));
  const value = cryptoSign(hash, Buffer.from(canonical, 'utf8'), o.privateKey).toString('base64');
  const sv = shell.children[1] as XElement;
  sv.children = [{ type: 'text', value, parent: sv }];
  return shell;
}

export interface ReferenceResult {
  uri: string;
  valid: boolean;
  element?: XElement;
  digestAlgorithm: string;
  transforms: string[];
  problem?: string;
}

export interface VerifyResult {
  valid: boolean;
  signatureValid: boolean;
  references: ReferenceResult[];
  signatureAlgorithm: string;
  canonicalization: string;
  errors: string[];
}

function transformsOf(ref: XElement): Array<{ algorithm: string; inclusivePrefixes?: string[] }> {
  const ts = firstChild(ref, 'Transforms', DS_NS);
  if (!ts) return [];
  return childElements(ts, 'Transform', DS_NS).map((t) => {
    const algorithm = getAttr(t, 'Algorithm') ?? '';
    const inc = childElements(t).find((c) => c.local === 'InclusiveNamespaces');
    const list = inc ? getAttr(inc, 'PrefixList') : undefined;
    return { algorithm, ...(list ? { inclusivePrefixes: list.trim().split(/\s+/) } : {}) };
  });
}

/** Verify a ds:Signature element with a public key (PEM, certificate PEM or KeyObject). */
export function verifyXmlSignature(doc: XDocument, signature: XElement, key: string | KeyObject): VerifyResult {
  const errors: string[] = [];
  const si = firstChild(signature, 'SignedInfo', DS_NS);
  const sv = firstChild(signature, 'SignatureValue', DS_NS);
  if (!si || !sv) throw new XmlSignatureError('ds:Signature has no SignedInfo or SignatureValue', 'XMLDSIG_MALFORMED');
  const cm = firstChild(si, 'CanonicalizationMethod', DS_NS);
  const canonicalization = (cm && getAttr(cm, 'Algorithm')) ?? '';
  const cmInc = cm ? childElements(cm).find((c) => c.local === 'InclusiveNamespaces') : undefined;
  const sm = firstChild(si, 'SignatureMethod', DS_NS);
  const signatureAlgorithm = (sm && getAttr(sm, 'Algorithm')) ?? '';
  const hash = SIGNATURE_ALGORITHMS[signatureAlgorithm];
  if (!hash) throw new XmlSignatureError(`Unsupported signature algorithm ${signatureAlgorithm}`, 'XMLDSIG_ALGORITHM');
  let canonical: string;
  try {
    canonical = canonicalize(si, c14nOptionsFor(canonicalization, cmInc ? getAttr(cmInc, 'PrefixList')?.trim().split(/\s+/) : undefined));
  } catch (e) {
    throw new XmlSignatureError((e as Error).message, 'XMLDSIG_ALGORITHM');
  }
  const pub = typeof key === 'string' ? (/BEGIN CERTIFICATE/.test(key) ? new X509Certificate(key).publicKey : createPublicKey(key)) : key;
  const signatureValid = cryptoVerify(hash, Buffer.from(canonical, 'utf8'), pub, Buffer.from(textContent(sv).replace(/\s+/g, ''), 'base64'));
  if (!signatureValid) errors.push('SignatureValue does not match SignedInfo (wrong key, or SignedInfo was changed)');
  const references: ReferenceResult[] = [];
  for (const ref of childElements(si, 'Reference', DS_NS)) {
    const uri = getAttr(ref, 'URI') ?? '';
    const dm = firstChild(ref, 'DigestMethod', DS_NS);
    const digestAlgorithm = (dm && getAttr(dm, 'Algorithm')) ?? '';
    const want = textContent(firstChild(ref, 'DigestValue', DS_NS) ?? ({ type: 'text', value: '' } as never)).replace(/\s+/g, '');
    const transforms = transformsOf(ref);
    const r: ReferenceResult = { uri, valid: false, digestAlgorithm, transforms: transforms.map((t) => t.algorithm) };
    try {
      let el: XElement | undefined;
      if (uri === '') el = doc.root;
      else if (uri.startsWith('#')) el = elementById(doc.root, uri.slice(1));
      else throw new XmlSignatureError(`External reference URI "${uri}" is not supported`, 'XMLDSIG_REFERENCE');
      if (!el) throw new XmlSignatureError(`Reference ${uri} points to no element`, 'XMLDSIG_REFERENCE');
      r.element = el;
      const got = digestOf(digestAlgorithm, transformed(el, transforms, signature));
      r.valid = got === want;
      if (!r.valid) r.problem = `digest mismatch for ${uri} (the signed content was changed)`;
    } catch (e) {
      r.problem = (e as Error).message;
    }
    if (r.problem) errors.push(r.problem);
    references.push(r);
  }
  if (!references.length) errors.push('SignedInfo has no Reference');
  return { valid: signatureValid && references.length > 0 && references.every((r) => r.valid), signatureValid, references, signatureAlgorithm, canonicalization, errors };
}

/** PEM certificate text from base64 DER. */
export function derToPem(b64: string): string {
  const body = b64.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** Base64 DER of the first certificate in a PEM text. */
export function pemToDer(pem: string): string {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new XmlSignatureError('No PEM certificate found', 'XMLDSIG_KEY');
  return m[1].replace(/\s+/g, '');
}
