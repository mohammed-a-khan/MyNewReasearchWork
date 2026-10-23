/**
 * Accepting a heal into the element repository: the healed locator goes first
 * in the element's `locators` (an equal locator further down is dropped), so
 * every journey that uses the element runs with it next time. Planning is
 * pure (text in, text out) and comes with a unified diff; nothing is written
 * until the reviewer confirms (Studio Quality Center, `eztest elements`).
 *
 * YAML comments and layout outside the entry are kept. A short-form entry
 * (`placeOrder: the "Place order" button`) becomes `{ description, locators }`.
 * An element that comes from a TypeScript screen gets an override entry in
 * `elements/<Screen>.yaml` (YAML entries win over screens), so the code is
 * never rewritten.
 */
import YAML, { isMap, isSeq, type YAMLMap } from 'yaml';
import type { LocatorCandidate } from '../core/index.js';
import { unifiedDiff, type FileChange } from '../heal/apply.js';
import { elementFromEntry, locatorFromString, parseElementFile, screenId, type RepoElement } from './repository.js';

/** Keep the author's flow-collection style (`[a, b]` or `[ a, b ]`, whichever the file uses most). */
function yamlOut(text: string): { flowCollectionPadding: boolean } {
  const padded = (text.match(/[[{] [^\s\]}]/g) ?? []).length;
  const tight = (text.match(/[[{][^\s\]}]/g) ?? []).length;
  return { flowCollectionPadding: padded > tight };
}
const keyOf = (c: LocatorCandidate) => JSON.stringify([c.strategy, c.value, c.name ?? null, c.exact ?? true]);
const same = (a: LocatorCandidate, b: LocatorCandidate) => keyOf(a) === keyOf(b);

/** The shortest string form of a locator that reads back to the same candidate, else undefined. */
export function locatorToString(c: LocatorCandidate): string | undefined {
  let s: string | undefined;
  switch (c.strategy) {
    case 'role': s = c.name !== undefined ? (c.name.includes('"') ? undefined : `role=${c.value}[name="${c.name}"]`) : `role=${c.value}`; break;
    case 'testId': s = /^[\w.:-]+$/.test(c.value) ? `testid=${c.value}` : undefined; break;
    case 'css': s = /^#[A-Za-z][\w-]*$/.test(c.value) ? c.value : `css=${c.value}`; break;
    case 'xpath': s = `xpath=${c.value}`; break;
    case 'text': s = c.exact === false || c.value.includes('"') ? undefined : `text="${c.value}"`; break;
    default: s = undefined;
  }
  if (s === undefined) return undefined;
  try {
    return same(locatorFromString(s), c) ? s : undefined;
  } catch {
    return undefined;
  }
}

const node = (c: LocatorCandidate): string | Record<string, unknown> => locatorToString(c) ?? { ...c };

function change(path: string, before: string, after: string, existed: boolean): FileChange {
  const diff = unifiedDiff(before, after);
  const unified = [`--- ${existed ? `a/${path}` : '/dev/null'}`, `+++ b/${path}`, ...diff.map((l) => `${l.kind}${l.text}`)].join('\n') + '\n';
  return { path, existed, before, after, diff, unified };
}

export interface ElementHealPlan {
  elementId: string;
  method: 'element-yaml' | 'element-json' | 'element-override';
  summary: string;
  changes: FileChange[];
  notes: string[];
  /** True when the healed locator is already the element's first locator (nothing to change). */
  alreadyApplied: boolean;
}

export interface ElementPlanInput {
  element: RepoElement;
  healed: LocatorCandidate;
  /** Current text of the element's file (YAML/JSON), or of the override file for a screen element ('' when it does not exist yet). */
  text: string;
  /** Path shown in the diff (project-relative). */
  displayPath: string;
  existed?: boolean;
}

/** Where a heal of `element` is written: its own file, or `elements/<Screen>.yaml` for a TypeScript screen element. */
export function elementHealFile(element: RepoElement, dir = 'elements'): string {
  return element.source === 'screen' ? `${dir}/${screenId(element.screen)}.yaml` : element.file;
}

/** Plan putting `healed` first in an element's locators. */
export function planElementHeal(i: ElementPlanInput): ElementHealPlan {
  const { element: el, healed } = i;
  const notes: string[] = [];
  const existed = i.existed ?? true;
  if (el.locators[0] && same(el.locators[0], healed) && el.source !== 'screen') {
    return { elementId: el.id, method: 'element-yaml', summary: `${el.id} already uses ${locatorToString(healed) ?? healed.value} first`, changes: [], notes, alreadyApplied: true };
  }
  const locators = [healed, ...el.locators.filter((l) => !same(l, healed))];
  if (el.source === 'screen') {
    // An override entry next to the code: YAML wins over the TypeScript screen.
    const doc = i.text.trim() ? YAML.parseDocument(i.text) : new YAML.Document({ screen: el.screen, elements: {} });
    if (!doc.get('screen')) doc.set('screen', el.screen);
    let els = doc.get('elements', true) as YAMLMap | undefined;
    if (!isMap(els)) {
      doc.set('elements', doc.createNode({}));
      els = doc.get('elements', true) as YAMLMap;
    }
    const cur = els.get(el.key, true);
    if (isMap(cur)) {
      const prior = elementFromEntry(el.screen, el.key, (cur as YAMLMap).toJSON(), el.file);
      if (prior.locators[0] && same(prior.locators[0], healed)) {
        return { elementId: el.id, method: 'element-override', summary: `${el.id} already uses the healed locator first`, changes: [], notes, alreadyApplied: true };
      }
    }
    els.set(el.key, doc.createNode({ description: el.description, locators: locators.map(node), note: `accepted heal; overrides ${el.file}${el.line ? `:${el.line}` : ''}` }));
    const after = doc.toString(yamlOut(i.text));
    notes.push(`${el.id} comes from ${el.file}: the accepted locator goes into ${i.displayPath}, which takes precedence; the TypeScript is not changed`);
    return { elementId: el.id, method: 'element-override', summary: `Put the healed locator first for ${el.id} in ${i.displayPath}`, changes: [change(i.displayPath, i.text, after, existed)], notes, alreadyApplied: false };
  }
  if (el.source === 'json') {
    const data = JSON.parse(i.text) as { elements: Record<string, unknown> };
    const cur = data.elements[el.key];
    data.elements[el.key] = typeof cur === 'object' && cur && !Array.isArray(cur)
      ? { ...(cur as Record<string, unknown>), locators: locators.map(node) }
      : { description: el.description, locators: locators.map(node) };
    const indent = /\n( +)"/.exec(i.text)?.[1].length ?? 2;
    const after = JSON.stringify(data, null, indent) + '\n';
    return finish(i, el, healed, 'element-json', after, notes);
  }
  const doc = YAML.parseDocument(i.text);
  const els = doc.get('elements', true) as YAMLMap | undefined;
  if (!isMap(els)) throw new Error(`${i.displayPath} has no "elements" map`);
  const cur = els.get(el.key, true);
  if (isMap(cur)) {
    const ls = (cur as YAMLMap).get('locators', true) ?? (cur as YAMLMap).get('locator', true);
    if (isSeq(ls)) {
      ls.items = ls.items.filter((it) => {
        const v = (it as { toJSON?: () => unknown }).toJSON ? (it as { toJSON: () => unknown }).toJSON() : it;
        try {
          return !same(typeof v === 'string' ? locatorFromString(v) : (v as LocatorCandidate), healed);
        } catch {
          return true;
        }
      });
      ls.items.unshift(doc.createNode(node(healed)) as never);
    } else {
      (cur as YAMLMap).delete('locator');
      (cur as YAMLMap).set('locators', doc.createNode(locators.map(node)));
    }
  } else {
    notes.push('the short-form entry became { description, locators } so it can list the healed locator first');
    els.set(el.key, doc.createNode({ description: el.description, locators: locators.map(node) }));
  }
  return finish(i, el, healed, 'element-yaml', doc.toString(yamlOut(i.text)), notes);
}

function finish(i: ElementPlanInput, el: RepoElement, healed: LocatorCandidate, method: ElementHealPlan['method'], after: string, notes: string[]): ElementHealPlan {
  // Verify: the file still reads, the element keeps its id, and its first locator is the healed one.
  const back = parseElementFile(after, el.file);
  const nb = back.elements.find((e) => e.id === el.id);
  if (!nb || !same(nb.locators[0], healed)) throw new Error(`The rewrite of ${i.displayPath} did not take effect for ${el.id}; edit it by hand`);
  if (back.problems.length) throw new Error(`The rewrite of ${i.displayPath} would break it: ${back.problems[0].message}`);
  return { elementId: el.id, method, summary: `Put the healed locator first for ${el.id} in ${i.displayPath}`, changes: [change(i.displayPath, i.text, after, i.existed ?? true)], notes, alreadyApplied: false };
}
