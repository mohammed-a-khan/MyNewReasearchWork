/**
 * Page source (the native "DOM"): the EZTest agents serve the UI hierarchy as
 * XML. Android (agents/android): tags are class names (`android.widget.Button`)
 * with `resource-id`, `text`, `content-desc`, `hint`, `checked`, `clickable`,
 * `displayed` and `bounds="[x1,y1][x2,y2]"`. iOS (agents/ios): tags are
 * `XCUIElementType*` with `name`, `label`, `value`, `enabled`, `visible` and
 * `x/y/width/height`. This module parses it into a node tree with normalised
 * bounds, names and kinds, so EZTest can fingerprint elements, heal, check
 * screen text and draw element boxes over screenshots without a device
 * round-trip per node.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ElementFingerprint, LocatorCandidate } from '../core/index.js';
import type { Rect } from './session.js';

export type NativePlatform = 'android' | 'ios' | (string & {});

export interface NativeNode {
  tag: string;
  attrs: Record<string, string>;
  children: NativeNode[];
  parent?: NativeNode;
  /** Document order. */
  index: number;
  /** Absolute XPath with positions, e.g. /hierarchy/android.widget.FrameLayout[1]/android.widget.Button[2]. */
  xpath: string;
  bounds?: Rect;
  /** Concatenated text children (HTML/web views). */
  innerText?: string;
}

export interface PageSource {
  root?: NativeNode;
  /** Every element node in document order. */
  nodes: NativeNode[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  allowBooleanAttributes: true,
});

type Ordered = Record<string, unknown> & { ':@'?: Record<string, string> };

/** Parse a page source XML. Unparseable sources yield an empty tree (never throws). */
export function parseSource(xml: string): PageSource {
  const nodes: NativeNode[] = [];
  let parsed: Ordered[];
  try {
    parsed = parser.parse(xml) as Ordered[];
  } catch {
    return { nodes };
  }
  const build = (items: Ordered[], parent: NativeNode | undefined, parentPath: string): NativeNode[] => {
    const out: NativeNode[] = [];
    const seen = new Map<string, number>();
    for (const item of items) {
      const tag = Object.keys(item).find((k) => k !== ':@' && k !== '#text' && !k.startsWith('?'));
      if (!tag) continue;
      const pos = (seen.get(tag) ?? 0) + 1;
      seen.set(tag, pos);
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(item[':@'] ?? {})) attrs[k] = String(v);
      const node: NativeNode = { tag, attrs, children: [], parent, index: nodes.length, xpath: `${parentPath}/${tag}[${pos}]` };
      node.bounds = boundsOf(attrs);
      nodes.push(node);
      const kids = (item[tag] as Ordered[] | undefined) ?? [];
      node.children = build(kids, node, node.xpath);
      const text = kids.filter((k) => typeof k['#text'] === 'string').map((k) => String(k['#text'])).join(' ').trim();
      if (text) node.innerText = text;
      out.push(node);
    }
    return out;
  };
  const top = build(parsed, undefined, '');
  return { root: top[0], nodes };
}

/** Bounds from Android `bounds`, iOS `x/y/width/height` or `left/top/width/height` attributes. */
export function boundsOf(a: Record<string, string>): Rect | undefined {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(a.bounds ?? '');
  if (m) {
    const [x1, y1, x2, y2] = m.slice(1).map(Number);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }
  const x = num(a.x ?? a.left);
  const y = num(a.y ?? a.top);
  const w = num(a.width);
  const h = num(a.height);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return { x, y, width: w, height: h };
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Short resource id: "com.shop:id/login" -> "login". */
export function shortId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const i = id.indexOf(':id/');
  return i >= 0 ? id.slice(i + 4) : id;
}

/** The node's resource id (Android) or id attribute. */
export function idOf(n: NativeNode): string | undefined {
  return n.attrs['resource-id'] || n.attrs.id || undefined;
}

/** Accessible name: Android content-desc, iOS name/label, web aria-label. */
export function nameOf(n: NativeNode): string | undefined {
  return n.attrs['content-desc'] || n.attrs.label || n.attrs['aria-label'] || n.attrs.name || undefined;
}

/** Visible text of a node: text, value, label, or inner text. */
export function textOf(n: NativeNode): string | undefined {
  const t = n.attrs.text ?? n.attrs.value ?? n.attrs.label ?? n.innerText;
  return t === undefined || t === '' ? undefined : t;
}

/** Hint / placeholder text of an input. */
export function hintOf(n: NativeNode): string | undefined {
  return n.attrs.hint || n.attrs.placeholderValue || n.attrs.placeholder || undefined;
}

/** False when the node says it is not displayed or has an empty box. */
export function isNodeVisible(n: NativeNode): boolean {
  const a = n.attrs;
  if (a.displayed === 'false' || a.visible === 'false') return false;
  if (n.bounds && (n.bounds.width <= 0 || n.bounds.height <= 0)) return false;
  return true;
}

/** Kinds of native elements, aligned with the target description kinds (button, textbox, ...). */
export type NativeKind = 'button' | 'textbox' | 'checkbox' | 'switch' | 'img' | 'link' | 'text' | 'list' | 'generic';

/** Tag fragments per kind; they match Android class names, iOS XCUIElementType names and HTML tags. */
export const KIND_TAGS: Record<Exclude<NativeKind, 'generic'>, string[]> = {
  button: ['Button'],
  textbox: ['EditText', 'TextField', 'SecureTextField', 'SearchField', 'TextView', 'InputField', 'input', 'textarea'],
  checkbox: ['CheckBox', 'Checkbox', 'CheckedTextView'],
  switch: ['Switch', 'Toggle'],
  img: ['Image', 'img'],
  link: ['Link', 'a'],
  text: ['StaticText', 'TextView', 'Text', 'Label'],
  list: ['ListView', 'RecyclerView', 'Table', 'CollectionView', 'List', 'ScrollView'],
};

/** The kind of a node from its tag and attributes. */
export function kindOf(n: NativeNode): NativeKind {
  const tag = n.tag;
  const has = (frags: string[]) => frags.some((f) => (f.length <= 3 ? tag === f : tag.includes(f)));
  if (n.attrs.password === 'true' || has(KIND_TAGS.textbox.filter((t) => t !== 'TextView'))) return 'textbox';
  if (has(KIND_TAGS.switch)) return 'switch';
  if (has(KIND_TAGS.checkbox) || n.attrs.checkable === 'true') return 'checkbox';
  if (has(KIND_TAGS.button) || tag === 'button') return 'button';
  if (has(KIND_TAGS.img)) return 'img';
  if (has(KIND_TAGS.link)) return 'link';
  if (has(KIND_TAGS.list)) return 'list';
  if (has(KIND_TAGS.text)) return 'text';
  if (n.attrs.clickable === 'true') return 'button';
  return 'generic';
}

/** ARIA-like role of a native kind (fingerprints share the web vocabulary). */
const KIND_ROLE: Record<NativeKind, string | undefined> = {
  button: 'button', textbox: 'textbox', checkbox: 'checkbox', switch: 'switch', img: 'img', link: 'link', text: undefined, list: 'list', generic: undefined,
};

/** Element fingerprint of a native node (the T1 healing input). */
export function fingerprintOf(n: NativeNode): ElementFingerprint {
  const fp: ElementFingerprint = { tag: n.tag };
  const role = KIND_ROLE[kindOf(n)];
  if (role) fp.role = role;
  const name = nameOf(n);
  if (name) fp.name = name;
  const text = textOf(n);
  if (text && n.attrs.password !== 'true') fp.text = text.slice(0, 200);
  const id = shortId(idOf(n));
  if (id) fp.id = id;
  const hint = hintOf(n);
  if (hint) fp.placeholder = hint;
  if (n.attrs.label && n.attrs.label !== name) fp.label = n.attrs.label;
  const attributes: Record<string, string> = {};
  for (const k of ['class', 'type', 'package', 'clickable', 'checkable', 'scrollable', 'password']) if (n.attrs[k] !== undefined) attributes[k] = n.attrs[k];
  if (Object.keys(attributes).length) fp.attributes = attributes;
  const chain: string[] = [];
  for (let p: NativeNode | undefined = n; p && chain.length < 5; p = p.parent) chain.unshift(shortTag(p.tag) + (idOf(p) ? `#${shortId(idOf(p))}` : ''));
  fp.path = chain.join(' > ');
  if (n.bounds) fp.box = { ...n.bounds };
  return fp;
}

function shortTag(tag: string): string {
  return tag.replace(/^android\.(?:widget|view)\./, '').replace(/^XCUIElementType/, '');
}

/** All visible text on the screen (texts, names, values), for "the screen contains" checks. */
export function screenText(src: PageSource): string {
  const parts: string[] = [];
  for (const n of src.nodes) {
    if (!isNodeVisible(n)) continue;
    for (const v of [n.attrs.text, n.attrs['content-desc'], n.attrs.label, n.attrs.value, n.attrs.name, n.innerText]) {
      if (v && !parts.includes(v)) parts.push(v);
    }
  }
  return parts.join('\n');
}

/** Nodes whose bounds equal a rect (how a found element is matched back to the source). */
export function nodesAt(src: PageSource, r: Rect): NativeNode[] {
  return src.nodes.filter((n) => n.bounds && n.bounds.x === r.x && n.bounds.y === r.y && n.bounds.width === r.width && n.bounds.height === r.height);
}

/** An XPath string literal (concat() when the value holds both quote kinds). */
export function xpathLiteral(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `concat(${s.split('"').map((p) => `"${p}"`).join(`, '"', `)})`;
}

/**
 * Locator candidates that identify exactly this node in the source (checked
 * locally), most robust first: resource id, accessibility id, text/name XPath,
 * then the absolute XPath. The caller still confirms each with the device.
 */
export function robustNativeCandidates(n: NativeNode, src: PageSource, platform: NativePlatform): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const unique = (pred: (m: NativeNode) => boolean) => src.nodes.filter(pred).length === 1;
  const id = idOf(n);
  if (id && unique((m) => idOf(m) === id)) out.push({ strategy: 'id', value: id });
  const aid = platform === 'android' ? n.attrs['content-desc'] : platform === 'ios' ? n.attrs.name : undefined;
  if (aid && unique((m) => (platform === 'android' ? m.attrs['content-desc'] : m.attrs.name) === aid)) out.push({ strategy: 'accessibilityId', value: aid });
  for (const attr of ['text', 'content-desc', 'label', 'name']) {
    const v = n.attrs[attr];
    if (!v || v.length > 80) continue;
    if (unique((m) => m.tag === n.tag && m.attrs[attr] === v)) {
      out.push({ strategy: 'xpath', value: `//${n.tag}[@${attr}=${xpathLiteral(v)}]` });
      break;
    }
  }
  out.push({ strategy: 'xpath', value: n.xpath });
  return out;
}
