/**
 * Element picker and locator validation for the live debugger.
 *
 * `pickElement` finds the element at a viewport point (through open shadow
 * roots), fingerprints it with the healer's fingerprint code and returns
 * ranked locator candidates: test id, role + name, label, placeholder, text,
 * alt/title, CSS, and XPath last. Each candidate carries its match count, a
 * stability score (generated ids/classes, nth-child and long chains are
 * penalised) and the `.ez` phrase that targets it, checked by round-tripping
 * the phrase through `describeTarget`.
 *
 * `validateLocator` counts what a candidate or `.ez` target text matches and
 * can outline the matches on the live page (an overlay that is removed on
 * resume). In-page code is static EZTest source, never user input.
 */
import type { ElementHandle, Page } from '../../browser/index.js';
import { EzTestError, LocatorCandidate, type ElementFingerprint, type Target } from '../../core/index.js';
import { fingerprintOfHandle, pageFunction } from '../../heal/fingerprint.js';
import { describeTarget } from '../../intent/target.js';
import { parseIntent } from '../../intent/parse.js';
import { describeCandidate, interpolateCandidate, toLocator } from '../locate.js';

export interface PickOptions {
  /** Action the phrase should use; default inferred from the element (click, fill, select, check). */
  action?: 'click' | 'fill' | 'select' | 'check' | 'hover' | 'dblclick';
  /** Value used in fill/select phrases. Default "…". */
  value?: string;
}

export interface RankedCandidate {
  candidate: LocatorCandidate;
  description: string;
  /** Elements this candidate matches on the live page. */
  count: number;
  /** True when it matches exactly one element, and that element is the picked one. */
  unique: boolean;
  /** 0..1, higher is more robust to UI changes. */
  stability: number;
  /** Why the stability is what it is. */
  notes: string[];
  /** `.ez` target phrase, e.g. `the "Submit order" button`. */
  ezTarget: string;
  /** Full `.ez` step line, e.g. `Click the "Submit order" button`. */
  ezStep?: string;
  /** The phrase, parsed by describeTarget, resolves to this very element. */
  ezResolves: boolean;
}

export interface PickResult {
  point: { x: number; y: number };
  tag: string;
  fingerprint: ElementFingerprint;
  box?: { x: number; y: number; width: number; height: number };
  candidates: RankedCandidate[];
}

interface PageFacts {
  tag: string;
  id: string;
  testId: string;
  classes: string[];
  name: string;
  type: string;
  css: string;
  cssNth: boolean;
  cssDepth: number;
  xpath: string;
  alt: string;
  title: string;
}

const AT_POINT = String.raw`(p) => {
  var el = document.elementFromPoint(p.x, p.y);
  while (el && el.shadowRoot) {
    var inner = el.shadowRoot.elementFromPoint(p.x, p.y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}`;

const FACTS = String.raw`(el) => {
  var esc = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'); };
  var seg = function (e) {
    var tag = e.tagName.toLowerCase();
    if (e.id && document.querySelectorAll('#' + esc(e.id)).length === 1) return { s: '#' + esc(e.id), nth: false, anchor: true };
    var parent = e.parentElement;
    if (!parent) return { s: tag, nth: false };
    var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === e.tagName; });
    if (same.length === 1) return { s: tag, nth: false };
    return { s: tag + ':nth-of-type(' + (same.indexOf(e) + 1) + ')', nth: true };
  };
  var parts = [];
  var nth = false;
  var cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    var sg = seg(cur);
    parts.unshift(sg.s);
    nth = nth || sg.nth;
    if (sg.anchor) break;
    cur = cur.parentElement;
  }
  var xp = [];
  for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
    var t = n.tagName.toLowerCase();
    var sib = n.parentElement ? Array.prototype.filter.call(n.parentElement.children, function (c) { return c.tagName === n.tagName; }) : [n];
    xp.unshift(sib.length > 1 ? t + '[' + (sib.indexOf(n) + 1) + ']' : t);
  }
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    testId: el.getAttribute('data-testid') || '',
    classes: Array.prototype.slice.call(el.classList || []),
    name: el.getAttribute('name') || '',
    type: (el.getAttribute('type') || '').toLowerCase(),
    css: parts.join(' > '),
    cssNth: nth,
    cssDepth: parts.length,
    xpath: '/' + xp.join('/'),
    alt: el.getAttribute('alt') || '',
    title: el.getAttribute('title') || ''
  };
}`;

const HIGHLIGHT = String.raw`(boxes) => {
  var old = document.getElementById('__eztest_highlight__');
  if (old) old.remove();
  if (!boxes) return 0;
  var host = document.createElement('div');
  host.id = '__eztest_highlight__';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
  boxes.forEach(function (b, i) {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;box-sizing:border-box;border:2px solid #e11d48;background:rgba(225,29,72,.12);pointer-events:none;' +
      'left:' + (b.x + window.scrollX) + 'px;top:' + (b.y + window.scrollY) + 'px;width:' + b.width + 'px;height:' + b.height + 'px';
    var tag = document.createElement('span');
    tag.textContent = String(i + 1);
    tag.style.cssText = 'position:absolute;top:-16px;left:-2px;font:11px/14px sans-serif;background:#e11d48;color:#fff;padding:0 4px';
    d.appendChild(tag);
    root.appendChild(d);
  });
  document.documentElement.appendChild(host);
  return boxes.length;
}`;

const atPointFn = pageFunction<{ x: number; y: number }, Element | null>(AT_POINT);
const factsFn = pageFunction<Element, PageFacts>(FACTS);
const highlightFn = pageFunction<Array<{ x: number; y: number; width: number; height: number }> | null, number>(HIGHLIGHT);

const ROLE_WORD: Record<string, string> = {
  button: 'button', link: 'link', textbox: 'field', searchbox: 'field', spinbutton: 'field', combobox: 'dropdown', listbox: 'dropdown',
  checkbox: 'checkbox', radio: 'radio button', switch: 'switch', slider: 'slider', tab: 'tab', heading: 'heading', img: 'image',
  menuitem: 'menu item', option: 'option', dialog: 'dialog', table: 'table', row: 'row', cell: 'cell',
};

/** Ids and classes that look machine-generated (hashes, counters, framework prefixes). */
export function looksGenerated(token: string): boolean {
  return (
    /\d{3,}/.test(token) ||
    /^[a-z]{1,4}-[a-z0-9]{5,}$/i.test(token) ||
    /(?:^|[-_])[a-f0-9]{6,}(?:$|[-_])/i.test(token) ||
    /^(?:css|sc|jsx|emotion|ember|ng-|react-|mui-|_)/i.test(token) ||
    /^:r[0-9a-z]+:$/.test(token)
  );
}

function quote(s: string): string {
  return `"${s.replace(/"/g, "'")}"`;
}

function phraseFor(c: LocatorCandidate, roleOfElement: string | undefined): string {
  switch (c.strategy) {
    case 'testId': return `testid=${c.value}`;
    case 'role': return c.name !== undefined && ROLE_WORD[c.value] ? `the ${quote(c.name)} ${ROLE_WORD[c.value]}` : `role=${c.value}${c.name !== undefined ? `[name=${quote(c.name)}]` : ''}`;
    case 'label':
    case 'placeholder': return `the ${quote(c.value)} ${ROLE_WORD[roleOfElement ?? 'textbox'] ?? 'field'}`;
    case 'altText': return `the ${quote(c.value)} image`;
    case 'text':
    case 'title': return quote(c.value);
    case 'css': return `css=${c.value}`;
    case 'xpath': return `xpath=${c.value}`;
    default: return nativePhrase(c);
  }
}

/** Native-app strategies (src/mobile) as target passthroughs. */
function nativePhrase(c: LocatorCandidate): string {
  const prefix: Record<string, string> = { accessibilityId: 'accessibility id', id: 'id', className: 'class', iosPredicate: 'predicate' };
  return `${prefix[c.strategy] ?? c.strategy}=${c.value}`;
}

function stepFor(target: string, action: string, value: string): string {
  switch (action) {
    case 'fill': return `Type ${quote(value)} into ${target}`;
    case 'select': return `Select ${quote(value)} from ${target}`;
    case 'check': return `Check ${target}`;
    case 'hover': return `Hover over ${target}`;
    case 'dblclick': return `Double-click ${target}`;
    default: return `Click ${target}`;
  }
}

function defaultAction(role?: string): NonNullable<PickOptions['action']> {
  if (role === 'textbox' || role === 'searchbox' || role === 'spinbutton') return 'fill';
  if (role === 'combobox' || role === 'listbox') return 'select';
  if (role === 'checkbox' || role === 'radio' || role === 'switch') return 'check';
  return 'click';
}

async function sameElement(page: Page, c: LocatorCandidate, handle: ElementHandle): Promise<{ count: number; same: boolean }> {
  const loc = toLocator(page, c);
  const count = await loc.count().catch(() => -1);
  if (count !== 1) return { count, same: false };
  const same = await loc.evaluate((el, other) => el === other, handle, { timeout: 1000 }).catch(() => false);
  return { count, same };
}

/** Does an `.ez` target phrase resolve (strictly) to this element? */
async function phraseResolves(page: Page, phrase: string, handle: ElementHandle): Promise<boolean> {
  let t: Target;
  try {
    t = describeTarget(phrase);
  } catch {
    return false;
  }
  for (const c of t.locators) {
    const r = await sameElement(page, c, handle);
    if (r.count === 1) return r.same;
  }
  return false;
}

/** Ranked locator candidates for an element handle on `page`. */
export async function rankCandidates(page: Page, handle: ElementHandle, opts: PickOptions = {}): Promise<{ fingerprint: ElementFingerprint; facts: PageFacts; candidates: RankedCandidate[] }> {
  const fp = await fingerprintOfHandle(handle);
  const facts = (await handle.evaluate(factsFn as never)) as PageFacts;
  const raw: Array<{ c: LocatorCandidate; base: number; notes: string[] }> = [];
  const add = (c: LocatorCandidate, base: number, notes: string[] = []) => raw.push({ c, base, notes });
  if (fp.testId) add({ strategy: 'testId', value: fp.testId }, looksGenerated(fp.testId) ? 0.7 : 1, looksGenerated(fp.testId) ? ['test id looks generated'] : ['dedicated test id']);
  if (fp.role && fp.name) add({ strategy: 'role', value: fp.role, name: fp.name, exact: true }, fp.name.length > 40 ? 0.75 : 0.9, ['accessible role and name']);
  if (fp.label) add({ strategy: 'label', value: fp.label, exact: true }, 0.85, ['form label']);
  if (fp.placeholder) add({ strategy: 'placeholder', value: fp.placeholder, exact: true }, 0.7, ['placeholder text']);
  if (fp.text && fp.text.length <= 80 && fp.text !== fp.name) {
    const notes = ['visible text'];
    let s = 0.65;
    if (fp.text.length > 40) { s -= 0.15; notes.push('long text'); }
    if (/\d/.test(fp.text)) { s -= 0.15; notes.push('text contains digits (often data)'); }
    add({ strategy: 'text', value: fp.text, exact: true }, s, notes);
  }
  if (facts.alt) add({ strategy: 'altText', value: facts.alt, exact: true }, 0.75, ['alt text']);
  if (facts.title) add({ strategy: 'title', value: facts.title, exact: true }, 0.6, ['title attribute']);
  if (facts.id) {
    const gen = looksGenerated(facts.id);
    add({ strategy: 'css', value: /^[A-Za-z][\w-]*$/.test(facts.id) ? `#${facts.id}` : `[id="${facts.id.replace(/"/g, '\\"')}"]` }, gen ? 0.25 : 0.6, gen ? ['id looks generated'] : ['element id']);
  }
  if (facts.name) add({ strategy: 'css', value: `${facts.tag}[name="${facts.name.replace(/"/g, '\\"')}"]` }, 0.55, ['name attribute']);
  const stableClasses = facts.classes.filter((c) => !looksGenerated(c)).slice(0, 2);
  if (stableClasses.length) {
    const generated = facts.classes.length - stableClasses.length;
    add({ strategy: 'css', value: `${facts.tag}.${stableClasses.map((c) => c.replace(/([^\w-])/g, '\\$1')).join('.')}` }, 0.4, ['class names', ...(generated ? [`${generated} generated class(es) ignored`] : [])]);
  }
  if (facts.css) {
    let s = 0.35;
    const notes = ['structural CSS path'];
    if (facts.cssNth) { s -= 0.15; notes.push('uses nth-of-type'); }
    if (facts.cssDepth > 3) { s -= Math.min(0.15, 0.05 * (facts.cssDepth - 3)); notes.push(`${facts.cssDepth}-level chain`); }
    add({ strategy: 'css', value: facts.css }, s, notes);
  }
  add({ strategy: 'xpath', value: facts.xpath }, 0.05, ['absolute XPath (last resort)']);

  const action = opts.action ?? defaultAction(fp.role);
  const seen = new Set<string>();
  const out: RankedCandidate[] = [];
  for (const r of raw) {
    const key = JSON.stringify(r.c);
    if (seen.has(key)) continue;
    seen.add(key);
    const { count, same } = await sameElement(page, r.c, handle);
    const unique = count === 1 && same;
    const notes = [...r.notes];
    let stability = r.base;
    if (!unique) {
      stability *= 0.4;
      notes.push(count > 1 ? `matches ${count} elements` : count === 0 ? 'matches nothing' : count < 0 ? 'invalid locator' : 'matches a different element');
    }
    const ezTarget = phraseFor(r.c, fp.role);
    const ezResolves = await phraseResolves(page, ezTarget, handle);
    let ezStep: string | undefined = stepFor(ezTarget, action, opts.value ?? '…');
    try {
      parseIntent(ezStep);
    } catch {
      ezStep = undefined;
    }
    out.push({ candidate: r.c, description: describeCandidate(r.c), count, unique, stability: Math.round(stability * 1000) / 1000, notes, ezTarget, ...(ezStep ? { ezStep } : {}), ezResolves });
  }
  out.sort((a, b) => {
    const ax = a.candidate.strategy === 'xpath' ? 1 : 0;
    const bx = b.candidate.strategy === 'xpath' ? 1 : 0;
    if (ax !== bx) return ax - bx;
    if (a.unique !== b.unique) return a.unique ? -1 : 1;
    return b.stability - a.stability;
  });
  return { fingerprint: fp, facts, candidates: out };
}

/** Pick the element at a viewport point and rank locators for it. */
export async function pickElement(page: Page, point: { x: number; y: number }, opts: PickOptions = {}): Promise<PickResult> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new EzTestError('Point must have numeric x and y', 'BAD_INPUT');
  const js = await page.evaluateHandle(atPointFn, point);
  const handle = js.asElement();
  if (!handle) {
    await js.dispose();
    throw new EzTestError(`No element at (${point.x}, ${point.y})`, 'NOT_FOUND');
  }
  try {
    const { fingerprint, facts, candidates } = await rankCandidates(page, handle as ElementHandle, opts);
    return { point, tag: facts.tag, fingerprint, box: fingerprint.box, candidates };
  } finally {
    await handle.dispose();
  }
}

export type ValidateInput = LocatorCandidate | { target: string } | string;

export interface ValidateResult {
  /** Matches of the first candidate that matched anything (strict resolution needs exactly 1). */
  count: number;
  resolved?: LocatorCandidate;
  candidates: Array<{ candidate: LocatorCandidate; description: string; count: number; error?: string }>;
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
  highlighted: number;
}

/** Count (and optionally highlight) what a locator candidate or `.ez` target text matches. */
export async function validateLocator(page: Page, input: ValidateInput, opts: { highlight?: boolean; vars?: Record<string, unknown> } = {}): Promise<ValidateResult> {
  let candidates: LocatorCandidate[];
  if (typeof input === 'string' || (typeof input === 'object' && 'target' in input)) {
    const text = typeof input === 'string' ? input : input.target;
    try {
      candidates = describeTarget(text).locators;
    } catch (e) {
      throw new EzTestError(`Cannot understand target "${text}": ${(e as Error).message}`, 'BAD_INPUT');
    }
  } else {
    candidates = [LocatorCandidate.parse(input)];
  }
  const out: ValidateResult = { count: 0, candidates: [], boxes: [], highlighted: 0 };
  let chosen: LocatorCandidate | undefined;
  for (const raw of candidates) {
    const c = interpolateCandidate(raw, opts.vars ?? {});
    try {
      const n = await toLocator(page, c).count();
      out.candidates.push({ candidate: c, description: describeCandidate(c), count: n });
      if (!chosen && n > 0) {
        chosen = c;
        out.count = n;
      }
    } catch (e) {
      out.candidates.push({ candidate: c, description: describeCandidate(c), count: -1, error: (e as Error).message.split('\n')[0] });
    }
  }
  if (chosen) {
    out.resolved = chosen;
    const loc = toLocator(page, chosen);
    for (let i = 0; i < Math.min(out.count, 50); i++) {
      const b = await loc.nth(i).boundingBox({ timeout: 1000 }).catch(() => null);
      if (b) out.boxes.push({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
    }
  }
  if (opts.highlight) out.highlighted = await page.evaluate(highlightFn, out.boxes).catch(() => 0);
  return out;
}

/** Remove the highlight overlay. */
export async function clearHighlights(page: Page): Promise<void> {
  await page.evaluate(highlightFn, null).catch(() => undefined);
}
