/**
 * A small namespace-aware XML DOM, written from the XML 1.0 and Namespaces in
 * XML specifications, for the work that needs exact XML: canonicalization
 * (XML Signature), WS-Security headers, XSD validation and MTOM. It keeps
 * document order, comments, processing instructions, prefixes and namespace
 * declarations as written; line endings and attribute values are normalised
 * the way an XML processor must (XML 1.0 sections 2.11 and 3.3.3).
 *
 * Not supported (rejected or ignored, never guessed): DTD internal subsets
 * are skipped (no entity definitions, no attribute defaults), and only the
 * five predefined entities plus character references are expanded.
 */
import { EzTestError } from '../core/index.js';

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export interface XAttr {
  /** Qualified name as written (prefix:local). */
  name: string;
  prefix: string;
  local: string;
  value: string;
  /** Namespace URI ('' for unprefixed attributes). */
  ns: string;
}

export interface XElement {
  type: 'element';
  name: string;
  prefix: string;
  local: string;
  /** Namespace URI of the element ('' when none). */
  ns: string;
  /** Attributes other than namespace declarations, in document order. */
  attrs: XAttr[];
  /** Namespace declarations on this element (prefix '' is the default namespace), in document order. */
  nsDecls: Array<{ prefix: string; uri: string }>;
  children: XNode[];
  parent?: XElement;
}
export interface XText { type: 'text'; value: string; parent?: XElement }
export interface XComment { type: 'comment'; value: string; parent?: XElement }
export interface XPi { type: 'pi'; target: string; data: string; parent?: XElement }
export type XNode = XElement | XText | XComment | XPi;

export interface XDocument {
  root: XElement;
  /** Comments and processing instructions before the root element (the XML declaration is not one). */
  prolog: Array<XComment | XPi>;
  epilog: Array<XComment | XPi>;
}

export class XmlParseError extends EzTestError {
  constructor(message: string, readonly offset: number) {
    super(message, 'XML_PARSE', { offset });
    this.name = 'XmlParseError';
  }
}

const NAME_START = /[A-Za-z_:À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-·À-￿]/;

function decodeEntities(s: string, at: number): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);?/g, (m, ref: string) => {
    if (!m.endsWith(';')) throw new XmlParseError(`Unterminated entity reference "${m}"`, at);
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff) throw new XmlParseError(`Bad character reference "${m}"`, at);
      return String.fromCodePoint(cp);
    }
    const v = ({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' } as Record<string, string>)[ref];
    if (v === undefined) throw new XmlParseError(`Undefined entity "&${ref};" (only the predefined entities are supported)`, at);
    return v;
  });
}

function splitName(qname: string): { prefix: string; local: string } {
  const i = qname.indexOf(':');
  return i < 0 ? { prefix: '', local: qname } : { prefix: qname.slice(0, i), local: qname.slice(i + 1) };
}

/** Parse XML text into a namespace-aware DOM. */
export function parseXml(input: string): XDocument {
  // Line-end normalisation (XML 1.0 2.11); a leading BOM is dropped.
  const s = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let i = 0;
  const prolog: Array<XComment | XPi> = [];
  const epilog: Array<XComment | XPi> = [];
  let root: XElement | undefined;
  const stack: XElement[] = [];
  const fail = (msg: string): never => {
    throw new XmlParseError(`${msg} at offset ${i}`, i);
  };
  const readName = (): string => {
    const start = i;
    if (!NAME_START.test(s[i] ?? '')) fail('Expected a name');
    i++;
    while (i < s.length && NAME_CHAR.test(s[i])) i++;
    return s.slice(start, i);
  };
  const skipWs = () => {
    while (i < s.length && /[ \t\n]/.test(s[i])) i++;
  };
  const addChild = (n: XNode) => {
    const parent = stack[stack.length - 1];
    if (parent) {
      n.parent = parent;
      parent.children.push(n);
    } else if (n.type === 'comment' || n.type === 'pi') {
      (root ? epilog : prolog).push(n);
    } else if (n.type === 'text') {
      if (n.value.trim()) fail('Text outside the root element');
    }
  };
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end < 0) fail('Unterminated comment');
      addChild({ type: 'comment', value: s.slice(i + 4, end) });
      i = end + 3;
    } else if (s.startsWith('<![CDATA[', i)) {
      if (!stack.length) fail('CDATA outside the root element');
      const end = s.indexOf(']]>', i + 9);
      if (end < 0) fail('Unterminated CDATA section');
      addText(s.slice(i + 9, end));
      i = end + 3;
    } else if (s.startsWith('<!DOCTYPE', i)) {
      // Skip the document type declaration, including an internal subset.
      let depth = 0;
      for (i += 9; i < s.length; i++) {
        if (s[i] === '[') depth++;
        else if (s[i] === ']') depth--;
        else if (s[i] === '>' && depth <= 0) break;
        else if (s[i] === '"' || s[i] === "'") i = s.indexOf(s[i], i + 1);
        if (i < 0) fail('Unterminated DOCTYPE');
      }
      i++;
    } else if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i + 2);
      if (end < 0) fail('Unterminated processing instruction');
      const body = s.slice(i + 2, end);
      const m = /^([^\s?]+)([\s\S]*)$/.exec(body);
      if (!m) fail('Bad processing instruction');
      if (m![1].toLowerCase() !== 'xml') addChild({ type: 'pi', target: m![1], data: m![2].replace(/^[ \t\n]+/, '') });
      else if (stack.length || root || prolog.length) fail('XML declaration not at the start');
      i = end + 2;
    } else if (s.startsWith('</', i)) {
      i += 2;
      const name = readName();
      skipWs();
      if (s[i] !== '>') fail('Expected ">"');
      i++;
      const open = stack.pop();
      if (!open || open.name !== name) fail(`Mismatched end tag </${name}>${open ? ` (open: <${open.name}>)` : ''}`);
    } else if (s[i] === '<') {
      i++;
      const name = readName();
      const rawAttrs: Array<{ name: string; value: string }> = [];
      for (;;) {
        const before = i;
        skipWs();
        if (s[i] === '>' || s.startsWith('/>', i)) break;
        if (i === before) fail('Expected whitespace before an attribute');
        const an = readName();
        skipWs();
        if (s[i] !== '=') fail(`Expected "=" after attribute ${an}`);
        i++;
        skipWs();
        const q = s[i];
        if (q !== '"' && q !== "'") fail('Expected a quoted attribute value');
        const end = s.indexOf(q, i + 1);
        if (end < 0) fail('Unterminated attribute value');
        const raw = s.slice(i + 1, end);
        if (raw.includes('<')) fail('"<" in an attribute value');
        // Attribute-value normalisation (3.3.3): literal whitespace becomes a space, then references are expanded.
        rawAttrs.push({ name: an, value: decodeEntities(raw.replace(/[\t\n]/g, ' '), i) });
        i = end + 1;
        if (rawAttrs.filter((a) => a.name === an).length > 1) fail(`Duplicate attribute ${an}`);
      }
      const selfClose = s.startsWith('/>', i);
      i += selfClose ? 2 : 1;
      const { prefix, local } = splitName(name);
      const el: XElement = { type: 'element', name, prefix, local, ns: '', attrs: [], nsDecls: [], children: [] };
      for (const a of rawAttrs) {
        if (a.name === 'xmlns') el.nsDecls.push({ prefix: '', uri: a.value });
        else if (a.name.startsWith('xmlns:')) el.nsDecls.push({ prefix: a.name.slice(6), uri: a.value });
      }
      const parent = stack[stack.length - 1];
      el.parent = parent;
      const nsOf = (p: string): string | undefined => (p === 'xml' ? XML_NS : lookupNamespace(el, p));
      const ens = nsOf(prefix);
      if (ens === undefined) {
        if (prefix) fail(`Undeclared namespace prefix "${prefix}" on <${name}>`);
      } else el.ns = ens;
      for (const a of rawAttrs) {
        if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
        const sp = splitName(a.name);
        let ans = '';
        if (sp.prefix) {
          const u = nsOf(sp.prefix);
          if (u === undefined) fail(`Undeclared namespace prefix "${sp.prefix}" on attribute ${a.name}`);
          ans = u!;
        }
        el.attrs.push({ name: a.name, prefix: sp.prefix, local: sp.local, value: a.value, ns: ans });
      }
      el.parent = undefined;
      if (!parent) {
        if (root) fail('More than one root element');
        root = el;
      } else addChild(el);
      if (!parent) el.parent = undefined;
      if (!selfClose) stack.push(el);
    } else {
      const next = s.indexOf('<', i);
      const end = next < 0 ? s.length : next;
      const raw = s.slice(i, end);
      if (raw.includes(']]>')) fail('"]]>" in text');
      if (stack.length) addText(decodeEntities(raw, i));
      else if (raw.trim()) fail('Text outside the root element');
      i = end;
    }
  }
  if (stack.length) throw new XmlParseError(`Unclosed element <${stack[stack.length - 1].name}>`, i);
  if (!root) throw new XmlParseError('No root element', i);
  return { root, prolog, epilog };

  function addText(v: string) {
    const parent = stack[stack.length - 1];
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') last.value += v;
    else addChild({ type: 'text', value: v });
  }
}

/** The namespace URI a prefix maps to at an element ('' prefix: default namespace; undefined: not declared). */
export function lookupNamespace(el: XElement | undefined, prefix: string): string | undefined {
  if (prefix === 'xml') return XML_NS;
  for (let e = el; e; e = e.parent) {
    const d = e.nsDecls.find((n) => n.prefix === prefix);
    if (d) return d.uri;
  }
  return prefix === '' ? '' : undefined;
}

/** Every namespace binding in scope at an element (nearest declaration wins), '' default included when non-empty. */
export function inScopeNamespaces(el: XElement): Map<string, string> {
  const out = new Map<string, string>();
  const chain: XElement[] = [];
  for (let e: XElement | undefined = el; e; e = e.parent) chain.unshift(e);
  for (const e of chain) for (const d of e.nsDecls) out.set(d.prefix, d.uri);
  if (out.get('') === '') out.delete('');
  return out;
}

export function childElements(el: XElement, local?: string, ns?: string): XElement[] {
  return el.children.filter((c): c is XElement => c.type === 'element' && (local === undefined || c.local === local) && (ns === undefined || c.ns === ns));
}

export function firstChild(el: XElement, local: string, ns?: string): XElement | undefined {
  return childElements(el, local, ns)[0];
}

/** Depth-first search below (and including) `el`. */
export function findElements(el: XElement, pred: (e: XElement) => boolean, out: XElement[] = []): XElement[] {
  if (pred(el)) out.push(el);
  for (const c of el.children) if (c.type === 'element') findElements(c, pred, out);
  return out;
}

export function textContent(n: XNode): string {
  if (n.type === 'text') return n.value;
  if (n.type !== 'element') return '';
  return n.children.map(textContent).join('');
}

export function getAttr(el: XElement, local: string, ns = ''): string | undefined {
  return el.attrs.find((a) => a.local === local && a.ns === ns)?.value;
}

/** Set (or add) an attribute. A prefixed attribute's namespace must be declared in scope (see declareNamespace). */
export function setAttr(el: XElement, name: string, value: string, ns = ''): void {
  const { prefix, local } = splitName(name);
  const a = el.attrs.find((x) => x.local === local && x.ns === ns);
  if (a) a.value = value;
  else el.attrs.push({ name, prefix, local, value, ns });
}

/** Declare prefix -> uri on an element unless that binding is already in scope. */
export function declareNamespace(el: XElement, prefix: string, uri: string): void {
  if (lookupNamespace(el, prefix) === uri) return;
  const d = el.nsDecls.find((n) => n.prefix === prefix);
  if (d) d.uri = uri;
  else el.nsDecls.push({ prefix, uri });
}

/**
 * Parse an XML fragment (one element) in the namespace context of `context`, so prefixes declared
 * by its ancestors resolve. The result is attached to nothing; insert it with appendChild/insertChild.
 */
export function parseFragment(xml: string, context?: XElement): XElement {
  const scope = context ? inScopeNamespaces(context) : new Map<string, string>();
  const decls = [...scope.entries()].map(([p, u]) => (p ? ` xmlns:${p}="${escapeAttr(u)}"` : ` xmlns="${escapeAttr(u)}"`)).join('');
  const wrapper = parseXml(`<ezw${decls}>${xml}</ezw>`).root;
  const el = childElements(wrapper)[0];
  if (!el) throw new EzTestError('XML fragment has no element', 'XML_PARSE');
  el.parent = undefined;
  // Declarations the fragment relied on from the wrapper become its own only when needed for output later;
  // keep them resolvable by re-parenting under the context.
  return el;
}

export function appendChild(parent: XElement, child: XNode): void {
  child.parent = parent;
  parent.children.push(child);
}

export function insertChild(parent: XElement, child: XNode, index: number): void {
  child.parent = parent;
  parent.children.splice(index, 0, child);
}

export function removeNode(n: XNode): void {
  const p = n.parent;
  if (!p) return;
  p.children = p.children.filter((c) => c !== n);
  n.parent = undefined;
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}

/** Serialise a node as written (prefixes and declarations kept; empty elements as <a/>). */
export function serializeXml(n: XNode | XDocument, o: { declaration?: boolean } = {}): string {
  if ('root' in n) {
    const parts = [...n.prolog.map((x) => serializeXml(x)), serializeXml(n.root), ...n.epilog.map((x) => serializeXml(x))];
    return (o.declaration ? '<?xml version="1.0" encoding="UTF-8"?>' : '') + parts.join('');
  }
  switch (n.type) {
    case 'text': return escapeText(n.value);
    case 'comment': return `<!--${n.value}-->`;
    case 'pi': return `<?${n.target}${n.data ? ` ${n.data}` : ''}?>`;
    case 'element': {
      const decls = n.nsDecls.map((d) => (d.prefix ? ` xmlns:${d.prefix}="${escapeAttr(d.uri)}"` : ` xmlns="${escapeAttr(d.uri)}"`)).join('');
      const attrs = n.attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
      if (!n.children.length) return `<${n.name}${decls}${attrs}/>`;
      return `<${n.name}${decls}${attrs}>${n.children.map((c) => serializeXml(c)).join('')}</${n.name}>`;
    }
  }
}

/**
 * Make a detached subtree self-contained: every prefix it uses (and the default namespace when it
 * relies on one) is declared on its top element. Used before moving elements between documents.
 */
export function bindUsedNamespaces(el: XElement, context?: XElement): void {
  const scope = context ? inScopeNamespaces(context) : new Map<string, string>();
  const need = new Map<string, string>();
  const visit = (e: XElement, inherited: Map<string, string>) => {
    const here = new Map(inherited);
    for (const d of e.nsDecls) here.set(d.prefix, d.uri);
    const use = (p: string, uri: string) => {
      if (p === 'xml') return;
      if (here.get(p) !== uri && !need.has(p)) need.set(p, uri);
    };
    if (e.prefix || e.ns) use(e.prefix, e.ns);
    for (const a of e.attrs) if (a.prefix) use(a.prefix, a.ns);
    for (const c of e.children) if (c.type === 'element') visit(c, here);
  };
  visit(el, new Map(scope));
  for (const [p, u] of need) if (!el.nsDecls.some((d) => d.prefix === p)) el.nsDecls.push({ prefix: p, uri: u });
}
