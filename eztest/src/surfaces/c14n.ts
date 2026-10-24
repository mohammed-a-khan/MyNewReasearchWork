/**
 * XML canonicalization, written from the W3C specifications:
 *  - Exclusive XML Canonicalization 1.0 (http://www.w3.org/2001/10/xml-exc-c14n#),
 *    with and without comments, with an InclusiveNamespaces PrefixList;
 *  - Canonical XML 1.0 (http://www.w3.org/TR/2001/REC-xml-c14n-20010315),
 *    with and without comments.
 * Input is a whole document or an element subtree (a document subset that
 * keeps its ancestors' namespace context), optionally with an excluded
 * subtree (the enveloped-signature transform).
 */
import { escapeAttr, escapeText, XML_NS, type XDocument, type XElement, type XNode } from './xml-dom.js';

export const C14N_EXC = 'http://www.w3.org/2001/10/xml-exc-c14n#';
export const C14N_EXC_COMMENTS = 'http://www.w3.org/2001/10/xml-exc-c14n#WithComments';
export const C14N_10 = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
export const C14N_10_COMMENTS = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315#WithComments';

export interface C14nOptions {
  /** Exclusive (default) or inclusive Canonical XML 1.0. */
  exclusive?: boolean;
  withComments?: boolean;
  /** Exclusive only: prefixes treated the inclusive way ("#default" for the default namespace). */
  inclusivePrefixes?: string[];
  /** Nodes left out of the output (with their subtrees): the enveloped-signature transform. */
  exclude?: (n: XNode) => boolean;
}

/** Options for a canonicalization algorithm URI. */
export function c14nOptionsFor(algorithm: string, inclusivePrefixes?: string[]): C14nOptions {
  switch (algorithm) {
    case C14N_EXC: return { exclusive: true, inclusivePrefixes };
    case C14N_EXC_COMMENTS: return { exclusive: true, withComments: true, inclusivePrefixes };
    case C14N_10: return { exclusive: false };
    case C14N_10_COMMENTS: return { exclusive: false, withComments: true };
    default: throw new Error(`Unsupported canonicalization algorithm ${algorithm}`);
  }
}

/** Namespace bindings in scope at `el` from its ancestors and itself (nearest wins; '' = default, '' URI = undeclared). */
function scopeOf(el: XElement): Map<string, string> {
  const chain: XElement[] = [];
  for (let e: XElement | undefined = el; e; e = e.parent) chain.unshift(e);
  const m = new Map<string, string>();
  for (const e of chain) for (const d of e.nsDecls) m.set(d.prefix, d.uri);
  return m;
}

function sortNs(a: [string, string], b: [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function renderNs(prefix: string, uri: string): string {
  return prefix ? ` xmlns:${prefix}="${escapeAttr(uri)}"` : ` xmlns="${escapeAttr(uri)}"`;
}

function cmpAttr(a: { ns: string; local: string }, b: { ns: string; local: string }): number {
  if (a.ns !== b.ns) return a.ns < b.ns ? -1 : 1;
  return a.local < b.local ? -1 : a.local > b.local ? 1 : 0;
}

function renderPi(target: string, data: string): string {
  return `<?${target}${data ? ` ${data}` : ''}?>`;
}

/** Canonicalize an element subtree (in its document context) or a whole document. */
export function canonicalize(node: XElement | XDocument, o: C14nOptions = {}): string {
  const exclusive = o.exclusive ?? true;
  const comments = o.withComments ?? false;
  const inclusive = new Set((o.inclusivePrefixes ?? []).map((p) => (p === '#default' ? '' : p)));
  const out: string[] = [];

  const element = (el: XElement, rendered: Map<string, string>, apex: boolean) => {
    if (o.exclude?.(el)) return;
    const scope = scopeOf(el);
    const next = new Map(rendered);
    const nsOut: Array<[string, string]> = [];
    if (exclusive) {
      // Visibly utilised prefixes (element and attributes), plus the InclusiveNamespaces prefixes in scope.
      const used = new Set<string>([el.prefix]);
      for (const a of el.attrs) if (a.prefix && a.prefix !== 'xml') used.add(a.prefix);
      for (const p of inclusive) if (scope.has(p)) used.add(p);
      for (const p of used) {
        const uri = scope.get(p) ?? '';
        if (p === '') {
          // Default namespace: render when it differs from the nearest rendered one ("" undeclares).
          const prev = rendered.get('') ?? '';
          if (uri !== prev) {
            nsOut.push(['', uri]);
            next.set('', uri);
          }
          continue;
        }
        if (rendered.get(p) !== uri) {
          nsOut.push([p, uri]);
          next.set(p, uri);
        }
      }
    } else {
      // Inclusive: every in-scope binding not already rendered with the same value by an output ancestor.
      for (const [p, uri] of scope) {
        if (p === 'xml') continue;
        if (p === '') {
          const prev = rendered.get('') ?? '';
          if (uri !== prev) {
            nsOut.push(['', uri]);
            next.set('', uri);
          }
          continue;
        }
        if (rendered.get(p) !== uri) {
          nsOut.push([p, uri]);
          next.set(p, uri);
        }
      }
    }
    nsOut.sort(sortNs);
    const attrs = [...el.attrs];
    if (!exclusive && apex) {
      // Inclusive c14n of a subset: xml:* attributes are inherited from ancestors outside the subset.
      for (let a = el.parent; a; a = a.parent) {
        for (const at of a.attrs) if (at.ns === XML_NS && !attrs.some((x) => x.ns === XML_NS && x.local === at.local)) attrs.push(at);
      }
    }
    attrs.sort(cmpAttr);
    out.push(`<${el.name}${nsOut.map(([p, u]) => renderNs(p, u)).join('')}${attrs.map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join('')}>`);
    for (const c of el.children) child(c, next);
    out.push(`</${el.name}>`);
  };

  const child = (c: XNode, rendered: Map<string, string>) => {
    if (o.exclude?.(c)) return;
    if (c.type === 'element') element(c, rendered, false);
    else if (c.type === 'text') out.push(escapeText(c.value));
    else if (c.type === 'comment') {
      if (comments) out.push(`<!--${c.value}-->`);
    } else out.push(renderPi(c.target, c.data));
  };

  if ('root' in node) {
    const before = node.prolog.filter((n) => comments || n.type !== 'comment');
    const after = node.epilog.filter((n) => comments || n.type !== 'comment');
    for (const n of before) {
      out.push(n.type === 'pi' ? renderPi(n.target, n.data) : `<!--${n.value}-->`);
      out.push('\n');
    }
    element(node.root, new Map(), true);
    for (const n of after) {
      out.push('\n');
      out.push(n.type === 'pi' ? renderPi(n.target, n.data) : `<!--${n.value}-->`);
    }
    return out.join('');
  }
  element(node, new Map(), true);
  return out.join('');
}
