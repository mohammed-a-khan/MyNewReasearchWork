/**
 * `h()`: a tiny DOM builder. Text always goes through text nodes and
 * attributes through setAttribute/properties, never innerHTML, so untrusted
 * data cannot inject markup. Styles are set through the CSSOM (CSP-safe).
 */
export type Child = Node | string | number | null | undefined | false | Child[];

type Listener = (ev: never) => void;

export interface Attrs {
  class?: string | Array<string | false | null | undefined> | Record<string, boolean | undefined>;
  text?: string | number;
  style?: Partial<Record<keyof CSSStyleDeclaration, string>> & Record<string, string>;
  dataset?: Record<string, string | number | undefined>;
  ref?: (el: HTMLElement) => void;
  [key: string]: unknown;
}

const PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'disabled', 'hidden', 'open', 'multiple', 'tabIndex']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);

/** Join class specs into a className string. */
export function cx(spec: Attrs['class']): string {
  if (!spec) return '';
  if (typeof spec === 'string') return spec;
  if (Array.isArray(spec)) return spec.filter(Boolean).join(' ');
  return Object.entries(spec)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(' ');
}

function safeUrl(v: string): boolean {
  return !/^\s*(?:javascript|vbscript|data:text\/html)/i.test(v);
}

function applyAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.setAttribute('class', cx(v as Attrs['class']));
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') Object.assign((el as HTMLElement).style, v);
    else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) if (dv !== undefined) (el as HTMLElement).dataset[dk] = String(dv);
    } else if (k === 'ref') (v as (e: Element) => void)(el);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (PROPS.has(k) && k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else if (URL_ATTRS.has(k)) {
      if (safeUrl(String(v))) el.setAttribute(k, String(v));
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

export function append(el: Node, c: Child): void {
  if (c === undefined || c === null || c === false) return;
  if (Array.isArray(c)) {
    for (const x of c) append(el, x);
    return;
  }
  el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
}

/** Append children (null/false skipped, arrays flattened) and return the parent. */
export function add<T extends Node>(el: T, ...children: Child[]): T {
  for (const c of children) append(el, c);
  return el;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  for (const c of children) append(el, c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Record<string, unknown> | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.setAttribute('class', cx(v as Attrs['class']));
      else if (k === 'text') el.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) append(el, c);
  return el;
}

export function clear<T extends Node>(el: T): T {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Replace an element's children. */
export function render(el: Element, ...children: Child[]): void {
  clear(el);
  for (const c of children) append(el, c);
}

let seq = 0;
/** A unique DOM id with a readable prefix. */
export function uid(prefix = 'ez'): string {
  return `${prefix}-${++seq}`;
}

/** Add an event listener and return a function that removes it. */
export function listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): () => void;
export function listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): () => void;
export function listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): () => void;
export function listen(target: EventTarget, type: string, fn: Listener, opts?: AddEventListenerOptions): () => void {
  target.addEventListener(type, fn as EventListener, opts);
  return () => target.removeEventListener(type, fn as EventListener, opts);
}

/** Elements that can take keyboard focus inside `root`. */
export function focusables(root: ParentNode): HTMLElement[] {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((e) => !e.closest('[hidden]') && e.getClientRects().length > 0);
}

/** Announce a message to screen readers through the shared live region. */
export function announce(message: string): void {
  const region = document.getElementById('ez-announcer');
  if (!region) return;
  region.textContent = '';
  // A new text node after a tick makes repeated messages audible.
  setTimeout(() => (region.textContent = message), 30);
}
