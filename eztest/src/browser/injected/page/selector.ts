/**
 * Selector chains: css, xpath, role, text, label, placeholder, altText,
 * title, testId selection steps; nth, hasText, hasNotText, visible, has,
 * hasNot filters; frame boundaries. See contract.ts for the semantics.
 *
 * Open shadow roots are pierced by every step except xpath. CSS selectors
 * are evaluated by the browser (`querySelectorAll`) inside each tree
 * separately, so a single compound/complex selector does not cross a shadow
 * boundary; chain two css steps to go through a host.
 */
import type { RegexSource, RoleStep, TextMatch } from '../contract.js';
import type { EngineChain, EngineStep, QueryResult } from '../engine-api.js';
import { accessibleNameWith } from './accname.js';
import {
  deepElements,
  forEachFlatChild,
  idrefs,
  isElement,
  lowerTag,
  normalizeWhitespace,
  deepQuery,
  sortDocumentOrder,
  withCaches,
} from './dom.js';
import { getRole, roleCandidates, withRoleCache } from './roles.js';
import { checkedState, expandedState, headingLevel, isDisabled, pressedState, selectedState } from './states.js';
import { isHiddenForAria, isVisible } from './visibility.js';
import { layoutFilter, rowAll, sectionAll, type LayoutRelation } from './layout.js';

type Root = Document | Element;

// ---------------------------------------------------------------- text --

let textCache: Map<Element, string> | null = null;

const NO_TEXT = new Set(['script', 'style', 'template', 'noscript', 'head']);

/** Raw rendered-tree text of an element (shadow DOM and slots included). */
function rawText(el: Element): string {
  const cached = textCache?.get(el);
  if (cached !== undefined) return cached;
  const tag = lowerTag(el);
  let s = '';
  if (NO_TEXT.has(tag)) s = '';
  else if (tag === 'input' && /^(button|submit|reset)$/i.test((el as HTMLInputElement).type)) s = (el as HTMLInputElement).value;
  else {
    forEachFlatChild(el, tag, (c) => {
      if (c.nodeType === 3) s += (c as Text).data;
      else if (c.nodeType === 1) s += rawText(c as Element);
    });
  }
  textCache?.set(el, s);
  return s;
}

/** Normalised text used by the text, hasText and hasNotText steps. */
export function elementText(el: Element): string {
  return normalizeWhitespace(rawText(el));
}

function withTextCache<T>(fn: () => T): T {
  if (textCache) return fn();
  textCache = new Map();
  try {
    return fn();
  } finally {
    textCache = null;
  }
}

function isRegex(m: TextMatch): m is RegexSource {
  return typeof m === 'object' && m !== null && typeof (m as RegexSource).regex === 'string';
}

/** Build a predicate for TextMatch semantics (see contract.ts). */
export function textMatcher(m: TextMatch, exact?: boolean): (value: string) => boolean {
  if (isRegex(m)) {
    let re: RegExp;
    try {
      re = new RegExp(m.regex, (m.flags || '').replace('g', ''));
    } catch (e) {
      throw new Error(`Invalid regular expression /${m.regex}/${m.flags || ''}: ${(e as Error).message}`);
    }
    return (v) => re.test(normalizeWhitespace(v));
  }
  if (typeof m !== 'string') throw new Error(`Expected a string or {regex, flags}, got ${JSON.stringify(m)}`);
  const want = normalizeWhitespace(m);
  if (exact) return (v) => v.length >= want.length && normalizeWhitespace(v) === want;
  // Case-insensitive substring of the normalised text, tested on the raw text
  // directly: each space of the needle matches a run of whitespace.
  const re = new RegExp(want.split(' ').map(escapeRegex).join('[\\s\\u00a0\\u200b]+'), 'i');
  return (v) => re.test(v);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesText(value: string, m: TextMatch, exact?: boolean): boolean {
  return textMatcher(m, exact)(value);
}

// ------------------------------------------------------------- selectors --

function cssAll(root: Root, selector: string): Element[] {
  try {
    return deepQuery(root, selector);
  } catch (e) {
    throw new Error(`Invalid CSS selector ${JSON.stringify(selector)}: ${(e as Error).message}`);
  }
}

function xpathAll(root: Root, expr: string): Element[] {
  const doc = (root as Element).ownerDocument ?? (root as Document);
  let res: XPathResult;
  try {
    res = doc.evaluate(expr, root, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
  } catch (e) {
    throw new Error(`Invalid XPath ${JSON.stringify(expr)}: ${(e as Error).message}`);
  }
  const out: Element[] = [];
  for (let i = 0; i < res.snapshotLength; i++) {
    const n = res.snapshotItem(i);
    if (isElement(n) && n !== root) out.push(n);
  }
  return out;
}

function roleAll(root: Root, step: RoleStep): Element[] {
  const want = step.role.toLowerCase() === 'image' ? 'img' : step.role.toLowerCase();
  const alt = want === 'none' ? 'presentation' : want === 'presentation' ? 'none' : want;
  const nameMatch = step.name !== undefined ? textMatcher(step.name, step.exact) : null;
  const out: Element[] = [];
  for (const el of deepQuery(root, roleCandidates(want))) {
    const r = getRole(el);
    if (r !== want && r !== alt) continue;
    const hidden = isHiddenForAria(el);
    if (hidden && !step.includeHidden) continue;
    if (step.checked !== undefined && checkedState(el) !== step.checked) continue;
    if (step.pressed !== undefined && pressedState(el) !== step.pressed) continue;
    if (step.expanded !== undefined && expandedState(el) !== step.expanded) continue;
    if (step.selected !== undefined && selectedState(el) !== step.selected) continue;
    if (step.disabled !== undefined && isDisabled(el) !== step.disabled) continue;
    if (step.level !== undefined && headingLevel(el) !== step.level) continue;
    if (nameMatch && !nameMatch(accessibleNameWith(el, hidden))) continue;
    out.push(el);
  }
  return out;
}

function textAll(root: Root, m: TextMatch, exact?: boolean): Element[] {
  const match = textMatcher(m, exact);
  const all = deepElements(root);
  // Innermost matches only: walk children before parents (reverse tree
  // order); an element with a matching descendant is dropped without
  // testing its (longer) text.
  const hits = new Set<Element>();
  const covered = new Set<Element>();
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    let hit = false;
    if (covered.has(el)) hit = true;
    else if (!NO_TEXT.has(lowerTag(el)) && match(rawText(el))) {
      hits.add(el);
      hit = true;
    }
    if (hit) {
      const p = renderedParent(el);
      if (p) covered.add(p);
    }
  }
  return all.filter((el) => hits.has(el));
}

/** Flat-tree parent whose rendered text includes this element (null for unslotted light children of a host). */
function renderedParent(el: Element): Element | null {
  if (el.assignedSlot) return el.assignedSlot;
  const p = el.parentNode;
  if (!p) return null;
  if (p.nodeType === 11) return (p as ShadowRoot).host;
  return isElement(p) && !p.shadowRoot ? p : null;
}

/** Texts that label an element: aria-label, aria-labelledby targets, native labels. */
export function labelTexts(el: Element): string[] {
  const out: string[] = [];
  const al = el.getAttribute('aria-label');
  if (al) out.push(al);
  const refs = idrefs(el, 'aria-labelledby');
  if (refs.length) out.push(refs.map((r) => rawText(r)).join(' '));
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels)) out.push(rawText(l));
  return out;
}

function labelAll(root: Root, m: TextMatch, exact?: boolean): Element[] {
  const match = textMatcher(m, exact);
  const out: Element[] = [];
  for (const el of deepElements(root)) {
    const tag = lowerTag(el);
    if (tag === 'label') continue;
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && !(el as HTMLInputElement).labels?.length) continue;
    if (labelTexts(el).some(match)) out.push(el);
  }
  return out.length ? out : visualLabelAll(root, match);
}

/** Form controls (and custom widgets that take focus) a visual label can name. */
const FIELD_CSS = [
  'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image])',
  'select', 'textarea', '[contenteditable=""]', '[contenteditable=true]',
  '[role=textbox]', '[role=combobox]', '[role=listbox]', '[role=spinbutton]', '[role=searchbox]', '[role=slider]',
  '[tabindex]:not([tabindex="-1"]):not(button):not(a):not(label)',
].join(',');

/**
 * Labels that only sit next to their field: a `<label>` with no `for` and no control inside, in the same small group as exactly one field, the way component libraries (OrangeHRM's oxd, many
 * Vue and React kits) lay out forms:
 *
 *   <div class="input-group"><div><label>Employee Id</label></div><div><input></div></div>
 *
 * Used only when no element is labelled the standard way, so real label associations always win. A group
 * that holds several fields, or several such labels, names none of them.
 */
function visualLabelAll(root: Root, match: (s: string) => boolean): Element[] {
  const out: Element[] = [];
  for (const label of cssAll(root, 'label')) {
    if ((label as HTMLLabelElement).htmlFor || (label as HTMLLabelElement).control) continue;
    if (!match(elementText(label))) continue;
    let group = label.parentElement;
    for (let depth = 0; group && depth < 5; depth++, group = group.parentElement) {
      const labels = Array.from(group.querySelectorAll('label')).filter((l) => !(l as HTMLLabelElement).htmlFor && !(l as HTMLLabelElement).control && elementText(l));
      if (labels.length > 1) break;
      const fields = Array.from(group.querySelectorAll(FIELD_CSS)).filter((f) => !f.contains(label) && !label.contains(f) && !insideAnotherField(f));
      if (fields.length === 1) {
        if (!out.includes(fields[0])) out.push(fields[0]);
        break;
      }
      if (fields.length > 1) break;
    }
  }
  return sortDocumentOrder(out);
}

/** A focusable element inside another field (a custom select's inner parts) is not a field of its own. */
function insideAnotherField(f: Element): boolean {
  const parent = f.parentElement?.closest(FIELD_CSS);
  return !!parent;
}

function attrAll(root: Root, attr: string, m: TextMatch, exact?: boolean, strict = false): Element[] {
  const match = !isRegex(m) && strict ? (v: string) => v === m : textMatcher(m, exact);
  const sel = `[${CSS.escape(attr)}]`;
  return cssAll(root, sel).filter((el) => match(el.getAttribute(attr) || ''));
}

// ------------------------------------------------------------------ chain --

function stepKind(step: EngineStep): string {
  const s = step as unknown as Record<string, unknown>;
  for (const k of ['frame', 'css', 'xpath', 'role', 'text', 'label', 'placeholder', 'altText', 'title', 'testId', 'nth', 'hasText', 'hasNotText', 'visible', 'hasNot', 'has', 'section', 'row', 'layout']) {
    if (k in s) return k;
  }
  throw new Error(`Unknown selector step ${JSON.stringify(step)}`);
}

function selectIn(root: Root, kind: string, s: Record<string, unknown>): Element[] {
  const exact = s.exact as boolean | undefined;
  switch (kind) {
    case 'css': return cssAll(root, s.css as string);
    case 'xpath': return xpathAll(root, s.xpath as string);
    case 'role': return roleAll(root, s as unknown as RoleStep);
    case 'text': return textAll(root, s.text as TextMatch, exact);
    case 'label': return labelAll(root, s.label as TextMatch, exact);
    case 'placeholder': return attrAll(root, 'placeholder', s.placeholder as TextMatch, exact);
    case 'altText': return attrAll(root, 'alt', s.altText as TextMatch, exact);
    case 'title': return attrAll(root, 'title', s.title as TextMatch, exact);
    case 'testId': return attrAll(root, (s.attr as string) || 'data-testid', s.testId as TextMatch, true, true);
    case 'section': return sectionAll(root, textMatcher(s.section as TextMatch, exact));
    case 'row': return rowAll(root, textAll(root, s.row as TextMatch, exact));
    default: throw new Error(`Unknown selection step ${kind}`);
  }
}

function run(chain: EngineChain, scope: Root): QueryResult {
  if (!Array.isArray(chain)) throw new Error('A selector chain must be an array of steps');
  let working: Root[] = [scope];
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const kind = stepKind(step);
    const s = step as unknown as Record<string, unknown>;
    if (kind === 'frame') {
      if (typeof s.frame === 'string') working = union(working, (r) => cssAll(r, s.frame as string));
      return { elements: working.filter(isElement) as Element[], frameAt: i, rest: chain.slice(i + 1) };
    }
    switch (kind) {
      case 'nth': {
        const n = Number(s.nth);
        const idx = n < 0 ? working.length + n : n;
        working = idx >= 0 && idx < working.length ? [working[idx]] : [];
        break;
      }
      case 'hasText': {
        const m = textMatcher(s.hasText as TextMatch, s.exact as boolean | undefined);
        working = working.filter((e) => isElement(e as Node) && m(rawText(e as Element)));
        break;
      }
      case 'hasNotText': {
        const m = textMatcher(s.hasNotText as TextMatch, s.exact as boolean | undefined);
        working = working.filter((e) => isElement(e as Node) && !m(rawText(e as Element)));
        break;
      }
      case 'visible':
        working = working.filter((e) => isElement(e as Node) && isVisible(e as Element) === !!s.visible);
        break;
      case 'has':
        working = working.filter((e) => run(s.has as EngineChain, e).elements.length > 0);
        break;
      case 'hasNot':
        working = working.filter((e) => run(s.hasNot as EngineChain, e).elements.length === 0);
        break;
      case 'layout': {
        const anchors = run(s.anchor as EngineChain, scope).elements;
        const rel = s.layout as LayoutRelation;
        if (!['above', 'below', 'leftOf', 'rightOf', 'near'].includes(rel)) throw new Error(`Unknown layout relation "${String(rel)}"`);
        working = layoutFilter(working.filter((e) => isElement(e as Node)) as Element[], anchors, rel, s.maxDistance as number | undefined, s.nearest !== false);
        break;
      }
      default:
        working = union(working, (r) => selectIn(r, kind, s));
    }
  }
  return { elements: working.filter((e) => isElement(e as Node)) as Element[] };
}

function union(roots: Root[], fn: (r: Root) => Element[]): Element[] {
  if (roots.length === 1) return fn(roots[0]);
  const out: Element[] = [];
  for (const r of roots) out.push(...fn(r));
  return sortDocumentOrder(out);
}

export function queryDetailed(chain: EngineChain, scope?: Element | Document): QueryResult {
  return withCaches(() => withRoleCache(() => withTextCache(() => run(chain, scope ?? document))));
}

export function query(chain: EngineChain, scope?: Element | Document): Element[] {
  return queryDetailed(chain, scope).elements;
}
