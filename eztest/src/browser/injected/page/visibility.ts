/**
 * Visibility.
 *
 * - `isVisible`: what a user can see. Needs a non-empty border box, must not
 *   be `visibility: hidden | collapse`, not inside `display: none` or a
 *   `content-visibility: hidden` subtree. `display: contents` elements have
 *   no box of their own and are visible when any child is. `opacity: 0`
 *   counts as visible (the element still takes part in layout and hit tests).
 * - `isHiddenForAria`: excluded from the accessibility tree, per WAI-ARIA 1.2
 *   §7.1 / accname 1.2 "hidden": not rendered, `visibility: hidden`,
 *   `aria-hidden="true"` on it or a flat-tree ancestor, or `inert`.
 *   Zero-size elements are NOT hidden for ARIA.
 */
import { callMemo, flatChildren, flatParent, isElement, lowerTag, style } from './dom.js';

/** Inside `display:none` (self or ancestor) or a skipped `content-visibility` subtree. */
export function isNotRendered(el: Element): boolean {
  if (!el.isConnected) return true;
  const cv = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof cv === 'function') {
    // checkVisibility() with no options is false for display:none ancestors
    // and content-visibility:hidden subtrees. display:contents elements have
    // no box, so Chromium answers false for them: judge those by their style.
    if (style(el).display === 'contents') return ancestorsNotRendered(el);
    return !cv.call(el);
  }
  return ancestorsNotRendered(el) || style(el).display === 'none';
}

function ancestorsNotRendered(el: Element): boolean {
  for (let p: Element | null = el; p; p = flatParent(p)) {
    const s = style(p);
    if (s.display === 'none') return true;
    if (p !== el && s.contentVisibility === 'hidden') return true;
  }
  return false;
}

export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const tag = lowerTag(el);
  if (tag === 'option' || tag === 'optgroup') {
    const sel = el.closest('select, datalist');
    if (sel) return lowerTag(sel) === 'select' && isVisible(sel);
  }
  const s = style(el);
  if (s.display === 'contents') {
    for (const c of flatChildren(el)) {
      if (isElement(c) && isVisible(c)) return true;
      if (c.nodeType === 3 && textNodeVisible(c as Text)) return true;
    }
    return false;
  }
  if (isNotRendered(el)) return false;
  if (s.visibility !== 'visible') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function textNodeVisible(t: Text): boolean {
  if (!t.data.trim()) return false;
  const range = t.ownerDocument.createRange();
  range.selectNodeContents(t);
  const r = range.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Hidden from assistive technology (see module comment). */
export function isHiddenForAria(el: Element): boolean {
  if (!el.isConnected) return true;
  if (ariaExcluded(el)) return true;
  const tag = lowerTag(el);
  if (tag === 'option' || tag === 'optgroup') {
    const sel = el.closest('select, datalist');
    if (sel) return isHiddenForAria(sel) && lowerTag(sel) === 'select';
  }
  if (isNotRendered(el)) return true;
  const v = style(el).visibility;
  return v === 'hidden' || v === 'collapse';
}

/** aria-hidden="true" or inert on the element or a flat-tree ancestor (memoised per call). */
function ariaExcluded(el: Element): boolean {
  const memo = callMemo<Element, boolean>('ariaExcluded');
  const cached = memo?.get(el);
  if (cached !== undefined) return cached;
  let r: boolean;
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert') || (el as HTMLElement).inert) r = true;
  else {
    const p = flatParent(el);
    r = p ? ariaExcluded(p) : false;
  }
  memo?.set(el, r);
  return r;
}
