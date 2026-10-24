/**
 * Text and value helpers: innerText/textContent, input values, select
 * options, checkbox state, clear-and-fill, event dispatch.
 *
 * Fill sets the value through the prototype's native setter (so framework
 * value trackers such as React's notice the change) and then fires
 * `beforeinput`, `input` and `change` the way a user edit would.
 */
import type { EngineOutcome, SelectOptionSpec } from '../engine-api.js';
import { lowerTag, normalizeWhitespace } from './dom.js';
import { checkedState, isDisabled, isReadonly, notFillableReason } from './states.js';

/**
 * `innerText`, the same in every browser for drop-downs: Chromium includes
 * the option texts of a rendered `<select>` (one per line), Firefox leaves
 * the whole select out (not even the selected option). Where the browser
 * left a rendered select out, its option texts are added after the rest (in
 * document order), so "the page contains <an option>" holds on both engines.
 */
export function innerText(el: Element): string {
  const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  const selects = lowerTag(el) === 'select' ? [el as HTMLSelectElement] : Array.from(el.querySelectorAll('select'));
  if (!selects.length) return text;
  const flat = normalizeWhitespace(text);
  const missing: string[] = [];
  for (const s of selects) {
    if (!s.getClientRects().length) continue; // not rendered: not in innerText anywhere
    const options = Array.from(s.options).map((o) => normalizeWhitespace(o.text)).filter(Boolean);
    if (!options.length || options.every((o) => flat.includes(o))) continue; // this engine already includes them
    missing.push(options.join('\n'));
  }
  if (!missing.length) return text;
  return text ? `${text}${text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}` : missing.join('\n');
}

export function textContent(el: Element): string {
  return el.textContent ?? '';
}

export function inputValue(el: Element): string {
  const tag = lowerTag(el);
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return (el as HTMLInputElement).value;
  throw new Error('Not an <input>, <textarea> or <select> element');
}

function win(el: Element): Window & typeof globalThis {
  return (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
}

function fire(el: Element, type: string, init: Record<string, unknown> = {}): boolean {
  return dispatchEvent(el, type, init);
}

export function selectOptions(el: Element, specs: SelectOptionSpec[]): EngineOutcome<string[]> {
  if (lowerTag(el) !== 'select') return { ok: false, reason: 'selectOption() needs a <select>; this element is not one', retry: false };
  const select = el as HTMLSelectElement;
  if (isDisabled(select)) return { ok: false, reason: 'the element is disabled', retry: true };
  const options = Array.from(select.options);
  const chosen: HTMLOptionElement[] = [];
  for (const spec of specs) {
    const found = options.find((o, i) => {
      if (o.disabled) return false;
      if (typeof spec === 'string') return o.value === spec || normalizeWhitespace(o.label) === normalizeWhitespace(spec);
      if (spec.value !== undefined && o.value !== spec.value) return false;
      if (spec.label !== undefined && normalizeWhitespace(o.label) !== normalizeWhitespace(spec.label)) return false;
      if (spec.index !== undefined && i !== spec.index) return false;
      return spec.value !== undefined || spec.label !== undefined || spec.index !== undefined;
    });
    if (!found) return { ok: false, reason: `no option matching ${JSON.stringify(spec)}`, retry: true };
    chosen.push(found);
    if (!select.multiple) break;
  }
  for (const o of options) o.selected = chosen.includes(o);
  if (!chosen.length) select.selectedIndex = -1;
  fire(select, 'input', { bubbles: true, composed: true, cancelable: false });
  fire(select, 'change', { bubbles: true, cancelable: false });
  return { ok: true, value: chosen.map((o) => o.value) };
}

/**
 * Make a checkbox/radio (native or ARIA) checked or unchecked. Clicks it
 * (which fires click/input/change natively) only when the state differs.
 */
export function setChecked(el: Element, checked: boolean): EngineOutcome<boolean> {
  const state = checkedState(el);
  if (state === undefined) return { ok: false, reason: 'The element is not a checkbox or radio button (nor an element with a checked state such as role=checkbox)', retry: false };
  if (state === checked) return { ok: true, value: false };
  if (isDisabled(el)) return { ok: false, reason: 'the element is disabled', retry: true };
  if (!checked && lowerTag(el) === 'input' && (el as HTMLInputElement).type === 'radio') {
    return { ok: false, reason: 'cannot uncheck a radio button', retry: false };
  }
  (el as HTMLElement).click();
  if (checkedState(el) !== checked) return { ok: false, reason: 'clicking the element did not change its checked state', retry: true };
  return { ok: true, value: true };
}

const SET_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

function nativeValueSetter(el: Element): ((v: string) => void) | undefined {
  const w = win(el);
  const proto = lowerTag(el) === 'textarea' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value')?.set;
}

/** Clear and fill an input, textarea or contenteditable element. */
export function fill(el: Element, value: string): EngineOutcome {
  const why = notFillableReason(el);
  if (why) return { ok: false, reason: why, retry: false };
  if (isDisabled(el)) return { ok: false, reason: 'the element is disabled', retry: true };
  if (isReadonly(el)) return { ok: false, reason: 'the element is read-only', retry: true };
  const tag = lowerTag(el);
  (el as HTMLElement).focus();
  if (tag === 'input' || tag === 'textarea') {
    const input = el as HTMLInputElement;
    const type = tag === 'input' ? input.type.toLowerCase() : 'textarea';
    if (type === 'number' && value.trim() && Number.isNaN(Number(value))) {
      return { ok: false, reason: 'cannot type text into input[type=number]', retry: false };
    }
    const inputType = value ? 'insertText' : 'deleteContentBackward';
    if (!SET_VALUE_TYPES.has(type)) {
      const proceed = fire(el, 'beforeinput', { bubbles: true, cancelable: true, composed: true, inputType, data: value || null });
      if (!proceed) return { ok: true };
    }
    const setter = nativeValueSetter(el);
    if (setter) setter.call(el, value);
    else input.value = value;
    if (SET_VALUE_TYPES.has(type) && value && input.value !== value) {
      return { ok: false, reason: `malformed value "${value}" for input[type=${type}]`, retry: false };
    }
    fire(el, 'input', { bubbles: true, composed: true, inputType, data: value || null });
    fire(el, 'change', { bubbles: true });
    return { ok: true };
  }
  // contenteditable: select the contents and let the editing commands fire beforeinput/input.
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  const range = doc.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  let done = false;
  try {
    done = value ? doc.execCommand('insertText', false, value) : doc.execCommand('delete', false);
  } catch {
    done = false;
  }
  if (!done) {
    el.textContent = value;
    fire(el, 'input', { bubbles: true, composed: true, inputType: value ? 'insertText' : 'deleteContentBackward', data: value || null });
  }
  return { ok: true };
}

export function clear(el: Element): EngineOutcome {
  return fill(el, '');
}

export function selectText(el: Element): void {
  const tag = lowerTag(el);
  if (tag === 'input' || tag === 'textarea') {
    (el as HTMLInputElement).focus();
    (el as HTMLInputElement).select();
    return;
  }
  const doc = el.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(el);
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  (el as HTMLElement).focus?.();
}

export function focus(el: Element): void {
  (el as HTMLElement).focus?.();
}

const MOUSE = /^(click|dblclick|auxclick|contextmenu|mousedown|mouseup|mouseover|mouseout|mouseenter|mouseleave|mousemove)$/;
const POINTER = /^(pointer(down|up|over|out|enter|leave|move|cancel)|gotpointercapture|lostpointercapture)$/;
const KEY = /^key(down|up|press)$/;
const FOCUS = /^(focus|blur|focusin|focusout)$/;
const INPUT = /^(input|beforeinput)$/;
const DRAG = /^(drag|dragstart|dragend|dragenter|dragleave|dragover|drop)$/;
const TOUCH = /^touch(start|end|move|cancel)$/;

/**
 * Dispatch a synthetic event of the right class for `type`. Defaults:
 * bubbles, cancelable and composed are true (like a user-generated event),
 * except for focus/blur and mouseenter/mouseleave which do not bubble.
 */
export function dispatchEvent(el: Element, type: string, init: Record<string, unknown> = {}): boolean {
  const w = win(el);
  const nonBubbling = /^(focus|blur|mouseenter|mouseleave|pointerenter|pointerleave|load|scroll)$/.test(type);
  const base = { bubbles: !nonBubbling, cancelable: !nonBubbling, composed: true, ...init } as Record<string, unknown>;
  let ev: Event;
  if (MOUSE.test(type)) ev = new w.MouseEvent(type, { view: w, detail: type === 'dblclick' ? 2 : 1, ...base });
  else if (POINTER.test(type)) ev = new w.PointerEvent(type, { view: w, isPrimary: true, pointerId: 1, pointerType: 'mouse', ...base });
  else if (KEY.test(type)) ev = new w.KeyboardEvent(type, { view: w, ...base });
  else if (FOCUS.test(type)) ev = new w.FocusEvent(type, { view: w, ...base });
  else if (INPUT.test(type)) ev = new w.InputEvent(type, { view: w, ...base });
  else if (DRAG.test(type)) ev = new w.DragEvent(type, { view: w, dataTransfer: (base.dataTransfer as DataTransfer) ?? new w.DataTransfer(), ...base });
  else if (TOUCH.test(type) && typeof w.TouchEvent === 'function') ev = new w.TouchEvent(type, { view: w, ...base });
  else if (type === 'wheel') ev = new w.WheelEvent(type, { view: w, ...base });
  else if ('detail' in base) ev = new w.CustomEvent(type, base);
  else ev = new w.Event(type, base);
  return el.dispatchEvent(ev);
}
