/**
 * Tables and lists (1.3.1), static keyboard and focus checks (2.1.1,
 * 2.4.3), target size (2.5.8 / 2.5.5), zoom (1.4.4), timing (2.2.1),
 * autocomplete (1.3.5), frames, media (1.2.x, 1.4.2), blinking and moving
 * content (2.2.2) and orientation locks (1.3.4).
 */
import { accessibleName } from '../../browser/injected/page/accname.js';
import { deepElements, getByIdInTree, lowerTag, normalizeWhitespace, style } from '../../browser/injected/page/dom.js';
import type { PageBox } from '../protocol.js';
import type { Ctx } from './context.js';
import type { RuleFn } from './rules-names.js';
import { getRole, isDisabled, isHiddenForAria, isTabbable, isVisible, quote } from './util.js';

// ------------------------------------------------------------------ helpers

function ownRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.rows ?? []).filter((r) => r.closest('table') === table);
}

function isDataTable(table: Element): boolean {
  if (getRole(table) !== 'table' || isHiddenForAria(table) || !isVisible(table)) return false;
  const rows = ownRows(table as HTMLTableElement);
  if (rows.length < 2) return false;
  if (Math.max(...rows.map((r) => r.cells.length)) < 2) return false;
  if (table.querySelector('table')) return false;
  return true;
}

function hasHeaderCells(table: Element): boolean {
  for (const r of ownRows(table as HTMLTableElement)) {
    for (const cell of Array.from(r.cells)) {
      const role = getRole(cell);
      if (role === 'columnheader' || role === 'rowheader') return true;
    }
  }
  return false;
}

const INTERACTIVE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'combobox', 'treeitem', 'searchbox', 'textbox', 'listbox']);

/** A link inside a sentence: its size is set by the line height of the text (2.5.8 "inline" exception). */
function inlineInText(el: Element): boolean {
  if (!/^inline/.test(style(el).display) || style(el).display === 'inline-block' || style(el).display === 'inline-flex') return false;
  let block = el.parentElement;
  while (block && /^inline/.test(style(block).display)) block = block.parentElement;
  if (!block) return false;
  const all = normalizeWhitespace(block.textContent || '');
  const own = normalizeWhitespace(el.textContent || '');
  return all.length - own.length >= 10;
}

function userAgentSized(el: Element): boolean {
  if (lowerTag(el) !== 'input') return false;
  const type = ((el as HTMLInputElement).type || '').toLowerCase();
  return (type === 'checkbox' || type === 'radio') && style(el).appearance !== 'none';
}

interface Target {
  el: Element;
  box: PageBox;
  small: boolean;
}

const targetMemo = new WeakMap<Ctx, Target[]>();

function targets(c: Ctx): Target[] {
  const cached = targetMemo.get(c);
  if (cached) return cached;
  const out: Target[] = [];
  for (const el of c.all()) {
    const r = getRole(el);
    // A pointer target accepts pointer actions: controls by role, or focusable elements that look clickable.
    // A focusable scroll region (tabindex on a <pre>, a list) is for the keyboard, not a target.
    const interactive = (r && INTERACTIVE.has(r)) || (isTabbable(el) && (style(el).cursor === 'pointer' || el.hasAttribute('onclick')));
    if (!interactive) continue;
    const tag = lowerTag(el);
    if (tag === 'option' && el.closest('select, datalist')) continue;
    if (tag === 'html' || tag === 'body' || tag === 'iframe') continue;
    if (isHiddenForAria(el) || !isVisible(el) || isDisabled(el) || style(el).pointerEvents === 'none') continue;
    const box = c.box(el);
    if (!box || box.width <= 1 || box.height <= 1) continue;
    const s = style(el);
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(s.clipPath)) continue;
    // A target wholly inside another target of the same action (e.g. an icon in a button) is not separate.
    if (el.parentElement?.closest('button, a[href], [role="button"], [role="link"], label') && !isTabbable(el)) continue;
    out.push({ el, box, small: box.width < 24 || box.height < 24 });
  }
  targetMemo.set(c, out);
  return out;
}

/** "<button> "Save"" — a cheap description for messages (no selector computation). */
function short(el: Element): string {
  const t = normalizeWhitespace(el.textContent || el.getAttribute('aria-label') || '');
  return `<${lowerTag(el)}>${t ? ` "${t.length > 30 ? t.slice(0, 29) + '…' : t}"` : ''}`;
}

function distToRect(x: number, y: number, b: PageBox): number {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.width));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

const AUTOFILL_FIELDS = new Set(
  ('name honorific-prefix given-name additional-name family-name honorific-suffix nickname username new-password current-password one-time-code ' +
    'organization-title organization street-address address-line1 address-line2 address-line3 address-level4 address-level3 address-level2 ' +
    'address-level1 country country-name postal-code cc-name cc-given-name cc-additional-name cc-family-name cc-number cc-exp cc-exp-month ' +
    'cc-exp-year cc-csc cc-type transaction-currency transaction-amount language bday bday-day bday-month bday-year sex url photo').split(' '),
);
const CONTACT_FIELDS = new Set('tel tel-country-code tel-national tel-area-code tel-local tel-local-prefix tel-local-suffix tel-extension email impp'.split(' '));
const CONTACT_KINDS = new Set(['home', 'work', 'mobile', 'fax', 'pager']);
const NO_AUTOFILL_TYPES = new Set(['checkbox', 'radio', 'file', 'submit', 'reset', 'button', 'image', 'range', 'color']);

/** Why an autocomplete value is not a valid HTML autofill detail token list, or null. */
export function autocompleteProblem(value: string): string | null {
  const t = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!t.length) return null;
  if (t.length === 1 && (t[0] === 'on' || t[0] === 'off')) return null;
  let i = 0;
  if (t[i]?.startsWith('section-')) i++;
  if (t[i] === 'shipping' || t[i] === 'billing') i++;
  if (CONTACT_KINDS.has(t[i])) {
    i++;
    if (!CONTACT_FIELDS.has(t[i])) return t[i] ? `"${t[i - 1]}" must be followed by a phone, email or impp field, not "${t[i]}"` : `"${t[i - 1]}" must be followed by a contact field such as "tel" or "email"`;
    i++;
  } else if (AUTOFILL_FIELDS.has(t[i]) || CONTACT_FIELDS.has(t[i])) i++;
  else return t[i] ? `"${t[i]}" is not an autofill field name` : 'no autofill field name is given';
  if (t[i] === 'webauthn') i++;
  if (i < t.length) return `unexpected token "${t[i]}"`;
  return null;
}

function rotates(transform: string): boolean {
  const v = transform.replace(/\s+/g, '').toLowerCase();
  const m = /rotate(?:z)?\((-?[\d.]+)(deg|turn|rad|grad)\)/.exec(v);
  if (m) {
    const n = parseFloat(m[1]);
    const deg = m[2] === 'deg' ? n : m[2] === 'turn' ? n * 360 : m[2] === 'rad' ? (n * 180) / Math.PI : n * 0.9;
    const a = ((Math.abs(deg) % 180) + 180) % 180;
    return Math.abs(a - 90) < 1;
  }
  const mm = /matrix\((-?[\d.e-]+),(-?[\d.e-]+),(-?[\d.e-]+),(-?[\d.e-]+)/.exec(v);
  return !!mm && Math.abs(parseFloat(mm[1])) < 0.01 && Math.abs(Math.abs(parseFloat(mm[2])) - 1) < 0.01;
}

function* allRules(list: CSSRuleList | undefined, media: string[] = []): Generator<{ rule: CSSStyleRule; media: string[] }> {
  if (!list) return;
  for (const r of Array.from(list)) {
    if ((r as CSSMediaRule).media && (r as CSSMediaRule).cssRules) {
      yield* allRules((r as CSSMediaRule).cssRules, [...media, (r as CSSMediaRule).conditionText ?? (r as CSSMediaRule).media.mediaText]);
    } else if ((r as CSSGroupingRule).cssRules && !(r as CSSStyleRule).selectorText) {
      yield* allRules((r as CSSGroupingRule).cssRules, media);
    } else if ((r as CSSStyleRule).selectorText) {
      yield { rule: r as CSSStyleRule, media };
      if ((r as CSSGroupingRule).cssRules?.length) yield* allRules((r as CSSGroupingRule).cssRules, media);
    }
  }
}

function sheetsOf(doc: Document): CSSStyleSheet[] {
  const out: CSSStyleSheet[] = [];
  for (const s of Array.from(doc.styleSheets)) out.push(s as CSSStyleSheet);
  for (const s of (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? []) out.push(s);
  return out;
}

// ------------------------------------------------------------------ rules

export const MISC_RULES: Record<string, RuleFn> = {
  'table.headers-attr'(c) {
    for (const cell of c.tags('td', 'th')) {
      const v = (cell.getAttribute('headers') || '').trim();
      if (!v) continue;
      const table = cell.closest('table');
      const bad: string[] = [];
      for (const id of v.split(/\s+/)) {
        const t = getByIdInTree(cell, id);
        if (!t) bad.push(`"${id}" does not exist`);
        else if (t === cell) bad.push(`"${id}" is the cell itself`);
        else if (t.closest('table') !== table) bad.push(`"${id}" is in another table`);
        else if (lowerTag(t) !== 'th' && !/^(columnheader|rowheader)$/.test(getRole(t) || '')) bad.push(`"${id}" is not a header cell`);
      }
      if (bad.length) c.fail(cell, `headers="${v}": ${bad.join('; ')}.`);
      else c.pass(cell);
    }
  },

  'table.scope'(c) {
    for (const el of c.all()) {
      const v = el.getAttribute('scope');
      if (v === null) continue;
      if (lowerTag(el) !== 'th') c.fail(el, `scope is only meaningful on <th>, not <${lowerTag(el)}>.`);
      else if (!/^(row|col|rowgroup|colgroup)$/i.test(v.trim())) c.fail(el, `scope="${v}" is not one of row, col, rowgroup, colgroup.`);
      else c.pass(el);
    }
  },

  'table.has-headers'(c) {
    for (const t of c.byTag('table')) {
      if (!isDataTable(t)) continue;
      if (hasHeaderCells(t)) {
        c.pass(t);
        continue;
      }
      const rows = ownRows(t as HTMLTableElement);
      c.review(t, `This ${rows.length}-row table has no header cells. If it holds data, mark headers with <th> (and scope); if it only lays out content, add role="presentation".`);
    }
  },

  'table.header-empty'(c) {
    for (const th of c.byTag('th')) {
      const r = getRole(th);
      if ((r !== 'columnheader' && r !== 'rowheader') || isHiddenForAria(th) || !isVisible(th)) continue;
      if (normalizeWhitespace(accessibleName(th))) c.pass(th);
      else c.fail(th, 'The header cell is empty; give it text (visually hidden if needed) or make it a <td>.');
    }
  },

  'table.caption'(c) {
    for (const t of c.byTag('table')) {
      if (!isDataTable(t) || !hasHeaderCells(t)) continue;
      if (normalizeWhitespace(accessibleName(t))) c.pass(t);
      else c.review(t, 'The data table has no <caption>, aria-label or aria-labelledby. Check whether a nearby heading identifies it.');
    }
  },

  'list.structure'(c) {
    for (const list of c.tags('ul', 'ol', 'menu')) {
      if (getRole(list) !== 'list' || isHiddenForAria(list)) continue;
      const bad: string[] = [];
      for (const child of Array.from(list.children)) {
        const tag = lowerTag(child);
        if (tag === 'script' || tag === 'template' || isHiddenForAria(child)) continue;
        if (tag !== 'li') bad.push(`<${tag}>`);
        else if (child.hasAttribute('role') && getRole(child) !== 'listitem') bad.push(`<li role="${child.getAttribute('role')}">`);
      }
      if (bad.length) c.fail(list, `The list contains ${[...new Set(bad)].join(', ')}; only <li> elements may be its items.`);
      else c.pass(list);
    }
  },

  'list.item-context'(c) {
    for (const li of c.byTag('li')) {
      if (li.hasAttribute('role') || getRole(li) !== 'listitem' || isHiddenForAria(li)) continue;
      const p = li.parentElement;
      const ok = !!p && (/^(ul|ol|menu)$/.test(lowerTag(p)) || getRole(p) === 'list');
      if (ok) c.pass(li);
      else c.fail(li, `The <li> is inside ${p ? `<${lowerTag(p)}>` : 'no element'}, not a <ul>, <ol> or <menu>.`);
    }
  },

  'list.definition'(c) {
    for (const dl of c.byTag('dl')) {
      if (isHiddenForAria(dl) || (dl.hasAttribute('role') && !/^(none|presentation)$/.test(dl.getAttribute('role') || ''))) continue;
      const bad: string[] = [];
      for (const child of Array.from(dl.children)) {
        const tag = lowerTag(child);
        if (tag === 'dt' || tag === 'dd' || tag === 'script' || tag === 'template') continue;
        if (tag === 'div' && Array.from(child.children).every((g) => /^(dt|dd|script|template)$/.test(lowerTag(g)))) continue;
        bad.push(`<${tag}>`);
      }
      if (bad.length) c.fail(dl, `The description list contains ${[...new Set(bad)].join(', ')}; only <dt>/<dd> (optionally grouped in <div>) belong there.`);
      else c.pass(dl);
    }
    for (const item of c.tags('dt', 'dd')) {
      const p = item.parentElement;
      const ok = !!p && (lowerTag(p) === 'dl' || (lowerTag(p) === 'div' && lowerTag(p.parentElement ?? p) === 'dl'));
      if (ok) c.pass(item);
      else c.fail(item, `<${lowerTag(item)}> must be inside a <dl>.`);
    }
  },

  'focus.tabindex-positive'(c) {
    for (const el of c.all()) {
      const v = el.getAttribute('tabindex');
      if (v === null) continue;
      const n = parseInt(v, 10);
      if (n > 0) c.fail(el, `tabindex="${v}" puts this element ahead of the natural tab order. Use 0 (or -1) and order the DOM instead.`);
      else c.pass(el);
    }
  },

  'keyboard.scrollable'(c) {
    for (const el of c.all()) {
      const tag = lowerTag(el);
      if (tag === 'html' || tag === 'body' || tag === 'textarea' || tag === 'select' || tag === 'iframe') continue;
      const s = style(el);
      const ox = s.overflowX;
      const oy = s.overflowY;
      const scrollY = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2;
      const scrollX = (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 2;
      if (!scrollY && !scrollX) continue;
      if (el === el.ownerDocument.scrollingElement || !isVisible(el) || isHiddenForAria(el)) continue;
      if (!normalizeWhitespace(el.textContent || '')) continue;
      if (isTabbable(el) || deepElements(el).some((d) => isTabbable(d))) c.pass(el);
      else c.fail(el, 'This region scrolls but nothing in it can take keyboard focus. Add tabindex="0" and a name (aria-label) so keyboard users can scroll it.');
    }
  },

  'keyboard.frame-tabindex'(c) {
    for (const f of c.tags('iframe', 'frame')) {
      const ti = f.getAttribute('tabindex');
      if (ti === null || parseInt(ti, 10) >= 0) continue;
      let doc: Document | null = null;
      try {
        doc = (f as HTMLIFrameElement).contentDocument;
      } catch {
        doc = null;
      }
      if (!doc || !doc.body) {
        c.review(f, `tabindex="${ti}" on the frame; check that its content has nothing focusable.`);
        continue;
      }
      const inner = deepElements(doc.body).filter((e) => isTabbable(e));
      if (inner.length) c.fail(f, `tabindex="${ti}" removes this frame from the tab order, but it contains ${inner.length} focusable element(s).`);
      else c.pass(f);
    }
  },

  'target.size'(c) {
    const all = targets(c);
    // Spatial index: 48px cells, so the neighbours within reach of a 24px circle sit in nearby cells.
    const CELL = 48;
    const grid = new Map<string, Target[]>();
    for (const t of all) {
      const x0 = Math.floor(t.box.x / CELL);
      const x1 = Math.floor((t.box.x + t.box.width) / CELL);
      const y0 = Math.floor(t.box.y / CELL);
      const y1 = Math.floor((t.box.y + t.box.height) / CELL);
      for (let gx = x0; gx <= Math.min(x1, x0 + 40); gx++) {
        for (let gy = y0; gy <= Math.min(y1, y0 + 40); gy++) {
          const k = `${gx},${gy}`;
          const l = grid.get(k);
          if (l) l.push(t);
          else grid.set(k, [t]);
        }
      }
    }
    const nearby = (cx: number, cy: number): Set<Target> => {
      const out = new Set<Target>();
      for (let gx = Math.floor((cx - 24) / CELL); gx <= Math.floor((cx + 24) / CELL); gx++) {
        for (let gy = Math.floor((cy - 24) / CELL); gy <= Math.floor((cy + 24) / CELL); gy++) for (const t of grid.get(`${gx},${gy}`) ?? []) out.add(t);
      }
      return out;
    };
    for (const t of all) {
      if (!t.small) {
        c.pass(t.el);
        continue;
      }
      if (inlineInText(t.el)) {
        c.pass(t.el);
        continue;
      }
      const cx = t.box.x + t.box.width / 2;
      const cy = t.box.y + t.box.height / 2;
      let near: Target | null = null;
      for (const o of nearby(cx, cy)) {
        if (o === t || o.el.contains(t.el) || t.el.contains(o.el)) continue;
        const hit = o.small ? Math.hypot(o.box.x + o.box.width / 2 - cx, o.box.y + o.box.height / 2 - cy) < 24 : distToRect(cx, cy, o.box) < 12;
        if (hit) {
          near = o;
          break;
        }
      }
      if (!near) {
        c.pass(t.el);
        continue;
      }
      const labels = Array.from((t.el as HTMLInputElement).labels ?? []);
      if (labels.some((l) => {
        const b = c.box(l);
        return !!b && b.width >= 24 && b.height >= 24;
      })) {
        c.pass(t.el);
        continue;
      }
      const size = `${Math.round(t.box.width)}x${Math.round(t.box.height)}px`;
      if (userAgentSized(t.el)) c.review(t.el, `The target is ${size} (sized by the browser) and close to ${short(near.el)}; check that a larger equivalent target (such as its label) exists.`);
      else c.fail(t.el, `The target is ${size}, under 24x24px, and a 24px circle around it overlaps ${short(near.el)}. Enlarge it or add spacing.`);
    }
  },

  'target.size-enhanced'(c) {
    for (const t of targets(c)) {
      if (inlineInText(t.el) || userAgentSized(t.el)) continue;
      if (t.box.width >= 44 && t.box.height >= 44) c.pass(t.el);
      else c.fail(t.el, `The target is ${Math.round(t.box.width)}x${Math.round(t.box.height)}px; the enhanced size is 44x44px.`);
    }
  },

  'zoom.viewport'(c) {
    for (const m of Array.from(c.docs[0].doc.querySelectorAll('meta[name="viewport" i]'))) {
      const content = (m.getAttribute('content') || '').toLowerCase();
      const props = new Map<string, string>();
      for (const part of content.split(/[,;]/)) {
        const [k, v] = part.split('=').map((x) => x?.trim());
        if (k) props.set(k, v ?? '');
      }
      const us = props.get('user-scalable');
      const max = props.has('maximum-scale') ? parseFloat(props.get('maximum-scale') as string) : NaN;
      if (us === 'no' || us === '0') c.fail(m, 'user-scalable=no prevents zooming. Remove it.');
      else if (!Number.isNaN(max) && max < 2) c.fail(m, `maximum-scale=${props.get('maximum-scale')} limits zoom below 200%. Remove it or set at least 2 (preferably 5).`);
      else c.pass(m);
    }
  },

  'timing.meta-refresh'(c) {
    for (const d of c.docs) {
      for (const m of Array.from(d.doc.querySelectorAll('meta[http-equiv="refresh" i]'))) {
        const content = m.getAttribute('content') || '';
        const mm = /^\s*(\d+(?:\.\d*)?)\s*(?:[;,]\s*(?:url\s*=)?\s*(.*))?$/i.exec(content);
        if (!mm) continue;
        const delay = parseFloat(mm[1]);
        if (delay === 0 || delay > 72000) c.pass(m);
        else c.fail(m, mm[2] ? `The page redirects to ${quote(mm[2])} after ${delay}s.` : `The page reloads itself every ${delay}s.`);
      }
    }
  },

  'form.autocomplete'(c) {
    for (const el of c.tags('input', 'select', 'textarea')) {
      const v = el.getAttribute('autocomplete');
      if (v === null || !v.trim()) continue;
      if (lowerTag(el) === 'input' && NO_AUTOFILL_TYPES.has(((el as HTMLInputElement).type || '').toLowerCase())) continue;
      if (isHiddenForAria(el) && (el as HTMLInputElement).type !== 'hidden') continue;
      const p = autocompleteProblem(v);
      if (p) c.fail(el, `autocomplete="${v}": ${p}.`);
      else c.pass(el);
    }
  },

  'frame.title-unique'(c) {
    const seen = new Map<string, Element>();
    for (const f of c.tags('iframe', 'frame')) {
      const title = normalizeWhitespace(f.getAttribute('title') || '').toLowerCase();
      if (!title || !isVisible(f)) continue;
      const first = seen.get(title);
      if (first && (first.getAttribute('src') || '') !== (f.getAttribute('src') || '')) c.fail(f, `Another frame (${c.localSelector(first)}) has the same title ${quote(title)} but shows different content.`);
      else {
        if (!first) seen.set(title, f);
        c.pass(f);
      }
    }
  },

  'media.captions'(c) {
    for (const v of c.byTag('video')) {
      if (isHiddenForAria(v) || !isVisible(v)) continue;
      if (v.hasAttribute('muted') && !v.hasAttribute('controls')) {
        c.pass(v);
        continue;
      }
      const kinds = Array.from(v.querySelectorAll('track')).map((t) => (t.getAttribute('kind') || 'subtitles').toLowerCase());
      if (kinds.includes('captions')) c.pass(v);
      else if (kinds.includes('subtitles')) c.review(v, 'The video has subtitles but no captions track; check that the subtitles include speakers and meaningful sounds.');
      else c.review(v, 'The video has no captions track. Check that it has no audio, or that captions are provided (open captions count).');
    }
  },

  'media.audio-description'(c) {
    for (const v of c.byTag('video')) {
      if (isHiddenForAria(v) || !isVisible(v)) continue;
      if (Array.from(v.querySelectorAll('track')).some((t) => (t.getAttribute('kind') || '').toLowerCase() === 'descriptions')) c.pass(v);
      else c.review(v, 'Check that important visual information is described (a descriptions track, a described version, or a soundtrack that already conveys it).');
    }
  },

  'media.audio-alternative'(c) {
    for (const a of c.byTag('audio')) {
      if (isHiddenForAria(a)) continue;
      if (!a.hasAttribute('controls') && !a.hasAttribute('autoplay')) continue;
      c.review(a, 'Check that a text transcript of this audio is available.');
    }
  },

  'media.autoplay'(c) {
    for (const m of c.tags('video', 'audio')) {
      const el = m as HTMLMediaElement;
      if (!el.hasAttribute('autoplay') || el.muted || el.hasAttribute('muted')) continue;
      if (Number.isFinite(el.duration) && el.duration <= 3 && !el.loop) {
        c.pass(m);
        continue;
      }
      if (el.hasAttribute('controls')) c.pass(m);
      else if (!Number.isFinite(el.duration)) c.review(m, 'The media plays automatically with sound and has no controls; check it stops within 3 seconds or can be paused.');
      else c.fail(m, `The media plays automatically with sound for ${Math.round(el.duration)}s and offers no control to pause or mute it.`);
    }
  },

  'motion.blink'(c) {
    for (const el of c.byTag('blink')) c.fail(el, '<blink> text cannot be paused or stopped.');
  },

  'motion.marquee'(c) {
    for (const el of c.byTag('marquee')) c.fail(el, '<marquee> scrolls text that cannot be paused or stopped.');
  },

  'layout.orientation'(c) {
    for (const d of c.docs) {
      const html = d.doc.documentElement;
      if (!html) continue;
      let locked: string | null = null;
      for (const sheet of sheetsOf(d.doc)) {
        let rules: CSSRuleList | undefined;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin stylesheet
        }
        for (const { rule, media } of allRules(rules)) {
          const m = media.find((x) => /orientation\s*:\s*(portrait|landscape)/i.test(x));
          if (!m) continue;
          let targetsRoot = false;
          try {
            targetsRoot = [html, d.doc.body].some((e) => e && e.matches(rule.selectorText)) || /(^|,)\s*(:root|html|body|\*)\s*(,|$)/.test(rule.selectorText);
          } catch {
            targetsRoot = false;
          }
          if (!targetsRoot) continue;
          const st = rule.style;
          const rot = st.getPropertyValue('rotate').trim();
          if (rotates(st.transform || '') || (rot && rotates(`rotate(${rot})`)) || st.display === 'none' || st.visibility === 'hidden') {
            locked = `@media ${m} { ${rule.selectorText} { ${st.cssText} } }`;
            break;
          }
        }
        if (locked) break;
      }
      if (locked) c.fail(html, `A style rule locks the orientation: ${quote(locked, 140)}.`);
      else c.pass(html);
    }
  },
};
