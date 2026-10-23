/**
 * ARIA states (WAI-ARIA 1.2 §6.6) with their native HTML equivalents
 * (HTML-AAM): checked, pressed, expanded, selected, disabled, level,
 * plus editability for fill-type actions.
 */
import { composedParent, lowerTag } from './dom.js';
import { getRole } from './roles.js';

type Tri = boolean | 'mixed';

const CHECKED_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'option']);

/** checked / mixed / unchecked, or undefined when the element has no checked state. */
export function checkedState(el: Element): Tri | undefined {
  const tag = lowerTag(el);
  if (tag === 'input') {
    const inp = el as HTMLInputElement;
    if (inp.type === 'checkbox' || inp.type === 'radio') {
      // Native state wins: HTML-AAM says aria-checked must not override it.
      if (inp.type === 'checkbox' && inp.indeterminate) return 'mixed';
      return inp.checked;
    }
  }
  const role = getRole(el);
  if (!role || !CHECKED_ROLES.has(role)) return undefined;
  const a = el.getAttribute('aria-checked');
  if (a === 'true') return true;
  if (a === 'mixed' && role !== 'radio' && role !== 'menuitemradio') return 'mixed';
  if (a === 'false' || role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') return false;
  return undefined;
}

export function pressedState(el: Element): Tri | undefined {
  if (getRole(el) !== 'button') return undefined;
  const a = el.getAttribute('aria-pressed');
  if (a === 'true') return true;
  if (a === 'mixed') return 'mixed';
  return false;
}

export function expandedState(el: Element): boolean | undefined {
  const a = el.getAttribute('aria-expanded');
  if (a === 'true') return true;
  if (a === 'false') return false;
  const tag = lowerTag(el);
  if (tag === 'details') return (el as HTMLDetailsElement).open;
  if (tag === 'summary' && el.parentElement && lowerTag(el.parentElement) === 'details') return (el.parentElement as HTMLDetailsElement).open;
  return undefined;
}

const SELECTED_ROLES = new Set(['gridcell', 'option', 'row', 'tab', 'columnheader', 'rowheader', 'treeitem']);

export function selectedState(el: Element): boolean | undefined {
  if (lowerTag(el) === 'option') return (el as HTMLOptionElement).selected;
  const role = getRole(el);
  if (!role || !SELECTED_ROLES.has(role)) return undefined;
  return el.getAttribute('aria-selected') === 'true';
}

const NATIVE_DISABLE = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);

/**
 * Disabled: native `:disabled` (covers `disabled` attributes, fieldset
 * inheritance outside the first legend, optgroup/option) — also when the
 * control is a descendant of a disabled `<select>` — or `aria-disabled="true"`
 * on the element or any ancestor (WAI-ARIA: the state applies to all
 * focusable descendants).
 */
export function isDisabled(el: Element): boolean {
  const tag = lowerTag(el);
  if (NATIVE_DISABLE.has(tag) || tag.includes('-')) {
    try {
      if (el.matches(':disabled')) return true;
    } catch {
      /* :disabled unsupported for this element */
    }
  }
  if (tag === 'option' || tag === 'optgroup') {
    const sel = el.closest('select');
    if (sel && (sel as HTMLSelectElement).disabled) return true;
  }
  for (let p: Element | null = el; p; p = composedParent(p)) {
    if (p.getAttribute('aria-disabled') === 'true') return true;
  }
  return false;
}

export function headingLevel(el: Element): number | undefined {
  const a = parseInt(el.getAttribute('aria-level') || '', 10);
  const role = getRole(el);
  if (role === 'heading') {
    if (a > 0) return a;
    const m = /^h([1-6])$/.exec(lowerTag(el));
    return m ? Number(m[1]) : 2;
  }
  if (role === 'treeitem' || role === 'listitem' || role === 'row' || role === 'gridcell' || role === 'rowheader' || role === 'columnheader') {
    return a > 0 ? a : undefined;
  }
  return undefined;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'hidden', 'range', 'color']);

/** Why the element cannot take text, or '' when it can (ignoring disabled/readonly). */
export function notFillableReason(el: Element): string {
  const tag = lowerTag(el);
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (NON_TEXT_INPUTS.has(type)) return `input of type "${type}" cannot be filled`;
    return '';
  }
  if (tag === 'textarea') return '';
  if ((el as HTMLElement).isContentEditable) return '';
  return 'element is not an <input>, <textarea> or [contenteditable] element';
}

export function isReadonly(el: Element): boolean {
  const tag = lowerTag(el);
  if ((tag === 'input' || tag === 'textarea') && (el as HTMLInputElement).readOnly) return true;
  for (let p: Element | null = el; p; p = composedParent(p)) {
    const v = p.getAttribute('aria-readonly');
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (p !== el) break;
  }
  return false;
}

/** Editable: enabled, not readonly, and an input/textarea/select or contenteditable. */
export function isEditable(el: Element): boolean {
  if (isDisabled(el) || isReadonly(el)) return false;
  const tag = lowerTag(el);
  if (tag === 'select') return true;
  return notFillableReason(el) === '';
}
