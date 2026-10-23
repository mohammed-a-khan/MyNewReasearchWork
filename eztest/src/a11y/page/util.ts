/**
 * Helpers shared by the accessibility rules: tab-stop tests, the
 * accessibility parent and owned children (WAI-ARIA 1.2 §8.1, with
 * aria-owns), raw role tokens, visible own text.
 */
import { flatChildren, flatParent, getByIdInTree, isElement, lowerTag, normalizeWhitespace, style } from '../../browser/injected/page/dom.js';
import { getRole, isFocusable, isPresentational } from '../../browser/injected/page/roles.js';
import { isDisabled } from '../../browser/injected/page/states.js';
import { isHiddenForAria, isVisible } from '../../browser/injected/page/visibility.js';

export { isVisible, isHiddenForAria, isDisabled, getRole, isFocusable };

/** Inert (the attribute on the element or an ancestor, or the browser's inert flag). */
export function isInert(el: Element): boolean {
  if ((el as HTMLElement).inert) return true;
  for (let p: Element | null = el; p; p = flatParent(p)) if (p.hasAttribute('inert')) return true;
  return false;
}

/** Reachable with Tab: focusable, tabindex not negative, enabled, not inert, rendered. */
export function isTabbable(el: Element): boolean {
  if (!isFocusable(el)) return false;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && parseInt(ti, 10) < 0) return false;
  if ((el as HTMLElement).tabIndex < 0 && ti === null) return false;
  const tag = lowerTag(el);
  if (/^(button|input|select|textarea)$/.test(tag) && (el as HTMLButtonElement).disabled) return false;
  if (isInert(el)) return false;
  return isVisible(el) || style(el).display === 'contents';
}

/** Raw tokens of the role attribute, lower-cased. */
export function roleTokens(el: Element): string[] {
  const v = el.getAttribute('role');
  return v ? v.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];
}

/** Names of the aria-* attributes on an element. */
export function ariaAttrNames(el: Element): string[] {
  const out: string[] = [];
  for (const a of Array.from(el.attributes)) if (a.name.startsWith('aria-')) out.push(a.name);
  return out;
}

/** Roles that pass their children through in the accessibility tree (no semantics of their own). */
function passThrough(el: Element): boolean {
  const r = getRole(el);
  return r === null || r === 'generic' || isPresentational(r);
}

/** The element that owns `el` with aria-owns, if any (memoised per document). */
const ownerMemo = new WeakMap<Document, Map<Element, Element>>();
export function ariaOwner(el: Element): Element | null {
  const doc = el.ownerDocument;
  let m = ownerMemo.get(doc);
  if (!m) {
    m = new Map();
    for (const o of Array.from(doc.querySelectorAll('[aria-owns]'))) {
      for (const id of (o.getAttribute('aria-owns') || '').split(/\s+/)) {
        const t = id && getByIdInTree(o, id);
        if (t && !m.has(t)) m.set(t, o);
      }
    }
    ownerMemo.set(doc, m);
  }
  return m.get(el) ?? null;
}

/** Forget memoised aria-owns maps (between runs, the DOM may have changed). */
export function resetOwnerMemo(doc: Document): void {
  ownerMemo.delete(doc);
}

/** Nearest ancestor (or aria-owns owner) with a role that is not generic/none/presentation. */
export function accessibilityParent(el: Element): Element | null {
  let cur: Element | null = el;
  while (cur) {
    const owner = ariaOwner(cur);
    const p: Element | null = owner ?? flatParent(cur);
    if (!p) return null;
    if (!passThrough(p)) return p;
    cur = p;
  }
  return null;
}

/** Owned elements: flat children (through generic/none containers) plus aria-owns, skipping hidden ones. */
export function ownedElements(el: Element): Element[] {
  const out: Element[] = [];
  const visit = (n: Element) => {
    for (const c of flatChildren(n)) {
      if (!isElement(c)) continue;
      if (isHiddenForAria(c)) continue;
      if (ariaOwner(c) && ariaOwner(c) !== el) continue;
      if (passThrough(c) && lowerTag(c) !== 'img' && !isFocusable(c)) visit(c);
      else out.push(c);
    }
  };
  visit(el);
  for (const id of (el.getAttribute('aria-owns') || '').split(/\s+/)) {
    const t = id && getByIdInTree(el, id);
    if (t && !out.includes(t) && !isHiddenForAria(t)) out.push(t);
  }
  return out;
}

/** Text of the element's own text-node children (not descendants), whitespace-normalised. */
export function ownText(el: Element): string {
  let s = '';
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) s += (c as Text).data;
  return normalizeWhitespace(s);
}

/** Visible text inside the element (layout-aware innerText for HTML elements). */
export function visibleText(el: Element): string {
  const t = (el as HTMLElement).innerText;
  return normalizeWhitespace(typeof t === 'string' ? t : el.textContent || '');
}

/** "a button", "a link" — for messages. */
export function describeRole(role: string | null): string {
  if (!role) return 'the element';
  return /^[aeiou]/.test(role) ? `an ${role}` : `a ${role}`;
}

export function quote(s: string, n = 60): string {
  const t = s.length > n ? s.slice(0, n - 1) + '…' : s;
  return `"${t}"`;
}
