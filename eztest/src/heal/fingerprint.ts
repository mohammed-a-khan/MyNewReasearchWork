/**
 * Element fingerprints: captured in the page (read-only) when a step passes,
 * and computed for every candidate element when healing.
 *
 * The in-page code is kept as source text and handed to the browser driver through
 * `pageFunction`, so it is never transformed by the TypeScript toolchain
 * (e.g. esbuild's keepNames helpers, which do not exist in the page). It is
 * static source shipped with EZTest, never user input.
 */
import type { ElementHandle, Locator } from '../browser/index.js';
import type { ElementFingerprint } from '../core/index.js';

/** Wrap static in-page source as a function the driver will serialise verbatim. */
export function pageFunction<A, R>(source: string): (arg: A) => R {
  const fn = (() => {
    throw new Error('in-page function must run in the browser');
  }) as unknown as (arg: A) => R;
  Object.defineProperty(fn, 'toString', { value: () => source });
  return fn;
}

/** Fingerprint plus scan-only facts about a candidate element. */
export interface ScannedElement {
  fingerprint: ElementFingerprint;
  visible: boolean;
  enabled: boolean;
}

const IN_PAGE = String.raw`(input) => {
  var list = Array.isArray(input) ? input : [input];
  var clean = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };
  var implicitRole = function (el) {
    var tag = el.tagName.toLowerCase();
    var explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'button') return 'button';
    if (tag === 'select') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td') return 'cell';
    if (tag === 'th') return 'columnheader';
    if (tag === 'nav') return 'navigation';
    if (tag === 'option') return 'option';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (t === 'hidden' || t === 'file') return '';
      return 'textbox';
    }
    return '';
  };
  var labelOf = function (el) {
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var parts = by.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? clean(n.textContent) : ''; });
      var joined = clean(parts.join(' '));
      if (joined) return joined;
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText || el.labels[0].textContent);
    var wrap = el.closest && el.closest('label');
    if (wrap) return clean(wrap.innerText || wrap.textContent);
    return '';
  };
  var nameOf = function (el, label) {
    var aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    if (label) return label;
    var tag = el.tagName.toLowerCase();
    if (tag === 'img') return clean(el.getAttribute('alt'));
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return clean(el.value);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title'));
    }
    if (tag === 'select' || tag === 'textarea') return clean(el.getAttribute('title'));
    return clean(el.innerText || el.textContent).slice(0, 200) || clean(el.getAttribute('title'));
  };
  var seg = function (el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + Array.prototype.slice.call(el.classList, 0, 2).join('.');
    return s;
  };
  var KEEP = ['type', 'name', 'href', 'role', 'aria-label', 'title', 'alt', 'placeholder', 'autocomplete', 'inputmode', 'value', 'for', 'download'];
  return list.map(function (el) {
    var tag = el.tagName.toLowerCase();
    var label = labelOf(el);
    var attrs = {};
    KEEP.forEach(function (k) {
      if (!el.hasAttribute(k)) return;
      if (k === 'value' && !(tag === 'input' && /^(submit|button|reset)$/i.test(el.getAttribute('type') || ''))) return;
      attrs[k] = String(el.getAttribute(k)).slice(0, 200);
    });
    var anc = [];
    var p = el.parentElement;
    while (p && anc.length < 4 && p.tagName.toLowerCase() !== 'body' && p.tagName.toLowerCase() !== 'html') { anc.unshift(seg(p)); p = p.parentElement; }
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    var fp = {
      tag: tag,
      role: implicitRole(el) || undefined,
      name: nameOf(el, label) || undefined,
      text: (tag === 'input' || tag === 'select' || tag === 'textarea') ? undefined : (clean(el.innerText || el.textContent).slice(0, 200) || undefined),
      id: el.id || undefined,
      testId: el.getAttribute('data-testid') || undefined,
      classes: el.classList && el.classList.length ? Array.prototype.slice.call(el.classList) : undefined,
      attributes: Object.keys(attrs).length ? attrs : undefined,
      label: label || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      path: anc.join(' > ') || undefined,
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
    };
    var visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    return { fingerprint: fp, visible: visible, enabled: !el.disabled };
  });
}`;

const scanFn = pageFunction<Element[], ScannedElement[]>(IN_PAGE);
const oneFn = pageFunction<Element, ScannedElement[]>(IN_PAGE);

/** Strip undefined keys so fingerprints serialise and compare cleanly. */
function compact(fp: ElementFingerprint): ElementFingerprint {
  return Object.fromEntries(Object.entries(fp).filter(([, v]) => v !== undefined)) as ElementFingerprint;
}

/** Capture the fingerprint of the single element a locator resolves to. Read-only. */
export async function captureFingerprint(locator: Locator, timeoutMs = 2000): Promise<ElementFingerprint> {
  const [r] = await locator.evaluate(oneFn, undefined as never, { timeout: timeoutMs });
  return compact(r.fingerprint);
}

/** Capture the fingerprint of an element handle (e.g. the element under the debugger's picker). Read-only. */
export async function fingerprintOfHandle(handle: ElementHandle): Promise<ElementFingerprint> {
  const [r] = await handle.evaluate(oneFn as (el: Element) => ScannedElement[]);
  return compact(r.fingerprint);
}

/** Fingerprint every element matching `locator` (in DOM order, aligned with `locator.nth(i)`). Read-only. */
export async function scanElements(locator: Locator): Promise<ScannedElement[]> {
  const rows = await locator.evaluateAll(scanFn);
  return rows.map((r) => ({ ...r, fingerprint: compact(r.fingerprint) }));
}

/** CSS selectors for the candidate pools of each role family. */
export const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, input[type=submit], input[type=button], input[type=reset], input[type=image], [role=button]',
  link: 'a[href], [role=link]',
  textbox:
    'input:not([type]), input[type=text], input[type=email], input[type=password], input[type=search], input[type=tel], input[type=url], input[type=number], textarea, [contenteditable=true], [role=textbox], [role=searchbox], [role=spinbutton]',
  combobox: 'select, [role=combobox], [role=listbox]',
  checkbox: 'input[type=checkbox], [role=checkbox], [role=switch]',
  radio: 'input[type=radio], [role=radio]',
  tab: '[role=tab]',
  menuitem: '[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]',
  heading: 'h1, h2, h3, h4, h5, h6, [role=heading]',
  img: 'img, [role=img], svg[aria-label]',
  file: 'input[type=file]',
  // Containers: anchors of scoped targets ("inside the Orders table") heal against these.
  table: 'table, [role=table], [role=grid], [role=treegrid]',
  region: 'section, fieldset, form, [role=region], [role=group], [role=form]',
  dialog: 'dialog, [role=dialog], [role=alertdialog]',
  list: 'ul, ol, [role=list], [role=listbox]',
  navigation: 'nav, [role=navigation]',
};

const FAMILY: Record<string, string[]> = {
  button: ['button', 'link', 'menuitem', 'tab'],
  link: ['link', 'button', 'menuitem', 'tab'],
  menuitem: ['menuitem', 'button', 'link'],
  tab: ['tab', 'button', 'link'],
  textbox: ['textbox'],
  searchbox: ['textbox'],
  spinbutton: ['textbox'],
  combobox: ['combobox'],
  listbox: ['combobox'],
  checkbox: ['checkbox'],
  switch: ['checkbox'],
  radio: ['radio'],
  heading: ['heading'],
  img: ['img'],
  table: ['table'],
  grid: ['table'],
  treegrid: ['table'],
  region: ['region'],
  group: ['region'],
  form: ['region'],
  dialog: ['dialog'],
  alertdialog: ['dialog'],
  list: ['list'],
  navigation: ['navigation'],
};

/** Pseudo action of a scoped target's anchor or container while it heals (src/runner/step.ts). */
export const ANCHOR_ACTION = 'anchor';
const CONTAINER_FAMILIES = ['table', 'region', 'dialog', 'list', 'navigation'];

/** Roles the runner's action implies when nothing else is known. */
const ACTION_ROLES: Record<string, string[]> = {
  click: ['button', 'link', 'menuitem', 'tab'],
  dblclick: ['button', 'link', 'menuitem', 'tab'],
  download: ['link', 'button'],
  fill: ['textbox'],
  clear: ['textbox'],
  press: ['textbox'],
  select: ['combobox'],
  check: ['checkbox', 'radio'],
  uncheck: ['checkbox', 'radio'],
  upload: ['file'],
};

/**
 * CSS selector for the pool of elements compatible with a step: from the
 * stored role (its family), else the described role, else the action.
 * Returns undefined when nothing narrows the pool (no healing on "any element").
 */
export function poolSelector(opts: { role?: string; describedRole?: string; action: string }): string | undefined {
  const families = new Set<string>();
  const add = (r?: string) => {
    if (!r) return false;
    const fam = FAMILY[r] ?? (ROLE_SELECTORS[r] ? [r] : []);
    fam.forEach((f) => families.add(f));
    return fam.length > 0;
  };
  if (opts.action === 'upload') families.add('file');
  else if (!add(opts.role) && !add(opts.describedRole)) (ACTION_ROLES[opts.action] ?? []).forEach((f) => families.add(f));
  // Container pools only for the anchors of scoped targets (a widget step keeps its own component tier).
  if (opts.action !== ANCHOR_ACTION) for (const f of CONTAINER_FAMILIES) families.delete(f);
  if (!families.size) return undefined;
  return [...families].map((f) => ROLE_SELECTORS[f]).join(', ');
}
