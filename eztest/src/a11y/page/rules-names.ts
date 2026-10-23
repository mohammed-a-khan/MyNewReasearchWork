/**
 * Text alternatives (WCAG 1.1.1) and accessible names (4.1.2, 2.4.4, 2.5.3,
 * 3.3.2). Names come from EZTest's accname 1.2 implementation.
 */
import { accessibleName } from '../../browser/injected/page/accname.js';
import { getByIdInTree, idrefs, lowerTag, normalizeWhitespace } from '../../browser/injected/page/dom.js';
import { explicitRole } from '../../browser/injected/page/roles.js';
import { FIELD_ROLES, NAME_REQUIRED_CONTAINERS, NAME_REQUIRED_WIDGETS } from './aria-data.js';
import type { Ctx } from './context.js';
import { describeRole, getRole, isHiddenForAria, isVisible, quote, visibleText } from './util.js';

export type RuleFn = (c: Ctx) => void;

const FILE_LIKE = /^[\w\-. %()]+\.(?:png|jpe?g|gif|svg|webp|bmp|avif|ico|tiff?)$/i;
const PLACEHOLDER_ALT = /^(?:image|img|picture|photo|graphic|spacer|icon|logo|alt|blank|untitled|null|undefined|\*|-|_)$/i;
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'tel', 'url', 'password', 'number', '']);
const NO_ROLE_FIELDS = new Set(['date', 'datetime-local', 'month', 'week', 'time', 'color', 'file']);
const LABELABLE = new Set(['button', 'meter', 'output', 'progress', 'select', 'textarea']);

function role(el: Element): string | null {
  return getRole(el);
}

function exposed(el: Element): boolean {
  return !isHiddenForAria(el);
}

/** Form fields: elements with a field role, plus native inputs that have no ARIA role (date, colour, file ...). */
export function formFields(c: Ctx): Element[] {
  return c.all().filter((el) => {
    const tag = lowerTag(el);
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'hidden' || type === 'image' || type === 'button' || type === 'submit' || type === 'reset') return false;
      if (NO_ROLE_FIELDS.has(type)) return true;
    }
    const r = role(el);
    if (!r || !FIELD_ROLES.has(r)) return false;
    // A combobox's popup listbox is named through the combobox; native datalists are never rendered.
    if (tag === 'datalist') return false;
    return true;
  });
}

export const NAME_RULES: Record<string, RuleFn> = {
  'text-alt.img'(c) {
    for (const img of c.byTag('img')) {
      if (!exposed(img)) continue;
      const r = role(img);
      if (r === 'presentation' || r === 'none') {
        c.pass(img);
        continue;
      }
      const name = normalizeWhitespace(accessibleName(img));
      if (!name) {
        const alt = img.getAttribute('alt');
        c.fail(img, alt === null
          ? 'The image has no alt attribute and no aria-label, aria-labelledby or title. Add alt text, or alt="" if it is decorative.'
          : 'The image has an empty text alternative but is exposed as an image (it is focusable or has ARIA attributes).');
      } else if (FILE_LIKE.test(name) || PLACEHOLDER_ALT.test(name)) {
        c.review(img, `The text alternative ${quote(name)} looks like a file name or placeholder; check that it says what the image shows.`);
      } else c.pass(img);
    }
  },

  'text-alt.area'(c) {
    for (const area of c.byTag('area')) {
      if (!area.hasAttribute('href') || area.closest('[aria-hidden="true"]')) continue;
      if (normalizeWhitespace(accessibleName(area))) c.pass(area);
      else c.fail(area, 'This image-map link has no alt, aria-label or aria-labelledby.');
    }
  },

  'text-alt.input-image'(c) {
    for (const el of c.byTag('input')) {
      if ((el as HTMLInputElement).type !== 'image' || !exposed(el)) continue;
      const direct = ['alt', 'aria-label', 'title'].some((a) => (el.getAttribute(a) || '').trim());
      const viaRefs = idrefs(el, 'aria-labelledby').some((r) => normalizeWhitespace(r.textContent || ''));
      if (direct || viaRefs) c.pass(el);
      else c.fail(el, 'The image button has no alt, aria-label, aria-labelledby or title saying what it does.');
    }
  },

  'text-alt.role-img'(c) {
    for (const el of c.all()) {
      if (lowerTag(el) === 'img' || !el.hasAttribute('role')) continue;
      const r = explicitRole(el);
      if (r !== 'img' && r !== 'graphics-document' && r !== 'graphics-symbol') continue;
      if (!exposed(el)) continue;
      if (normalizeWhitespace(accessibleName(el))) c.pass(el);
      else c.fail(el, `role="${r}" makes this one image, but it has no aria-label, aria-labelledby${el.namespaceURI === 'http://www.w3.org/2000/svg' ? ' or <title>' : ''}.`);
    }
  },

  'text-alt.object'(c) {
    for (const el of c.byTag('object')) {
      if (!exposed(el) || !isVisible(el)) continue;
      const name = normalizeWhitespace(accessibleName(el)) || normalizeWhitespace(el.textContent || '');
      if (name) c.pass(el);
      else c.fail(el, 'The object has no aria-label, aria-labelledby, title or fallback text.');
    }
  },

  'name.button'(c) {
    for (const el of c.all()) {
      if (role(el) !== 'button') continue;
      if (lowerTag(el) === 'input' && (el as HTMLInputElement).type === 'image') continue;
      if (!exposed(el)) continue;
      if (normalizeWhitespace(accessibleName(el))) {
        c.pass(el);
        continue;
      }
      const img = el.querySelector('img:not([alt]), svg');
      c.fail(el, img
        ? 'The button shows only an image or icon and has no accessible name. Add aria-label, or alt text to the image.'
        : 'The button has no text, aria-label or aria-labelledby.');
    }
  },

  'name.link'(c) {
    for (const el of c.all()) {
      if (role(el) !== 'link' || lowerTag(el) === 'area') continue;
      if (!exposed(el)) continue;
      if (normalizeWhitespace(accessibleName(el))) c.pass(el);
      else c.fail(el, el.querySelector('img, svg')
        ? 'The link contains only an image without a text alternative, so it has no name.'
        : 'The link has no text, aria-label or aria-labelledby.');
    }
  },

  'name.form-field'(c) {
    for (const el of formFields(c)) {
      if (!exposed(el)) continue;
      if (normalizeWhitespace(accessibleName(el))) c.pass(el);
      else c.fail(el, `This ${describeField(el)} has no label. Associate a <label>, or add aria-labelledby or aria-label.`);
    }
  },

  'label.visible'(c) {
    for (const el of formFields(c)) {
      if (!exposed(el) || !isVisible(el)) continue;
      const tag = lowerTag(el);
      if (tag !== 'textarea' && tag !== 'select' && !(tag === 'input' && TEXT_INPUTS.has(((el as HTMLInputElement).type || '').toLowerCase()))) continue;
      const name = normalizeWhitespace(accessibleName(el));
      if (!name) continue;
      const labels = Array.from((el as HTMLInputElement).labels ?? []).filter((l) => isVisible(l) && normalizeWhitespace(l.textContent || ''));
      const refs = idrefs(el, 'aria-labelledby').filter((r) => isVisible(r));
      if (labels.length || refs.length || (el.getAttribute('aria-label') || '').trim()) {
        c.pass(el);
        continue;
      }
      const ph = (el.getAttribute('placeholder') || '').trim();
      c.review(el, ph
        ? `The field is labelled only by its placeholder ${quote(ph)}, which disappears while typing. Check that a visible label is nearby.`
        : `The field is labelled only by its title ${quote(name)}. Check that a visible label is nearby.`);
    }
  },

  'label.for-target'(c) {
    for (const label of c.byTag('label')) {
      const id = label.getAttribute('for');
      if (id === null) continue;
      const target = id ? getByIdInTree(label, id) : null;
      if (!target) {
        c.fail(label, `for="${id}" names no element in this document.`);
        continue;
      }
      const tag = lowerTag(target);
      const ok = (tag === 'input' && (target as HTMLInputElement).type !== 'hidden') || LABELABLE.has(tag) || ((target.constructor as { formAssociated?: boolean }).formAssociated === true);
      if (ok) c.pass(label);
      else c.fail(label, `for="${id}" points to a <${tag}>, which cannot be labelled.`);
    }
  },

  'name.widget'(c) {
    for (const el of c.all()) {
      const r = role(el);
      if (!r || !NAME_REQUIRED_WIDGETS.has(r)) continue;
      const tag = lowerTag(el);
      if (tag === 'option' && el.closest('select, datalist')) continue;
      if (!exposed(el)) continue;
      if (normalizeWhitespace(accessibleName(el))) c.pass(el);
      else c.fail(el, `${cap(describeRole(r))} needs an accessible name (aria-label or aria-labelledby${r === 'tab' || r.startsWith('menuitem') || r === 'treeitem' || r === 'option' || r === 'tooltip' ? ', or text content' : ''}).`);
    }
  },

  'name.container'(c) {
    for (const el of c.all()) {
      if (!el.hasAttribute('role')) continue;
      const r = role(el);
      if (!r || !NAME_REQUIRED_CONTAINERS.has(r) || r === 'menu' || r === 'menubar' || r === 'toolbar') continue;
      if (!exposed(el)) continue;
      if (normalizeWhitespace(accessibleName(el))) c.pass(el);
      else c.fail(el, `${cap(describeRole(r))} should have a name (aria-label or aria-labelledby) saying what it contains.`);
    }
  },

  'name.frame'(c) {
    for (const el of c.tags('iframe', 'frame')) {
      if (!exposed(el) || !isVisible(el)) continue;
      if (normalizeWhitespace(accessibleName(el))) c.pass(el);
      else c.fail(el, 'The frame has no title (or aria-label) describing its content.');
    }
  },

  'name.label-in-name'(c) {
    const ROLES_ = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem', 'switch', 'checkbox', 'radio']);
    for (const el of c.all()) {
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) continue;
      const r = role(el);
      if (!r || !ROLES_.has(r) || !exposed(el) || !isVisible(el)) continue;
      const tag = lowerTag(el);
      if (tag === 'input' && !/^(button|submit|reset)$/.test((el as HTMLInputElement).type)) continue; // its visible label is a <label>, checked by name.form-field
      const visible = tag === 'input' ? (el as HTMLInputElement).value || '' : visibleText(el);
      const v = simplify(visible);
      if ((v.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) continue;
      const name = simplify(accessibleName(el));
      if (name.includes(v)) c.pass(el);
      else c.fail(el, `The visible label ${quote(normalizeWhitespace(visible))} is not part of the accessible name ${quote(normalizeWhitespace(accessibleName(el)))}. Speech users saying the visible words will miss it.`);
    }
  },
};

function simplify(s: string): string {
  return normalizeWhitespace(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describeField(el: Element): string {
  const tag = lowerTag(el);
  if (tag === 'input') return `<input type="${((el as HTMLInputElement).type || 'text').toLowerCase()}">`;
  if (tag === 'select' || tag === 'textarea') return `<${tag}>`;
  return `${role(el) ?? tag} field`;
}
