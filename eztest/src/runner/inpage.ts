/**
 * Static in-page helpers shipped with EZTest (never user input). Like the
 * fingerprint code they are kept as source text and handed to the browser driver via
 * `pageFunction`, so the TypeScript toolchain never rewrites them.
 */
import { pageFunction } from '../heal/fingerprint.js';

/** Like pageFunction, for functions evaluated on an element (`locator.evaluate`). */
function onElement<A, R>(source: string): (el: Element, arg: A) => R {
  return pageFunction<A, R>(source) as unknown as (el: Element, arg: A) => R;
}

/** Read a DOM property of the element (JSON-safe). */
export const readProperty = onElement<string, unknown>(String.raw`(el, name) => {
  var v = el[name];
  if (v === undefined || v === null) return v === undefined ? null : v;
  if (typeof v === 'object') { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); } }
  if (typeof v === 'function') return null;
  return v;
}`);

/** Computed CSS property value. */
export const computedCss = onElement<string, string>(String.raw`(el, prop) => getComputedStyle(el).getPropertyValue(prop).trim()`);

/** Class list of the element. */
export const classList = onElement<undefined, string[]>(String.raw`(el) => Array.from(el.classList)`);

/** Is the element the active element (including inside shadow roots)? */
export const isFocused = onElement<undefined, boolean>(String.raw`(el) => {
  var a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a === el;
}`);

/** Fraction of the element inside the viewport (0..1). */
export const viewportRatio = onElement<undefined, number>(String.raw`(el) => {
  var r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return 0;
  var w = window.innerWidth || document.documentElement.clientWidth;
  var h = window.innerHeight || document.documentElement.clientHeight;
  var x = Math.max(0, Math.min(r.right, w) - Math.max(r.left, 0));
  var y = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
  return (x * y) / (r.width * r.height);
}`);

/** A table as header-mapped records. */
export const tableRows = onElement<undefined, Array<Record<string, string>>>(String.raw`(table) => {
  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var rows = Array.from(table.querySelectorAll('tr'));
  var headRow = table.querySelector('thead tr') || rows.find(function (r) { return r.querySelector('th'); }) || rows[0];
  if (!headRow) return [];
  var headers = Array.from(headRow.children).map(function (c, i) { return clean(c.innerText || c.textContent) || ('col' + (i + 1)); });
  var seen = {};
  headers = headers.map(function (h) { if (seen[h]) { seen[h]++; return h + '_' + seen[h]; } seen[h] = 1; return h; });
  return rows.filter(function (r) { return r !== headRow && r.querySelector('td'); }).map(function (r) {
    var rec = {};
    Array.from(r.children).forEach(function (c, i) { rec[headers[i] || ('col' + (i + 1))] = clean(c.innerText || c.textContent); });
    return rec;
  });
}`);

/** HTML5 drag and drop by dispatching DataTransfer events (what mouse-based dragging misses in some apps). */
export const html5Drag = onElement<unknown, void>(String.raw`(src, dst) => {
  var dt = new DataTransfer();
  var r = dst.getBoundingClientRect();
  var opts = function (el) { var b = el.getBoundingClientRect(); return { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }; };
  src.dispatchEvent(new DragEvent('dragstart', opts(src)));
  src.dispatchEvent(new DragEvent('drag', opts(src)));
  dst.dispatchEvent(new DragEvent('dragenter', opts(dst)));
  dst.dispatchEvent(new DragEvent('dragover', opts(dst)));
  dst.dispatchEvent(new DragEvent('drop', opts(dst)));
  src.dispatchEvent(new DragEvent('dragend', opts(src)));
  void r;
}`);

/** Drop files (name, type, base64 content) onto an element, as a user dragging files from the desktop would. */
export const dropFiles = onElement<Array<{ name: string; type: string; b64: string }>, number>(String.raw`(el, files) => {
  var dt = new DataTransfer();
  files.forEach(function (f) {
    var bin = atob(f.b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  });
  var b = el.getBoundingClientRect();
  var o = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: b.left + 5, clientY: b.top + 5 };
  el.dispatchEvent(new DragEvent('dragenter', o));
  el.dispatchEvent(new DragEvent('dragover', o));
  el.dispatchEvent(new DragEvent('drop', o));
  return dt.files.length;
}`);

/** Dispatch a CustomEvent (or plain Event) with an init dictionary on an element. */
export const dispatchCustom = onElement<{ type: string; init: Record<string, unknown> }, void>(String.raw`(el, a) => {
  var init = Object.assign({ bubbles: true, cancelable: true, composed: true }, a.init || {});
  var ev = ('detail' in init) ? new CustomEvent(a.type, init) : new Event(a.type, init);
  el.dispatchEvent(ev);
}`);

/** Dispatch an event on window (target "window") or document. */
export const dispatchGlobal = pageFunction<{ type: string; init: Record<string, unknown>; on: string }, void>(String.raw`(a) => {
  var init = Object.assign({ bubbles: true, cancelable: true }, a.init || {});
  var ev = ('detail' in init) ? new CustomEvent(a.type, init) : new Event(a.type, init);
  (a.on === 'document' ? document : window).dispatchEvent(ev);
}`);

/** Start recording events of a type on an element (or window/document), for "Wait for the X event". */
export const listenElement = onElement<{ type: string; id: string }, void>(String.raw`(el, a) => {
  var store = (window.__ezEvents = window.__ezEvents || {});
  store[a.id] = store[a.id] || [];
  el.addEventListener(a.type, function (e) { store[a.id].push({ type: e.type, detail: (e.detail === undefined ? null : e.detail), at: Date.now() }); }, true);
}`);
export const listenGlobal = pageFunction<{ type: string; id: string; on: string }, void>(String.raw`(a) => {
  var store = (window.__ezEvents = window.__ezEvents || {});
  store[a.id] = store[a.id] || [];
  (a.on === 'document' ? document : window).addEventListener(a.type, function (e) { store[a.id].push({ type: e.type, detail: (e.detail === undefined ? null : e.detail), at: Date.now() }); }, true);
}`);
export const readEvents = pageFunction<string, Array<{ type: string; detail: unknown; at: number }>>(String.raw`(id) => ((window.__ezEvents || {})[id] || [])`);

/** Scroll the window. */
export const scrollWindow = pageFunction<{ x?: number; y?: number; to?: string }, { x: number; y: number }>(String.raw`(a) => {
  var el = document.scrollingElement || document.documentElement;
  if (a.to === 'top') window.scrollTo(0, 0);
  else if (a.to === 'bottom') window.scrollTo(window.scrollX, el.scrollHeight);
  else if (a.to === 'left') window.scrollTo(0, window.scrollY);
  else if (a.to === 'right') window.scrollTo(el.scrollWidth, window.scrollY);
  else window.scrollBy(a.x || 0, a.y || 0);
  return { x: window.scrollX, y: window.scrollY };
}`);

/** Scroll an element (a scroll container). */
export const scrollElement = onElement<{ x?: number; y?: number; to?: string }, { x: number; y: number }>(String.raw`(el, a) => {
  if (a.to === 'top') el.scrollTop = 0;
  else if (a.to === 'bottom') el.scrollTop = el.scrollHeight;
  else if (a.to === 'left') el.scrollLeft = 0;
  else if (a.to === 'right') el.scrollLeft = el.scrollWidth;
  else el.scrollBy(a.x || 0, a.y || 0);
  el.dispatchEvent(new Event('scroll'));
  return { x: el.scrollLeft, y: el.scrollTop };
}`);

/** Web storage access. */
export const storageOp = pageFunction<{ area: string; op: string; key?: string; value?: string }, unknown>(String.raw`(a) => {
  var s = a.area === 'session' ? window.sessionStorage : window.localStorage;
  if (a.op === 'get') return s.getItem(a.key);
  if (a.op === 'set') { s.setItem(a.key, a.value); return null; }
  if (a.op === 'remove') { s.removeItem(a.key); return null; }
  if (a.op === 'clear') { s.clear(); return null; }
  if (a.op === 'all') { var o = {}; for (var i = 0; i < s.length; i++) { var k = s.key(i); o[k] = s.getItem(k); } return o; }
  return null;
}`);

/** Clipboard text. */
export const clipboardRead = pageFunction<void, string>(String.raw`() => navigator.clipboard.readText()`);
export const clipboardWrite = pageFunction<string, void>(String.raw`(t) => navigator.clipboard.writeText(t)`);

/** Synthetic touch swipe (fallback where the DevTools protocol is not available). */
export const touchSwipe = onElement<{ dx: number; dy: number; steps: number }, void>(String.raw`(el, a) => {
  var b = el.getBoundingClientRect();
  var x = b.left + b.width / 2, y = b.top + b.height / 2;
  var mk = function (cx, cy) { return new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy, pageX: cx + window.scrollX, pageY: cy + window.scrollY }); };
  var fire = function (type, t) { el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, composed: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] })); };
  fire('touchstart', mk(x, y));
  for (var i = 1; i <= a.steps; i++) fire('touchmove', mk(x + a.dx * i / a.steps, y + a.dy * i / a.steps));
  fire('touchend', mk(x + a.dx, y + a.dy));
}`);

/** Element text, normalised. */
export const innerTextOf = onElement<undefined, string>(String.raw`(el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()`);

export const outerHtml = onElement<undefined, string>(String.raw`(el) => el.outerHTML`);

/** Bounding box snapshot used by the "stable" state. */
export const rectOf = onElement<undefined, number[]>(String.raw`(el) => { var r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }`);
