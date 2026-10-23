/**
 * Screens (page objects) and element targets.
 *
 * A target can be:
 *  - a plain-English description, parsed by the same target parser as `.ez`
 *    steps: `'the "Sign in" button'`, `'testid=order-number'`, `'xpath=//h1'`;
 *  - a screen element with ordered locator candidates:
 *    `screen('Orders', { search: { css: '#q', label: 'Search' } }).search`;
 *  - a raw locator object: `{ css: '#q' }`, `{ role: 'button', name: 'Save' }`.
 *
 * Every form becomes the runner's Target (description + candidates), so
 * strict locating, fingerprints and verified healing work the same as for
 * `.ez` steps.
 */
import type { LocatorCandidate, Target, TargetScope } from '../core/index.js';
import { describeTarget } from '../intent/target.js';

/** A raw locator: one or more strategies (tried in the order written). */
export interface LocatorSpec {
  css?: string;
  xpath?: string;
  /** ARIA role (with `name` for the accessible name). */
  role?: string;
  name?: string;
  text?: string;
  /** Located with getByLabel; also the element's human label when no `description` is given. */
  label?: string;
  testId?: string;
  placeholder?: string;
  title?: string;
  altText?: string;
  /** Exact text matching for role/label/text/placeholder/title/altText (default true). */
  exact?: boolean;
}

/** A screen element written as locators plus optional metadata. */
export interface ElementSpec extends LocatorSpec {
  /** Human description used in reports and healing (default: label, name, text or the first locator). */
  description?: string;
  /** Extra candidates after the ones above, e.g. alternatives imported from a page object. */
  candidates?: LocatorCandidate[];
  /** Frame selector chain for elements inside iframes. */
  frames?: string[];
}

/** An element of a screen: a resolved Target and where it came from. */
export interface ScreenElement {
  readonly kind: 'eztest.element';
  readonly screen?: string;
  readonly key?: string;
  /**
   * Shared element repository id (`<screen>.<key>`) of a static screen entry: the
   * runner uses the repository's locators when elements/*.yaml has this id, and
   * keeps one fingerprint and one verified heal for every journey that uses it.
   */
  readonly id?: string;
  readonly target: Target;
}

/** Anything a `ui.*` call accepts as its element. */
export type TargetInput = string | ScreenElement | ElementSpec;

export type ElementInput = string | ElementSpec;

/** The shape passed to screen(): elements, or functions building elements from runtime values. */
export type ScreenSpec = Record<string, ElementInput | ((...args: never[]) => ElementInput)>;

/** A typed screen: every key is an element, every function key builds one. */
export type Screen<S extends ScreenSpec> = {
  readonly [K in keyof S]: S[K] extends (...args: infer A) => ElementInput ? (...args: A) => ScreenElement : ScreenElement;
} & { readonly $name: string };

type Strategy = 'testId' | 'role' | 'label' | 'placeholder' | 'text' | 'title' | 'altText' | 'css' | 'xpath';
const ORDER: Strategy[] = ['testId', 'role', 'label', 'placeholder', 'text', 'title', 'altText', 'css', 'xpath'];

function candidatesOf(spec: LocatorSpec): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const exact = spec.exact;
  // Keys in the order the author wrote them (object key order), so `{ xpath, css }` tries the XPath first.
  const keys = (Object.keys(spec) as Strategy[]).filter((k) => ORDER.includes(k));
  for (const k of keys) {
    const v = spec[k];
    if (typeof v !== 'string' || !v) continue;
    switch (k) {
      case 'role':
        out.push({ strategy: 'role', value: v, ...(spec.name !== undefined ? { name: spec.name, exact: exact ?? true } : {}) });
        break;
      case 'testId':
        out.push({ strategy: 'testId', value: v });
        break;
      case 'css':
      case 'xpath':
        out.push({ strategy: k, value: v });
        break;
      default:
        out.push({ strategy: k, value: v, ...(exact !== undefined ? { exact } : {}) });
    }
  }
  return out;
}

function describe(spec: ElementSpec, fallback?: string): string {
  if (spec.description) return spec.description;
  if (spec.label) return spec.label;
  if (spec.name) return `${spec.name}${spec.role ? ` ${spec.role}` : ''}`;
  if (spec.text) return `"${spec.text}"`;
  if (fallback) return fallback;
  const first = candidatesOf(spec)[0] ?? spec.candidates?.[0];
  return first ? `${first.strategy}=${first.value}` : 'element';
}

/** The Target for an element spec (raw locator object). */
export function specToTarget(spec: ElementSpec, fallbackDescription?: string): Target {
  const locators = [...candidatesOf(spec), ...(spec.candidates ?? [])];
  if (!locators.length) throw new TypeError(`Element "${describe(spec, fallbackDescription)}" has no locator (give css, xpath, role, label, text, testId, placeholder, title or altText)`);
  return { description: describe(spec, fallbackDescription), locators, ...(spec.frames?.length ? { frames: spec.frames } : {}) };
}

export function isScreenElement(v: unknown): v is ScreenElement {
  return !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'eztest.element' && typeof (v as { target?: unknown }).target === 'object';
}

/** Resolve any target input to the runner's Target. */
export function toTarget(input: TargetInput): Target {
  if (typeof input === 'string') {
    if (!input.trim()) throw new TypeError('An element description must not be empty');
    return describeTarget(input);
  }
  if (isScreenElement(input)) return input.id && !input.target.element ? { ...input.target, element: input.id } : input.target;
  if (input && typeof input === 'object') return specToTarget(input);
  throw new TypeError(`Not an element: ${String(input)}`);
}

function element(screenName: string, key: string, input: ElementInput, id?: string): ScreenElement {
  const target = typeof input === 'string' ? describeTarget(input) : specToTarget(input, `${key} (${screenName})`);
  return Object.freeze({ kind: 'eztest.element' as const, screen: screenName, key, ...(id ? { id } : {}), target });
}

/** Repository id of a screen entry: `<screen>.<key>` (spaces and dots in the screen name become `_`). */
export function screenElementId(screenName: string, key: string): string {
  return `${screenName.trim().replace(/[\s.]+/g, '_')}.${key}`;
}

// ------------------------------------------------------------------ relative and scoped targets

function scoped(t: TargetInput, scope: TargetScope, description: string): ScreenElement {
  const base = toTarget(t);
  const target: Target = { ...base, description, scope: [scope, ...(base.scope ?? [])] };
  return Object.freeze({ kind: 'eztest.element' as const, target });
}

/** An element inside a container: `within('the "Billing" section', 'the "Name" field')`. Strict: the container must match once. */
export function within(container: TargetInput, t: TargetInput, description?: string): ScreenElement {
  const c = toTarget(container);
  return scoped(t, { relation: 'within', anchor: c }, description ?? `${describeOf(t)} inside ${c.description}`);
}

/** An element in the table/list row containing `text`: `inRow('Acme', 'the "Edit" button')`. */
export function inRow(text: string, t: TargetInput, description?: string): ScreenElement {
  return scoped(t, { relation: 'row', text }, description ?? `${describeOf(t)} in the row containing "${text}"`);
}

export interface LayoutSpec {
  /** Only elements within this many CSS pixels of the anchor (near: default 50). */
  maxDistance?: number;
  description?: string;
}

function layout(rel: 'above' | 'below' | 'leftOf' | 'rightOf' | 'near', word: string) {
  return (anchor: TargetInput, t: TargetInput, o: LayoutSpec = {}): ScreenElement => {
    const a = toTarget(anchor);
    return scoped(t, { relation: rel, anchor: a, ...(o.maxDistance !== undefined ? { maxDistance: o.maxDistance } : {}) }, o.description ?? `${describeOf(t)} ${word} ${a.description}`);
  };
}

/** The closest element below an anchor: `below('"Email"', 'the field')`. */
export const below = layout('below', 'below');
/** The closest element above an anchor. */
export const above = layout('above', 'above');
/** The closest element to the right of an anchor: `rightOf('the "Qty" label', 'the input')`. */
export const rightOf = layout('rightOf', 'right of');
/** The closest element to the left of an anchor. */
export const leftOf = layout('leftOf', 'left of');
/** The closest element near an anchor (within 50 px unless maxDistance says otherwise). */
export const near = layout('near', 'near');

function describeOf(t: TargetInput): string {
  try {
    return toTarget(t).description;
  } catch {
    return 'element';
  }
}

/** An ad-hoc element (e.g. built from runtime values): `el({ xpath: \`//tr[td='${id}']\` }, 'Order row')`. */
export function el(input: ElementInput, description?: string): ScreenElement {
  const target = typeof input === 'string' ? describeTarget(input) : specToTarget(description ? { ...input, description: input.description ?? description } : input);
  return Object.freeze({ kind: 'eztest.element' as const, target });
}

/**
 * Declare a screen (page object): named elements with locator candidates.
 *
 * ```ts
 * export const Orders = screen('Orders', {
 *   search: { css: '#q', label: 'Search' },
 *   row: (id: string) => ({ xpath: `//tr[td='${id}']`, description: `order ${id}` }),
 * });
 * await ui.fill(Orders.search, 'ORD-7');
 * await ui.click(Orders.row('ORD-7'));
 * ```
 */
export function screen<S extends ScreenSpec>(name: string, spec: S): Screen<S> {
  const out: Record<string, unknown> = { $name: name };
  for (const [key, v] of Object.entries(spec)) {
    if (typeof v === 'function') {
      out[key] = (...args: unknown[]) => element(name, key, (v as (...a: unknown[]) => ElementInput)(...args));
    } else {
      out[key] = element(name, key, v, screenElementId(name, key));
    }
  }
  return Object.freeze(out) as Screen<S>;
}

/** A selector string as an element spec: XPath when it looks like one, else CSS (`xpath=`, `css=` prefixes win). */
export function selectorSpec(selector: string): ElementSpec {
  const s = selector.trim();
  const m = /^(xpath|css|text|testid|role)\s*[=:]\s*(.+)$/is.exec(s);
  if (m) {
    const k = m[1].toLowerCase();
    return k === 'xpath' ? { xpath: m[2] } : k === 'css' ? { css: m[2] } : k === 'text' ? { text: m[2].replace(/^["']|["']$/g, '') } : k === 'testid' ? { testId: m[2] } : { role: m[2] };
  }
  return /^\(?\.{0,2}\//.test(s) ? { xpath: s } : { css: s };
}

/**
 * An element inside another one: CSS and XPath candidates of the parent are
 * combined with the child selector (`.//td[2]`, `button.save`, `xpath=...`).
 */
export function child(parent: TargetInput, selector: string | ElementSpec, description?: string): ScreenElement {
  const p = toTarget(parent);
  const spec = typeof selector === 'string' ? selectorSpec(selector) : selector;
  const out: LocatorCandidate[] = [];
  for (const c of p.locators) {
    if (c.strategy === 'xpath' && spec.xpath) out.push({ strategy: 'xpath', value: `${c.value}${spec.xpath.replace(/^\.(?=\/)/, '')}` });
    else if (c.strategy === 'css' && spec.css) out.push({ strategy: 'css', value: `${c.value} ${spec.css}` });
    else if (c.strategy === 'xpath' && spec.css && /^[a-z][\w-]*$/i.test(spec.css)) out.push({ strategy: 'xpath', value: `${c.value}//${spec.css}` });
    else if (c.strategy === 'css' && spec.xpath) out.push({ strategy: 'css', value: `${c.value} >> xpath=${spec.xpath.startsWith('.') ? spec.xpath : `.${spec.xpath}`}` });
  }
  if (!out.length) throw new TypeError(`Cannot combine ${p.description} with ${typeof selector === 'string' ? selector : JSON.stringify(selector)}: the parent needs a CSS or XPath locator`);
  const target: Target = { description: description ?? `${typeof selector === 'string' ? selector : 'child'} in ${p.description}`, locators: out, ...(p.frames ? { frames: p.frames } : {}) };
  return Object.freeze({ kind: 'eztest.element' as const, target });
}

/** The n-th (0-based) element matching a target (XPath and CSS candidates). */
export function nth(of: TargetInput, index: number, description?: string): ScreenElement {
  const p = toTarget(of);
  const out: LocatorCandidate[] = [];
  for (const c of p.locators) {
    if (c.strategy === 'xpath') out.push({ strategy: 'xpath', value: `(${c.value})[${index + 1}]` });
    else if (c.strategy === 'css') out.push({ strategy: 'css', value: `${c.value} >> nth=${index}` });
  }
  // Any other target (role, label, text ...): the ordinal applies to every candidate's matches.
  if (!out.length) return Object.freeze({ kind: 'eztest.element' as const, target: { ...p, nth: index, description: description ?? `${p.description} #${index + 1}` } });
  return Object.freeze({ kind: 'eztest.element' as const, target: { description: description ?? `${p.description} #${index + 1}`, locators: out, ...(p.frames ? { frames: p.frames } : {}) } });
}
