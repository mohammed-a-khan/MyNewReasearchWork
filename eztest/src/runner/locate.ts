/**
 * Locator resolution. A candidate is accepted only when it resolves to exactly
 * one element: candidates matching several elements are skipped (and noted),
 * never "first match wins".
 */
import type { FrameLocator, Locator, Page } from '../browser/index.js';
import { NotSupportedError, interpolate, sleep, type LocatorCandidate, type Target, type TargetScope } from '../core/index.js';
import { fillXPath } from './reliability/xpath.js';
import { AdaptiveDeadline, type Extension, type Probeable } from './reliability/load.js';

/** Where locators are built from: the page, a (nested) frame, or a container element (scoped targets). */
export type LocatorRoot = Page | FrameLocator | Locator;

type AriaRole = Parameters<Page['getByRole']>[0];

/** Resolve the frame chain of a target ("iframe#pay", "iframe.inner") into a root. */
export function rootFor(page: Page, frames?: string[]): LocatorRoot {
  let root: LocatorRoot = page;
  for (const f of frames ?? []) root = root.frameLocator(f);
  return root;
}

/** Containers resolved by resolveScope: XPath candidates inside them are made relative (`//x` -> `.//x`). */
const CONTAINERS = new WeakSet<object>();

/** XPath relative to a container: `//td` -> `.//td`, `(//td)[2]` -> `(.//td)[2]`. */
function scopedXPath(x: string): string {
  return x.replace(/^(\(*)\/(?=\/|[A-Za-z*@])/, '$1./');
}

/** Build a driver locator for one candidate. */
export function toLocator(root: LocatorRoot, c: LocatorCandidate): Locator {
  const exact = c.exact ?? true;
  if (c.strategy === 'xpath' && CONTAINERS.has(root)) return root.locator(`xpath=${scopedXPath(c.value)}`);
  switch (c.strategy) {
    case 'role':
      return root.getByRole(c.value as AriaRole, c.name !== undefined ? { name: c.name, exact } : {});
    case 'label':
      return root.getByLabel(c.value, { exact });
    case 'text':
      return root.getByText(c.value, { exact });
    case 'testId':
      return root.getByTestId(c.value);
    case 'placeholder':
      return root.getByPlaceholder(c.value, { exact });
    case 'altText':
      return root.getByAltText(c.value, { exact });
    case 'title':
      return root.getByTitle(c.value, { exact });
    case 'css':
      return root.locator(c.value);
    case 'xpath':
      return root.locator(`xpath=${c.value}`);
    case 'section':
      return root.locator(`section=${textSelector(c.value, exact)}`);
    // Native-app strategies (src/mobile). In a page (mobile web, web views) an id and an accessibility id still make sense.
    case 'id':
      return root.locator(`[id="${c.value.replace(/["\\]/g, '\\$&')}"]`);
    case 'accessibilityId':
      return root.getByLabel(c.value, { exact: true });
    case 'className':
    case 'iosPredicate':
      throw new NotSupportedError(`locator strategy "${c.strategy}" in a web page (it is for native apps: Platform: android or ios)`);
  }
}

/** A text= style selector body: quoted exact, or quoted with the `i` flag (case-insensitive substring). */
function textSelector(v: string, exact: boolean): string {
  const q = v.includes('"') && !v.includes("'") ? `'${v}'` : `"${v.replace(/"/g, '\\"')}"`;
  return exact ? q : `${q}i`;
}

/** Human-readable form of a candidate, e.g. `role=button "Sign in"`. */
export function describeCandidate(c: LocatorCandidate): string {
  return c.strategy === 'role' && c.name !== undefined ? `role=${c.value} "${c.name}"` : `${c.strategy}=${JSON.stringify(c.value)}`;
}

/** Interpolate ${vars} inside a candidate's value and name. XPath values are quoted safely (concat() for mixed quotes). */
export function interpolateCandidate(c: LocatorCandidate, vars: Record<string, unknown>): LocatorCandidate {
  const value = c.strategy === 'xpath' && c.value.includes('${') ? fillXPath(c.value, (t) => interpolate(t, vars)) : interpolate(c.value, vars);
  return { ...c, value, ...(c.name !== undefined ? { name: interpolate(c.name, vars) } : {}) };
}

/** Where a (scoped) target's candidates are looked for, and the filters applied to each. */
export interface ScopeResolution {
  ok: boolean;
  /** The container (or the page/frame root when the target has no container scope). */
  root: LocatorRoot;
  /** Applies the layout filters and the ordinal pick to a candidate's locator. */
  wrap: (l: Locator) => Locator;
  notes: string[];
  /** An anchor or container matched more than one element. */
  ambiguous: boolean;
  /** The resolved anchors, in scope order (for evidence and the fingerprint store). */
  anchors: Array<{ scope: TargetScope; candidate?: LocatorCandidate; locator?: Locator }>;
}

const SCOPE_WORD: Record<TargetScope['relation'], string> = {
  within: 'container', row: 'row', above: 'anchor', below: 'anchor', leftOf: 'anchor', rightOf: 'anchor', near: 'anchor',
};

/** A plain-English name of a scope, e.g. `row containing "Acme"`, `anchor "Email"`. */
export function describeScope(s: TargetScope): string {
  if (s.relation === 'row') return `row containing "${s.text ?? ''}"`;
  return `${SCOPE_WORD[s.relation]} ${s.anchor?.description ?? '?'}`;
}

/** True when the target is relative or scoped (containers, rows, layout anchors, ordinals). */
export function isScoped(target: Target): boolean {
  return !!target.scope?.length || target.nth !== undefined;
}

/**
 * Resolve a target's scopes once (no waiting): each container, row and layout anchor
 * must match exactly one element, else the result says which one did not and why.
 */
export async function resolveScope(root: LocatorRoot, target: Target, vars: Record<string, unknown>): Promise<ScopeResolution> {
  const notes: string[] = [];
  const anchors: ScopeResolution['anchors'] = [];
  let cur: LocatorRoot = root;
  const filters: Array<(l: Locator) => Locator> = [];
  for (const sc of target.scope ?? []) {
    let loc: Locator | undefined;
    let candidate: LocatorCandidate | undefined;
    let n = 0;
    let why = '';
    if (sc.relation === 'row') {
      const text = interpolate(sc.text ?? '', vars);
      const l = cur.locator(`row=${textSelector(text, sc.exact ?? false)}`);
      n = await l.count().catch(() => 0);
      if (n === 1) loc = l;
    } else {
      if (!sc.anchor) {
        notes.push(`${sc.relation} scope has no anchor`);
        return { ok: false, root: cur, wrap: (l) => l, notes, ambiguous: false, anchors };
      }
      const r = await resolveTarget(cur, sc.anchor, vars, 0);
      loc = r.locator;
      candidate = r.candidate;
      n = loc ? 1 : Math.max(0, ...(r.tried ?? []).map((t) => t.count));
      why = r.notes.join('; ');
    }
    anchors.push({ scope: sc, candidate, locator: loc });
    if (!loc) {
      const msg = n > 1 ? `${describeScope(sc)} matched ${n} elements (an anchor must match exactly one; make it more specific)` : `${describeScope(sc)} not found`;
      notes.push(why ? `${msg} (${why})` : msg);
      return { ok: false, root: cur, wrap: (l) => l, notes, ambiguous: n > 1, anchors };
    }
    if (sc.relation === 'within' || sc.relation === 'row') {
      CONTAINERS.add(loc);
      cur = loc;
    } else {
      const anchor = loc;
      const rel = sc.relation;
      const o = sc.maxDistance !== undefined ? { maxDistance: sc.maxDistance } : {};
      filters.push((l) => l[rel](anchor, o));
    }
  }
  if (target.nth !== undefined) {
    const k = target.nth;
    filters.push((l) => l.nth(k));
  }
  return { ok: true, root: cur, wrap: (l) => filters.reduce((acc, f) => f(acc), l), notes, ambiguous: false, anchors };
}

/** The locator of one candidate of a target whose scopes are resolved. */
export function scopedLocator(scope: Pick<ScopeResolution, 'root' | 'wrap'>, c: LocatorCandidate): Locator {
  return scope.wrap(toLocator(scope.root, c));
}

export interface Resolution {
  locator?: Locator;
  candidate?: LocatorCandidate;
  /** The resolved scopes the locator was built in (relative and scoped targets). */
  scope?: ScopeResolution;
  /** Why candidates were skipped (no match / ambiguous). */
  notes: string[];
  /** True if some candidate matched more than one element. */
  ambiguous: boolean;
  /** Every candidate tried in the last polling round, with its match count (-1: invalid). */
  tried?: Array<{ candidate: LocatorCandidate; count: number; error?: string }>;
}

/**
 * Try each candidate in order until one resolves to exactly one element,
 * polling until `timeoutMs` (elements may still be loading).
 */
/** A file input, or a container with one inside, a few levels up from an element: the nearest one. */
export const NEAR_FILE_INPUT = "xpath=ancestor-or-self::*[position() <= 6][self::input[@type='file'] or .//input[@type='file']][1]/descendant-or-self::input[@type='file']";

export async function resolveTarget(
  root: LocatorRoot,
  target: Target,
  vars: Record<string, unknown>,
  timeoutMs: number,
  /** Adaptive deadline (reliability/load.ts): the page to probe, and who to tell when the wait was extended. */
  adapt?: { probe?: Probeable; onExtend?: (e: Extension) => void; enabled?: boolean },
  /**
   * What the step will do with the element. `upload`: a description that matches several elements (two
   * "profile picture" images, one in the header) resolves to the one file input that exactly one of them sits next to.
   */
  purpose?: { upload?: boolean },
): Promise<Resolution> {
  const deadline = new AdaptiveDeadline(timeoutMs, { what: `locate ${target.description}`, ...adapt });
  let notes: string[] = [];
  let ambiguous = false;
  let tried: NonNullable<Resolution['tried']> = [];
  if (target.locators.length === 0) {
    const why = target.element ? `element @${target.element} is not in the element repository (elements/*.yaml)` : 'target has no locator candidates';
    return { notes: [why], ambiguous: false, tried };
  }
  const scoped = isScoped(target);
  for (;;) {
    notes = [];
    ambiguous = false;
    tried = [];
    let scope: ScopeResolution | undefined;
    if (scoped) {
      scope = await resolveScope(root, target, vars);
      if (!scope.ok) {
        if (await deadline.reached()) return { notes: scope.notes, ambiguous: scope.ambiguous, tried, scope };
        await sleep(Math.min(200, Math.max(10, deadline.remaining())));
        continue;
      }
    }
    for (const raw of target.locators) {
      const c = interpolateCandidate(raw, vars);
      const loc = scope ? scopedLocator(scope, c) : toLocator(root, c);
      let n: number;
      try {
        n = await loc.count();
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0];
        tried.push({ candidate: c, count: -1, error: msg });
        notes.push(`${describeCandidate(c)}: invalid (${msg})`);
        continue;
      }
      tried.push({ candidate: c, count: n });
      if (n === 1) return { locator: loc, candidate: c, notes, ambiguous, tried, ...(scope ? { scope } : {}) };
      if (n > 1 && purpose?.upload) {
        const input = loc.locator(NEAR_FILE_INPUT);
        if ((await input.count().catch(() => 0)) === 1) {
          notes.push(`${describeCandidate(c)}: ${n} matches, one next to a file input`);
          return { locator: input, candidate: c, notes, ambiguous, tried, ...(scope ? { scope } : {}) };
        }
      }
      if (n > 1) ambiguous = true;
      notes.push(n === 0 ? `${describeCandidate(c)}: no match` : `${describeCandidate(c)}: ${n} matches (ambiguous, skipped)`);
    }
    if (await deadline.reached()) return { notes, ambiguous, tried, ...(scope ? { scope } : {}) };
    await sleep(Math.min(200, Math.max(10, deadline.remaining())));
  }
}

/**
 * The candidate locators of a target, in order, built inside its resolved scopes.
 * `scope` is undefined for plain targets; `error` says which anchor failed.
 */
export async function targetLocators(root: LocatorRoot, target: Target, vars: Record<string, unknown>): Promise<{ locators: Array<{ candidate: LocatorCandidate; locator: Locator }>; scope?: ScopeResolution; error?: string }> {
  let scope: ScopeResolution | undefined;
  if (isScoped(target)) {
    scope = await resolveScope(root, target, vars);
    if (!scope.ok) return { locators: [], scope, error: scope.notes.join('; ') };
  }
  const locators = target.locators.map((raw) => {
    const c = interpolateCandidate(raw, vars);
    return { candidate: c, locator: scope ? scopedLocator(scope, c) : toLocator(root, c) };
  });
  return { locators, scope };
}
