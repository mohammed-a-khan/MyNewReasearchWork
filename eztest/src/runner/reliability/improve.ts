/**
 * Locator improvement suggestions. When a step's target is weak (XPath,
 * classes, positions) and the element's fingerprint offers something more
 * robust (test id, role + accessible name, label, placeholder), the runner
 * checks the better candidate against the live page: it must match exactly
 * one element and that element must be the one the step is about to act on.
 * Only then is it recorded on the step result as an "improvement", which
 * the heal review inbox lists for a person to accept or reject. Nothing is
 * ever written to a journey without that review.
 */
import type { Locator } from '../../browser/index.js';
import type { ElementFingerprint, LocatorCandidate, Target } from '../../core/index.js';
import { scoreLocator, scoreTarget } from '../../lint/locator-score.js';
import { describeCandidate, interpolateCandidate, toLocator, type LocatorRoot } from '../locate.js';

/** Targets scoring at or above this are not worth improving. */
export const IMPROVE_BELOW = 70;
/** A suggestion must be at least this many points better. */
export const MIN_GAIN = 15;

const ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'heading', 'switch', 'searchbox', 'spinbutton', 'slider', 'row', 'cell', 'img', 'dialog']);

/** Robust candidates derivable from an element fingerprint, best first. */
export function candidatesFromFingerprint(fp: ElementFingerprint): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  if (fp.testId) out.push({ strategy: 'testId', value: fp.testId });
  if (fp.role && ROLES.has(fp.role) && fp.name && fp.name.length <= 80) out.push({ strategy: 'role', value: fp.role, name: fp.name });
  if (fp.label && fp.label.length <= 80) out.push({ strategy: 'label', value: fp.label });
  if (fp.placeholder) out.push({ strategy: 'placeholder', value: fp.placeholder });
  if (fp.attributes?.alt) out.push({ strategy: 'altText', value: fp.attributes.alt });
  if (fp.attributes?.title) out.push({ strategy: 'title', value: fp.attributes.title });
  return out
    .map((c) => ({ c, s: scoreLocator(c).score }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.c);
}

export interface Improvement {
  suggested: LocatorCandidate;
  score: number;
  currentScore: number;
  reason: string;
}

/**
 * A verified improvement for the element `loc` resolves to, or undefined.
 * Read-only: only counts and compares elements on the page.
 */
export async function suggestImprovement(root: LocatorRoot, loc: Locator, target: Target, fp: ElementFingerprint | undefined, vars: Record<string, unknown> = {}): Promise<Improvement | undefined> {
  if (!fp) return undefined;
  const current = scoreTarget(target.locators.map((c) => interpolateCandidate(c, vars)));
  if (current.score >= IMPROVE_BELOW) return undefined;
  for (const c of candidatesFromFingerprint(fp)) {
    const s = scoreLocator(c).score;
    if (s < current.score + MIN_GAIN) break;
    if (target.locators.some((l) => l.strategy === c.strategy && l.value === c.value && l.name === c.name)) continue;
    const other = toLocator(root, c);
    if ((await other.count().catch(() => 0)) !== 1) continue;
    const handle = await other.elementHandle({ timeout: 500 }).catch(() => null);
    if (!handle) continue;
    try {
      const same = await loc.evaluate((el, o) => el === o, handle, { timeout: 1000 }).catch(() => false);
      if (!same) continue;
    } finally {
      await handle.dispose().catch(() => undefined);
    }
    return {
      suggested: c,
      score: s,
      currentScore: current.score,
      reason: `${describeCandidate(c)} (score ${s}) selects the same single element as the current target (score ${current.score}: ${current.reasons[0] ?? 'weak'})`,
    };
  }
  return undefined;
}
