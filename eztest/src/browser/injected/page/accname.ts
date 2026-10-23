/**
 * Accessible Name and Description Computation 1.2 (accname), with the
 * HTML-AAM native text alternatives. Written from the W3C specifications.
 *
 * Step references (§4.3.2) follow accname 1.2:
 *   2A hidden · 2B aria-labelledby / aria-describedby · 2C embedded control ·
 *   2D aria-label · 2E host language (HTML-AAM) · 2F name from content
 *   (incl. CSS ::before/::after) · 2G text node · 2I tooltip (title) —
 *   then, for text fields, placeholder / aria-placeholder (HTML-AAM).
 */
import { flatChildren, idrefs, isElement, lowerTag, mayHavePseudoContent, normalizeWhitespace, style, withCaches } from './dom.js';
import { getRole, isInlineLevel, isPresentational, NAME_FROM_CONTENT, withRoleCache } from './roles.js';
import { isHiddenForAria } from './visibility.js';

interface Ctx {
  /** The element whose name/description is being computed. */
  root: Element;
  /** Computing a description (2B follows aria-describedby at the root only). */
  description: boolean;
  /** Inside an aria-labelledby / aria-describedby traversal (no further 2B). */
  inReference: boolean;
  /** The directly referenced node was hidden: include hidden content. */
  includeHidden: boolean;
  visited: Set<Node>;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', '']);

function isTextField(el: Element): boolean {
  const tag = lowerTag(el);
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  return TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type || '').toLowerCase());
}

/** Hidden state of a node met during recursion (its ancestors are already known to be visible). */
function ownHidden(el: Element): 'removed' | 'invisible' | false {
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return 'removed';
  const s = style(el);
  if (s.display === 'none') return 'removed';
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'invisible';
  return false;
}

export function accessibleName(el: Element): string {
  return accessibleNameWith(el);
}

/** `rootHidden`: the caller already knows whether `el` is hidden for ARIA. */
export function accessibleNameWith(el: Element, rootHidden?: boolean): string {
  return withCaches(() =>
    withRoleCache(() => {
      const role = getRole(el);
      if (isPresentational(role)) return '';
      const ctx: Ctx = { root: el, description: false, inReference: false, includeHidden: rootHidden ?? isHiddenForAria(el), visited: new Set() };
      return normalizeWhitespace(textAlternative(el, ctx, true));
    }),
  );
}

export function accessibleDescription(el: Element): string {
  return withCaches(() =>
    withRoleCache(() => {
      const refs = idrefs(el, 'aria-describedby');
      if (refs.length) {
        const parts = refs.map((r) =>
          textAlternative(r, { root: el, description: true, inReference: true, includeHidden: isHiddenForAria(r), visited: new Set() }, false, true),
        );
        const d = normalizeWhitespace(parts.join(' '));
        if (d) return d;
      }
      const ad = normalizeWhitespace(el.getAttribute('aria-description') || '');
      if (ad) return ad;
      const title = normalizeWhitespace(el.getAttribute('title') || '');
      if (title && title !== accessibleName(el)) return title;
      return '';
    }),
  );
}

/**
 * The text alternative of `node`.
 * @param isRoot      the node is the element whose name is computed
 * @param referenced  the node is directly referenced by aria-labelledby/-describedby or a native label
 */
function textAlternative(node: Node, ctx: Ctx, isRoot: boolean, referenced = false): string {
  if (node.nodeType === 3) return (node as Text).data; // 2G
  if (!isElement(node)) return '';
  const el = node;
  if (!isRoot && !referenced && ctx.visited.has(el)) return '';
  ctx.visited.add(el);

  // 2A: hidden nodes contribute nothing, unless the traversal started at a hidden referenced node.
  let invisible = false;
  if (!isRoot && !ctx.includeHidden) {
    const h = referenced ? (isHiddenForAria(el) ? 'removed' : false) : ownHidden(el);
    if (h === 'removed') return '';
    if (h === 'invisible') invisible = true;
  }

  const role = getRole(el);
  const recursion = !isRoot;

  // 2B: aria-labelledby (names; at most one level deep).
  if (!ctx.description && !ctx.inReference) {
    const refs = idrefs(el, 'aria-labelledby');
    if (refs.length) {
      const parts = refs.map((r) =>
        textAlternative(
          r,
          { root: ctx.root, description: false, inReference: true, includeHidden: ctx.includeHidden || isHiddenForAria(r), visited: new Set([...ctx.visited].filter((v) => v !== r)) },
          false,
          true,
        ),
      );
      const joined = parts.join(' ');
      if (normalizeWhitespace(joined)) return joined;
    }
  }

  // 2C: embedded control inside another element's label: its value.
  if (recursion && el !== ctx.root) {
    const v = embeddedControlValue(el, role, ctx);
    if (v !== null) return v;
  }

  // 2D: aria-label.
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel;

  // Presentational elements met in recursion still contribute their content.
  // 2E: host language text alternative (HTML-AAM).
  if (!isPresentational(role) || recursion) {
    const native = nativeAlternative(el, ctx);
    if (native !== null && native.trim()) return native;
  }

  // 2F: name from content.
  if (recursion || (role && NAME_FROM_CONTENT.has(role))) {
    const content = nameFromContent(el, ctx, invisible);
    if (content.trim()) return content;
  }

  // 2I: tooltip.
  const title = el.getAttribute('title');
  if (title && title.trim()) return title;
  if (isRoot && isTextField(el)) {
    const ph = el.getAttribute('placeholder') || el.getAttribute('aria-placeholder');
    if (ph && ph.trim()) return ph;
  }
  if (isRoot && lowerTag(el) !== 'input' && el.hasAttribute('aria-placeholder') && (role === 'textbox' || role === 'searchbox' || role === 'combobox')) {
    return el.getAttribute('aria-placeholder') || '';
  }
  return '';
}

const RANGE_ROLES = new Set(['slider', 'spinbutton', 'progressbar', 'scrollbar', 'meter']);

/** 2C. Value of an embedded control, or null when `el` is not one. */
function embeddedControlValue(el: Element, role: string | null, ctx: Ctx): string | null {
  const tag = lowerTag(el);
  if (role === 'textbox' || role === 'searchbox') {
    if (tag === 'input' || tag === 'textarea') return (el as HTMLInputElement).value;
    return el.textContent || '';
  }
  if (role === 'combobox' || role === 'listbox') {
    if (tag === 'select') {
      return Array.from((el as HTMLSelectElement).selectedOptions)
        .map((o) => textAlternative(o, { ...ctx, visited: new Set(ctx.visited) }, false, true))
        .join(' ');
    }
    if (tag === 'input') return (el as HTMLInputElement).value;
    const chosen = chosenOptions(el);
    if (chosen.length) return chosen.map((o) => textAlternative(o, ctx, false, true)).join(' ');
    return role === 'combobox' ? el.textContent || '' : '';
  }
  if (role && RANGE_ROLES.has(role)) {
    const vt = el.getAttribute('aria-valuetext');
    if (vt && vt.trim()) return vt;
    const vn = el.getAttribute('aria-valuenow');
    if (vn && vn.trim()) return vn;
    if (tag === 'input' || tag === 'progress' || tag === 'meter') return String((el as HTMLInputElement).value ?? '');
    return '';
  }
  return null;
}

function chosenOptions(el: Element): Element[] {
  const pool: Element[] = [el, ...idrefs(el, 'aria-controls'), ...idrefs(el, 'aria-owns')];
  const ad = idrefs(el, 'aria-activedescendant');
  if (ad.length) return ad;
  const out: Element[] = [];
  for (const p of pool) for (const o of Array.from(p.querySelectorAll('[aria-selected="true"]'))) if (!out.includes(o)) out.push(o);
  return out;
}

/** 2E. HTML-AAM native text alternatives. null = no native alternative applies. */
function nativeAlternative(el: Element, ctx: Ctx): string | null {
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
    for (const c of Array.from(el.children)) if (lowerTag(c) === 'title') return c.textContent || '';
    return null;
  }
  const tag = lowerTag(el);
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (type === 'hidden') return null;
    if (type === 'button' || type === 'submit' || type === 'reset') {
      const v = el.getAttribute('value');
      if (v !== null && v.trim()) return v;
      const lab = labelsText(el, ctx);
      if (lab.trim()) return lab;
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
      return null;
    }
    if (type === 'image') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) return alt;
      const v = el.getAttribute('value');
      if (v && v.trim()) return v;
      const t = el.getAttribute('title');
      if (t && t.trim()) return t;
      return 'Submit';
    }
    return labelsText(el, ctx);
  }
  switch (tag) {
    case 'textarea': case 'select': case 'meter': case 'progress': case 'output': case 'button':
      return labelsText(el, ctx);
    case 'img': case 'area': {
      const alt = el.getAttribute('alt');
      return alt !== null ? alt : null;
    }
    case 'fieldset': return firstChildContent(el, 'legend', ctx);
    case 'figure': return firstChildContent(el, 'figcaption', ctx);
    case 'table': return firstChildContent(el, 'caption', ctx);
    case 'optgroup': return el.getAttribute('label');
    case 'option': {
      const l = el.getAttribute('label');
      return l && l.trim() ? l : null;
    }
    default: return null;
  }
}

function labelsText(el: Element, ctx: Ctx): string {
  const labels = (el as HTMLInputElement).labels;
  if (!labels || !labels.length) return '';
  const parts: string[] = [];
  for (const label of Array.from(labels)) {
    if (ctx.visited.has(label)) continue;
    parts.push(
      textAlternative(label, { ...ctx, includeHidden: ctx.includeHidden || isHiddenForAria(label) }, false, true),
    );
  }
  return parts.join(' ');
}

function firstChildContent(el: Element, childTag: string, ctx: Ctx): string | null {
  for (const c of Array.from(el.children)) {
    if (lowerTag(c) === childTag) return textAlternative(c, ctx, false, false);
  }
  return null;
}

/** 2F. Concatenate ::before, the flat-tree children (plus aria-owns), ::after. */
function nameFromContent(el: Element, ctx: Ctx, invisible: boolean): string {
  let out = invisible ? '' : pseudoText(el, '::before');
  const kids: Node[] = flatChildren(el);
  const owned = idrefs(el, 'aria-owns').filter((o) => !kids.includes(o));
  kids.push(...owned);
  for (const c of kids) {
    if (c.nodeType === 3) {
      if (!invisible) out += (c as Text).data;
      continue;
    }
    if (!isElement(c)) continue;
    const tag = lowerTag(c);
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') continue;
    if (tag === 'br') {
      out += ' ';
      continue;
    }
    const t = textAlternative(c, ctx, false);
    // Owned elements are re-parented from elsewhere: always word-separated.
    out += isInlineLevel(c) && !owned.includes(c) ? t : ' ' + t + ' ';
  }
  if (!invisible) out += pseudoText(el, '::after');
  return out;
}

/** Text of CSS generated content (`content` strings, `attr()`, and the alt text after `/`). */
export function pseudoText(el: Element, which: '::before' | '::after'): string {
  if (!mayHavePseudoContent(el)) return '';
  let s: CSSStyleDeclaration;
  try {
    s = style(el, which);
  } catch {
    return '';
  }
  const content = s.content;
  if (!content || content === 'none' || content === 'normal' || s.display === 'none') return '';
  const text = parseContent(content, el);
  if (!text) return '';
  return s.display && s.display !== 'inline' ? ' ' + text + ' ' : text;
}

function parseContent(content: string, el: Element): string {
  // Tokenise: quoted strings, functions, idents, and the "/" alt separator.
  const tokens: string[] = [];
  let i = 0;
  let alt: string[] | null = null;
  let cur = tokens;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let str = '';
      while (j < content.length && content[j] !== ch) {
        if (content[j] === '\\' && j + 1 < content.length) {
          const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(content.slice(j + 1));
          if (hex) {
            str += String.fromCodePoint(parseInt(hex[0].trim(), 16));
            j += 1 + hex[0].length;
            continue;
          }
          str += content[j + 1];
          j += 2;
          continue;
        }
        str += content[j++];
      }
      cur.push(str);
      i = j + 1;
    } else if (ch === '/') {
      alt = [];
      cur = alt;
      i++;
    } else if (/[a-zA-Z-]/.test(ch)) {
      const m = /^[a-zA-Z-]+(\([^)]*\))?/.exec(content.slice(i)) as RegExpExecArray;
      const fn = m[0];
      const attr = /^attr\(\s*([^\s,)]+)/.exec(fn);
      if (attr) cur.push(el.getAttribute(attr[1]) || '');
      i += fn.length || 1;
    } else i++;
  }
  return (alt ?? tokens).join('');
}
