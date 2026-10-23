/**
 * Human descriptions (`describe`) and healer fingerprints (`fingerprint`).
 *
 * `describe` is short and stable for the same element:
 *   - `role "name"` when the element has a meaningful role and a name,
 *     e.g. `button "Submit order"`, `link "Help"`, `heading "Orders"`;
 *   - otherwise a CSS-like form: `input#qty[name=quantity]`,
 *     `div.card.selected`, `span "Total: 5"`.
 *
 * `fingerprint` captures the same fields as src/heal/fingerprint.ts (the
 * ElementFingerprint schema in src/core/journey.ts) so stored fingerprints
 * stay comparable after the switch to EZTest's own driver.
 */
import type { PageFingerprint, PageScannedElement } from '../engine-api.js';
import { accessibleName } from './accname.js';
import { clip, cssLabel, idrefs, lowerTag, normalizeWhitespace, withCaches } from './dom.js';
import { getRole, withRoleCache } from './roles.js';
import { elementText } from './selector.js';
import { isDisabled } from './states.js';
import { isVisible } from './visibility.js';

const PLAIN_ROLES = new Set(['generic', 'none', 'presentation', 'paragraph', 'group', 'list', 'listitem', 'rowgroup', 'strong', 'emphasis', 'code', 'time', 'term', 'definition', 'deletion', 'insertion', 'mark', 'subscript', 'superscript', 'blockquote', 'caption', 'document']);

function quote(s: string): string {
  return '"' + clip(s, 60).replace(/"/g, '\\"') + '"';
}

export function describe(el: Element): string {
  return withCaches(() =>
    withRoleCache(() => {
      const role = getRole(el);
      if (role && !PLAIN_ROLES.has(role)) {
        const name = accessibleName(el);
        if (name) return `${role} ${quote(name)}`;
      }
      const tag = lowerTag(el);
      let s = tag;
      if (el.id) s = cssLabel(el);
      const name = el.getAttribute('name');
      if (name && /^(input|select|textarea|button|form|iframe|frame|object|fieldset|output|meta|map|slot)$/.test(tag)) s += `[name=${name}]`;
      if (tag === 'input' && !el.id && !name) s += `[type=${(el as HTMLInputElement).type}]`;
      const testId = el.getAttribute('data-testid');
      if (testId && !el.id) s += `[data-testid=${testId}]`;
      if (s === tag) s = cssLabel(el);
      if (s === tag) {
        const text = elementText(el);
        if (text) return `${tag} ${quote(text)}`;
      }
      return s;
    }),
  );
}

const KEEP = ['type', 'name', 'href', 'role', 'aria-label', 'title', 'alt', 'placeholder', 'autocomplete', 'inputmode', 'value', 'for', 'download'];

/** Label text as the healer has always recorded it: aria-labelledby, else the first label, else the wrapping label. */
function labelOf(el: Element): string {
  const refs = idrefs(el, 'aria-labelledby');
  if (refs.length) {
    const joined = normalizeWhitespace(refs.map((r) => normalizeWhitespace(r.textContent || '')).join(' '));
    if (joined) return joined;
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) return normalizeWhitespace((labels[0] as HTMLElement).innerText || labels[0].textContent || '');
  const wrap = el.closest('label');
  if (wrap) return normalizeWhitespace((wrap as HTMLElement).innerText || wrap.textContent || '');
  return '';
}

function segment(el: Element): string {
  let s = lowerTag(el);
  if (el.id) s += '#' + el.id;
  else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
  return s;
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function fingerprint(el: Element): PageFingerprint {
  return withCaches(() =>
    withRoleCache(() => {
      const tag = lowerTag(el);
      const label = labelOf(el);
      const attrs: Record<string, string> = {};
      for (const k of KEEP) {
        if (!el.hasAttribute(k)) continue;
        if (k === 'value' && !(tag === 'input' && /^(submit|button|reset)$/i.test(el.getAttribute('type') || ''))) continue;
        attrs[k] = String(el.getAttribute(k)).slice(0, 200);
      }
      const anc: string[] = [];
      for (let p = el.parentElement; p && anc.length < 4; p = p.parentElement) {
        const t = lowerTag(p);
        if (t === 'body' || t === 'html') break;
        anc.unshift(segment(p));
      }
      const r = el.getBoundingClientRect();
      const role = getRole(el);
      const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
      const visibleText = normalizeWhitespace((el as HTMLElement).innerText ?? el.textContent ?? '').slice(0, 200);
      const name =
        accessibleName(el) ||
        (isField ? '' : visibleText) ||
        normalizeWhitespace(el.getAttribute('title') || '');
      return compact<PageFingerprint>({
        tag,
        role: role && role !== 'generic' && role !== 'none' && role !== 'presentation' ? role : undefined,
        name: name ? name.slice(0, 200) : undefined,
        text: isField ? undefined : visibleText || undefined,
        id: el.id || undefined,
        testId: el.getAttribute('data-testid') || undefined,
        classes: el.classList && el.classList.length ? Array.from(el.classList) : undefined,
        attributes: Object.keys(attrs).length ? attrs : undefined,
        label: label || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        path: anc.join(' > ') || undefined,
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      });
    }),
  );
}

export function scan(els: Element[]): PageScannedElement[] {
  return withCaches(() => withRoleCache(() => els.map((el) => ({ fingerprint: fingerprint(el), visible: isVisible(el), enabled: !isDisabled(el) }))));
}
