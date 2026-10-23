/**
 * Colour: text contrast (WCAG 1.4.3 / 1.4.6), form-field boundary contrast
 * (1.4.11) and links in text that differ from it only by colour (1.4.1).
 */
import { lowerTag, normalizeWhitespace, style } from '../../browser/injected/page/dom.js';
import { backgroundOf, blend, contrast, effectiveOpacity, parseColor, resetBackgroundMemo, round2, toCss, type Background, type RGBA } from './color.js';
import type { Ctx } from './context.js';
import type { RuleFn } from './rules-names.js';
import { getRole, isDisabled, isHiddenForAria, isVisible } from './util.js';

const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'template', 'title', 'option', 'optgroup', 'select', 'datalist', 'textarea', 'head']);
const FIELD_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time', '']);

interface TextSample {
  el: Element;
  ratio: number;
  fg: RGBA;
  bg: Background;
  large: boolean;
  px: number;
  weight: number;
  shadow: boolean;
  stopRatios?: number[];
  /** Ratios against backgrounds painted by positioned ::before/::after boxes that may sit behind the text. */
  pseudoRatios?: number[];
  /** The sample is the placeholder text of a field. */
  placeholder?: boolean;
}

const PLACEHOLDER_INPUTS = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', '']);

/** Backgrounds of positioned ::before/::after boxes on the element and its two nearest ancestors. */
function pseudoBackgrounds(el: Element, under: RGBA): RGBA[] {
  const out: RGBA[] = [];
  let n: Element | null = el;
  for (let depth = 0; n && depth < 3; depth++, n = n.parentElement) {
    for (const which of ['::before', '::after'] as const) {
      const ps = style(n, which);
      if (!ps.content || ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
      if (ps.position !== 'absolute' && ps.position !== 'fixed') continue;
      const bg = parseColor(ps.backgroundColor);
      if (bg && bg.a > 0.1) out.push(blend(bg, under));
      else if (ps.backgroundImage && ps.backgroundImage !== 'none') out.push(under);
    }
  }
  return out;
}

function placeholderSamples(c: Ctx): TextSample[] {
  const out: TextSample[] = [];
  for (const el of c.tags('input', 'textarea')) {
    const ph = el.getAttribute('placeholder');
    if (!ph || !ph.trim() || (el as HTMLInputElement).value) continue;
    if (lowerTag(el) === 'input' && !PLACEHOLDER_INPUTS.has(((el as HTMLInputElement).type || '').toLowerCase())) continue;
    if (!c.inScope(el) || !isVisible(el) || insideDisabled(el)) continue;
    let ps: CSSStyleDeclaration;
    try {
      ps = el.ownerDocument.defaultView!.getComputedStyle(el, '::placeholder');
    } catch {
      continue;
    }
    const raw = parseColor(ps.color);
    if (!raw || raw.a === 0) continue;
    const own = parseFloat(ps.opacity);
    const opacity = effectiveOpacity(el) * (Number.isNaN(own) ? 1 : own);
    if (opacity < 0.01) continue; // hidden placeholder (e.g. while a floating label covers it)
    const fg0 = { ...raw, a: raw.a * opacity };
    const bg = backgroundOf(el);
    const fg = blend(fg0, bg.color);
    const px = parseFloat(ps.fontSize) || parseFloat(style(el).fontSize) || 16;
    const weight = parseInt(ps.fontWeight, 10) || 400;
    out.push({ el, fg, bg, px, weight, ratio: contrast(fg, bg.color), large: px >= 24 || (weight >= 700 && px >= 18.66), shadow: false, placeholder: true });
  }
  return out;
}

const memo = new WeakMap<Ctx, TextSample[]>();

function insideDisabled(el: Element): boolean {
  if (isDisabled(el)) return true;
  if (el.closest('button:disabled, fieldset:disabled, [aria-disabled="true"], select:disabled')) return true;
  const label = el.closest('label');
  const control = label ? (label as HTMLLabelElement).control : null;
  return !!control && isDisabled(control);
}

function textRect(el: Element): DOMRect | null {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 3 || !/[\p{L}\p{N}]/u.test((n as Text).data)) continue;
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(n);
    const rects = range.getClientRects();
    for (const r of Array.from(rects)) if (r.width > 0 && r.height > 0) return r;
  }
  return null;
}

interface Overlay {
  el: Element;
  r: DOMRect;
}

/** Positioned elements that paint something: they may sit above or below text that is not their descendant. */
function overlays(c: Ctx): Overlay[] {
  const out: Overlay[] = [];
  for (const el of c.all()) {
    const s = style(el);
    if (s.position === 'static') continue;
    if (s.position === 'relative' && s.zIndex === 'auto') continue;
    const bg = parseColor(s.backgroundColor);
    const paints = (bg && bg.a > 0) || s.backgroundImage !== 'none' || /^(img|video|canvas|svg|picture|iframe)$/.test(lowerTag(el));
    if (!paints) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ el, r });
  }
  return out;
}

function samples(c: Ctx): TextSample[] {
  const cached = memo.get(c);
  if (cached) return cached;
  resetBackgroundMemo();
  const layers = overlays(c);
  const out: TextSample[] = [];
  for (const el of c.all()) {
    const tag = lowerTag(el);
    if (SKIP_TEXT.has(tag) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    let hasText = false;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && /[\p{L}\p{N}]/u.test((n as Text).data)) {
        hasText = true;
        break;
      }
    }
    if (!hasText || !c.inScope(el) || !isVisible(el) || insideDisabled(el)) continue;
    const s = style(el);
    const rect = textRect(el);
    if (!rect || rect.width <= 1 || rect.height <= 1) continue;
    const view = el.ownerDocument.defaultView!;
    if (rect.right + view.scrollX < 0 || rect.bottom + view.scrollY < 0) continue; // moved off-screen on purpose
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(s.clipPath)) continue;
    const opacity = effectiveOpacity(el);
    if (opacity < 0.01) continue;
    const raw = parseColor(s.getPropertyValue('-webkit-text-fill-color') || s.color) ?? parseColor(s.color);
    if (!raw || raw.a === 0) continue;
    const fg0 = { ...raw, a: raw.a * opacity };
    const cx = rect.left + Math.min(rect.width, 40) / 2;
    const cy = rect.top + rect.height / 2;
    const inView = cx >= 0 && cy >= 0 && cx < view.innerWidth && cy < view.innerHeight;
    // The hit-test stack is only needed when a positioned element overlaps the text (and is not its ancestor).
    const overlapped = layers.length > 400 || layers.some((o) => o.el.ownerDocument === el.ownerDocument && o.r.left < rect.right && o.r.right > rect.left && o.r.top < rect.bottom && o.r.bottom > rect.top && !o.el.contains(el));
    const bg = backgroundOf(el, inView && overlapped ? { x: cx, y: cy } : undefined);
    const fg = blend(fg0, bg.color);
    const px = parseFloat(s.fontSize) || 16;
    const weight = parseInt(s.fontWeight, 10) || (s.fontWeight === 'bold' ? 700 : 400);
    const sample: TextSample = {
      el, fg, bg, px, weight,
      ratio: contrast(fg, bg.color),
      large: px >= 24 || (weight >= 700 && px >= 18.66),
      shadow: !!s.textShadow && s.textShadow !== 'none',
    };
    if (bg.stops?.length) sample.stopRatios = bg.stops.map((st) => contrast(blend(fg0, st), st));
    const behind = pseudoBackgrounds(el, bg.color);
    if (behind.length) sample.pseudoRatios = behind.map((b) => contrast(blend(fg0, b), b));
    out.push(sample);
  }
  out.push(...placeholderSamples(c));
  memo.set(c, out);
  return out;
}

function judgeText(c: Ctx, normal: number, large: number): void {
  for (const t of samples(c)) {
    const need = t.large ? large : normal;
    const desc = `${t.placeholder ? 'placeholder text ' : ''}${toCss(t.fg)} on ${toCss(t.bg.color)}, ${round2(t.px)}px${t.weight >= 700 ? ' bold' : ''}`;
    if (t.bg.uncertain) {
      if (t.stopRatios && t.stopRatios.every((r) => r >= need)) {
        c.pass(t.el);
        continue;
      }
      const range = t.stopRatios?.length ? ` (between ${round2(Math.min(...t.stopRatios))}:1 and ${round2(Math.max(...t.stopRatios))}:1 across the gradient)` : '';
      c.review(t.el, `Contrast could not be measured exactly because ${t.bg.uncertain}${range}; ${need}:1 is required. Check the text where the background is lightest/darkest.`);
      continue;
    }
    if (t.pseudoRatios?.length) {
      const all = [t.ratio, ...t.pseudoRatios];
      if (all.every((r) => r >= need)) {
        c.pass(t.el);
        continue;
      }
      if (!all.every((r) => r < need)) {
        c.review(t.el, `A positioned ::before/::after background may sit behind this text: contrast is ${round2(t.ratio)}:1 against ${toCss(t.bg.color)} but ${t.pseudoRatios.map((r) => `${round2(r)}:1`).join(', ')} against the pseudo-element; ${need}:1 is required. Check visually.`);
        continue;
      }
    }
    if (t.ratio >= need) {
      c.pass(t.el);
      continue;
    }
    if (t.shadow) {
      c.review(t.el, `Contrast is ${round2(t.ratio)}:1 (${desc}); ${need}:1 is required, but a text shadow may provide it. Check visually.`);
      continue;
    }
    c.fail(t.el, `Contrast is ${round2(t.ratio)}:1 (${desc}); at least ${need}:1 is required${t.large ? ' for large text' : ''}.`);
  }
}

function sideColors(s: CSSStyleDeclaration): RGBA[] {
  const out: RGBA[] = [];
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const w = parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
    const st = s.getPropertyValue(`border-${side.toLowerCase()}-style`);
    if (!(w >= 1) || st === 'none' || st === 'hidden') continue;
    const col = parseColor(s.getPropertyValue(`border-${side.toLowerCase()}-color`));
    if (col && col.a > 0) out.push(col);
  }
  return out;
}

function isBlockish(el: Element): boolean {
  const d = style(el).display;
  return !/^inline/.test(d) && d !== 'contents';
}

/** Non-link text that flows in the same block as its links; text in nested blocks (a caption line under a link) is not. */
function runningText(block: Element): string {
  let out = '';
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let p = n.parentElement;
    let inLink = false;
    while (p && p !== block && !isBlockish(p)) {
      if (p.matches('a[href]')) inLink = true;
      p = p.parentElement;
    }
    if (p === block && !inLink) out += n.nodeValue ?? '';
  }
  return normalizeWhitespace(out);
}

export const CONTRAST_RULES: Record<string, RuleFn> = {
  'contrast.text'(c) {
    judgeText(c, 4.5, 3);
  },

  'contrast.text-enhanced'(c) {
    judgeText(c, 7, 4.5);
  },

  'contrast.ui-component'(c) {
    for (const el of c.tags('input', 'textarea', 'select')) {
      const tag = lowerTag(el);
      const s = style(el);
      if (tag === 'input') {
        const type = ((el as HTMLInputElement).type || '').toLowerCase();
        const custom = (type === 'checkbox' || type === 'radio') && s.appearance === 'none';
        if (!FIELD_TYPES.has(type) && !custom) continue;
      }
      if (!isVisible(el) || isHiddenForAria(el) || insideDisabled(el)) continue;
      const parent = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
      if (!parent) continue;
      const outer = backgroundOf(parent);
      if (outer.uncertain) {
        c.review(el, `The field is drawn over ${outer.uncertain.replace(/^the background is /, '')}; check that its boundary contrasts at least 3:1.`);
        continue;
      }
      const own = parseColor(s.backgroundColor);
      const fill = own && own.a > 0 ? blend(own, outer.color) : outer.color;
      const fillRatio = contrast(fill, outer.color);
      if (fillRatio >= 3) {
        c.pass(el);
        continue;
      }
      const borders = sideColors(s).map((b) => contrast(blend(b, outer.color), outer.color));
      const best = borders.length ? Math.max(...borders) : 0;
      if (best >= 3) {
        c.pass(el);
        continue;
      }
      const shadow = s.boxShadow && s.boxShadow !== 'none';
      if (!borders.length) {
        // 1.4.11 does not require a boundary; without one there is nothing to measure.
        c.review(el, `The field has no border and its fill contrasts ${round2(fillRatio)}:1 with the background${shadow ? ' (it has a box-shadow)' : ''}; check that it can be identified as a field.`);
        continue;
      }
      const msg = `The field border contrasts ${round2(best)}:1 with the background (${toCss(outer.color)}) and its fill ${round2(fillRatio)}:1; the boundary that identifies the field needs 3:1.`;
      if (shadow) c.review(el, `${msg} A box-shadow may provide the boundary; check visually.`);
      else c.fail(el, msg);
    }
  },

  'contrast.link-in-text'(c) {
    for (const a of c.byTag('a')) {
      if (!a.hasAttribute('href') || getRole(a) !== 'link' || !isVisible(a) || isHiddenForAria(a)) continue;
      const linkText = normalizeWhitespace(a.textContent || '');
      if (!/[\p{L}]/u.test(linkText)) continue;
      if (style(a).display !== 'inline') continue; // flex/grid items and inline-blocks are not part of running text
      let block: Element | null = a.parentElement;
      while (block && !isBlockish(block)) block = block.parentElement;
      if (!block) continue;
      if (runningText(block).length < 15) continue; // not running text
      const ls = style(a);
      const bs = style(block);
      const decorated = (el: Element) => {
        const st = style(el);
        return /underline|overline|line-through/.test(st.textDecorationLine) || (parseFloat(st.borderBottomWidth) >= 1 && st.borderBottomStyle !== 'none');
      };
      const kids = Array.from(a.querySelectorAll('*')).slice(0, 5);
      if (decorated(a) || kids.some(decorated)) {
        c.pass(a);
        continue;
      }
      const lw = parseInt(ls.fontWeight, 10) || 400;
      const bw = parseInt(bs.fontWeight, 10) || 400;
      if (Math.abs(lw - bw) >= 300 || ls.fontStyle !== bs.fontStyle) {
        c.pass(a);
        continue;
      }
      const lbg = parseColor(ls.backgroundColor);
      if (lbg && lbg.a > 0.2) {
        c.pass(a);
        continue;
      }
      const bg = backgroundOf(block).color;
      const lc = parseColor(ls.color);
      const tc = parseColor(bs.color);
      if (!lc || !tc) continue;
      const r = contrast(blend(lc, bg), blend(tc, bg));
      if (r >= 3) c.pass(a);
      else c.fail(a, `The link differs from the surrounding text only by colour (${toCss(lc)} vs ${toCss(tc)}, ${round2(r)}:1). Underline it or raise the difference to 3:1.`);
    }
  },
};
