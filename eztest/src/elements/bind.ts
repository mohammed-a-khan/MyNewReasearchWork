/**
 * Binding journeys to the element repository, and the reports built on it:
 * usages per element, unused elements and duplicates.
 *
 * A target is bound when it names an element (`@Checkout.placeOrder`, the
 * SDK's screen()) or, with description matching on, when its description
 * equals an element's description or alias. A bound target takes the
 * repository's locators (first), fingerprint and frames, so a heal accepted
 * into the repository reaches every journey on the next run.
 */
import type { Condition, Journey, LocatorCandidate, Step, Target } from '../core/index.js';
import type { ElementRepository, RepoElement } from './repository.js';

const keyOf = (c: LocatorCandidate) => JSON.stringify([c.strategy, c.value, c.name ?? null, c.exact ?? true]);

/** A target with the repository's element applied (unchanged when it names none). */
export function bindTarget(t: Target, repo: ElementRepository, unknown?: Set<string>): Target {
  const scope = t.scope?.map((s) => (s.anchor ? { ...s, anchor: bindTarget(s.anchor, repo, unknown) } : s));
  const withScope = scope ? { ...t, scope } : t;
  let el: RepoElement | undefined;
  if (t.element) {
    el = repo.get(t.element);
    if (!el) {
      unknown?.add(t.element);
      return withScope;
    }
  } else if (!t.scope?.length && t.nth === undefined) {
    el = repo.byDescription(t.description);
  }
  if (!el) return withScope;
  const seen = new Set(el.locators.map(keyOf));
  return {
    ...withScope,
    element: el.id,
    locators: [...el.locators, ...t.locators.filter((l) => !seen.has(keyOf(l)))],
    ...(el.fingerprint || t.fingerprint ? { fingerprint: el.fingerprint ?? t.fingerprint } : {}),
    ...(el.frames?.length && !t.frames?.length ? { frames: el.frames } : {}),
  };
}

function bindCondition(c: Condition, repo: ElementRepository, unknown?: Set<string>): Condition {
  const o = c as Condition & { target?: Target; of?: Target };
  if (o.target) return { ...o, target: bindTarget(o.target, repo, unknown) } as Condition;
  if (o.of) return { ...o, of: bindTarget(o.of, repo, unknown) } as Condition;
  return c;
}

/** A step (and its blocks) with targets, drag destinations and post-condition targets bound. */
export function bindStep(s: Step, repo: ElementRepository, unknown?: Set<string>): Step {
  const out: Step = { ...s };
  if (s.target) out.target = bindTarget(s.target, repo, unknown);
  if (s.to) out.to = bindTarget(s.to, repo, unknown);
  if (s.postconditions?.length) out.postconditions = s.postconditions.map((c) => bindCondition(c, repo, unknown));
  if (s.flow?.condition) out.flow = { ...s.flow, condition: bindCondition(s.flow.condition, repo, unknown) };
  if (s.steps) out.steps = s.steps.map((x) => bindStep(x, repo, unknown));
  if (s.else) out.else = s.else.map((x) => bindStep(x, repo, unknown));
  if (s.catch) out.catch = s.catch.map((x) => bindStep(x, repo, unknown));
  return out;
}

/** Bind a whole journey; `unknown` lists element ids that are not in the repository. */
export function bindJourney(j: Journey, repo: ElementRepository): { journey: Journey; unknown: string[] } {
  const unknown = new Set<string>();
  const journey = { ...j, steps: j.steps.map((s) => bindStep(s, repo, unknown)) };
  return { journey, unknown: [...unknown].sort() };
}

export interface ElementUsage {
  journeyId: string;
  journeyName: string;
  stepId: string;
  intent: string;
  /** How the journey refers to the element (`code`: a screen model entry or an @reference in code, read as text). */
  via: 'reference' | 'description' | 'code';
  /** Where in the step: target, drag destination, expectation, or an anchor of a scoped target. */
  role: 'target' | 'to' | 'expect' | 'anchor';
}

function* targetsOf(s: Step): Generator<{ t: Target; role: ElementUsage['role'] }> {
  const withAnchors = function* (t: Target, role: ElementUsage['role']): Generator<{ t: Target; role: ElementUsage['role'] }> {
    yield { t, role };
    for (const sc of t.scope ?? []) if (sc.anchor) yield* withAnchors(sc.anchor, 'anchor');
  };
  if (s.target) yield* withAnchors(s.target, 'target');
  if (s.to) yield* withAnchors(s.to, 'to');
  for (const c of [...(s.postconditions ?? []), ...(s.flow?.condition ? [s.flow.condition] : [])]) {
    const o = c as { target?: Target; of?: Target };
    if (o.target) yield* withAnchors(o.target, 'expect');
    if (o.of) yield* withAnchors(o.of, 'expect');
  }
}

function* allSteps(steps: Step[] | undefined): Generator<Step> {
  for (const s of steps ?? []) {
    yield s;
    yield* allSteps(s.steps);
    yield* allSteps(s.else);
    yield* allSteps(s.catch);
  }
}

/** Every use of every element across journeys, keyed by element id; unknown references under their own id. */
export function elementUsages(journeys: Journey[], repo: ElementRepository): Map<string, ElementUsage[]> {
  const out = new Map<string, ElementUsage[]>();
  for (const j of journeys) {
    for (const s of allSteps(j.steps)) {
      for (const { t, role } of targetsOf(s)) {
        const el = t.element ? repo.get(t.element) : !t.scope?.length && t.nth === undefined ? repo.byDescription(t.description) : undefined;
        const id = el?.id ?? t.element;
        if (!id) continue;
        const u: ElementUsage = { journeyId: j.id, journeyName: j.name, stepId: s.id, intent: s.intent, via: t.element ? 'reference' : 'description', role };
        out.set(id, [...(out.get(id) ?? []), u]);
      }
    }
  }
  return out;
}

export interface DuplicateGroup {
  /** Why these elements look like one: the same first locator, the same locator set, or the same description. */
  reason: 'same-locator' | 'same-locators' | 'same-description';
  key: string;
  ids: string[];
}

/** Elements that are probably the same element defined twice. */
export function duplicateElements(repo: ElementRepository): DuplicateGroup[] {
  const groups = new Map<string, DuplicateGroup>();
  const add = (reason: DuplicateGroup['reason'], key: string, id: string) => {
    const k = `${reason}|${key}`;
    const g = groups.get(k) ?? { reason, key, ids: [] };
    if (!g.ids.includes(id)) g.ids.push(id);
    groups.set(k, g);
  };
  for (const e of repo.list()) {
    add('same-locators', e.locators.map(keyOf).sort().join(' '), e.id);
    if (e.locators[0]) add('same-locator', keyOf(e.locators[0]), e.id);
    add('same-description', e.description.toLowerCase().replace(/\s+/g, ' ').trim(), e.id);
  }
  const out = [...groups.values()].filter((g) => g.ids.length > 1);
  // A full locator-set match already explains a first-locator match of the same ids.
  return out.filter((g) => g.reason !== 'same-locator' || !out.some((o) => o.reason === 'same-locators' && o.ids.join() === g.ids.join()))
    .sort((a, b) => a.reason.localeCompare(b.reason) || a.ids[0].localeCompare(b.ids[0]));
}
