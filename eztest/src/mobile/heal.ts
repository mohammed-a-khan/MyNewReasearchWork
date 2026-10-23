/**
 * The healing ladder on native apps: T0 cache -> T1 fingerprint -> T2 semantic,
 * the same tiers, thresholds and acceptance rule (best >= threshold and beats
 * the runner-up by the margin) as on the web, computed over the page source
 * XML. Every tier is read-only; the executor performs the step with a
 * candidate and accepts the heal only when the post-conditions hold.
 */
import type { ElementFingerprint, HealTier, LocatorCandidate, Target } from '../core/index.js';
import { pickBest, scoreFingerprint, type Ranked } from '../heal/score.js';
import { textSimilarity } from '../heal/similarity.js';
import type { FingerprintStore } from '../heal/store.js';
import { DEFAULT_HEAL_POLICY, HEAL_TIERS, type HealCandidate, type HealPolicy } from '../heal/types.js';
import { analyzeDescription } from '../intent/target.js';
import { kindOfCandidate } from './locators.js';
import type { NativeContext } from './native.js';
import { fingerprintOf, hintOf, isNodeVisible, kindOf, nameOf, robustNativeCandidates, textOf, type NativeNode, type PageSource } from './source.js';

const tierRank = (t: HealTier) => HEAL_TIERS.indexOf(t);
const keyOf = (c: LocatorCandidate) => JSON.stringify([c.strategy, c.value, c.name ?? null, c.exact ?? true]);

export interface NativeHealContext {
  journeyId: string;
  stepId: string;
  target: Target;
  store?: FingerprintStore;
  note: (m: string) => void;
}

/** Kind words of a description mapped to native kinds (button, textbox, ...). */
function describedKind(target: Target): string | undefined {
  const kind = analyzeDescription(target.description).kind;
  const k = kindOfCandidate({ strategy: 'role', value: kind === 'img' ? 'img' : kind });
  return k === 'generic' ? undefined : k;
}

/**
 * Pick a locator for a source node that the device confirms: unique, and the
 * very element whose bounds match the node.
 */
async function confirmedLocator(n: NativeNode, src: PageSource, native: NativeContext): Promise<LocatorCandidate | undefined> {
  for (const c of robustNativeCandidates(n, src, native.platform)) {
    const probe = { notes: [], tried: [], ambiguous: false } as Parameters<NativeContext['tryCandidate']>[1];
    if (!(await native.tryCandidate(c, probe)) || !probe.element) continue;
    if (!n.bounds) return c;
    const r = await native.ui.rect(probe.element).catch(() => undefined);
    if (r && r.x === n.bounds.x && r.y === n.bounds.y && r.width === n.bounds.width && r.height === n.bounds.height) return c;
  }
  return undefined;
}

/** Yield heal candidates, cheapest tier first. */
export async function* nativeHealCandidates(policy: HealPolicy = DEFAULT_HEAL_POLICY, ctx: NativeHealContext, native: NativeContext): AsyncIterable<HealCandidate> {
  if (!policy.enabled) return;
  const seen = new Set(ctx.target.locators.map(keyOf));
  const offer = (c: HealCandidate): HealCandidate | undefined => {
    if (seen.has(keyOf(c.locator))) return undefined;
    if (c.confidence < policy.minConfidence) {
      ctx.note(`${c.tier}: ${c.locator.strategy}=${c.locator.value} confidence ${c.confidence.toFixed(2)} below ${policy.minConfidence}`);
      return undefined;
    }
    seen.add(keyOf(c.locator));
    return c;
  };

  // T0: previously verified heal / last good locator.
  const mem = ctx.store?.get(ctx.journeyId, ctx.stepId);
  const cached: HealCandidate[] = [];
  if (mem?.healed) cached.push({ locator: mem.healed.locator, tier: 'T0-cache', confidence: Math.max(0.9, mem.healed.confidence), reason: `previously verified heal (${mem.healed.tier}, ${mem.healed.verifiedAt})` });
  if (mem?.lastGood) cached.push({ locator: mem.lastGood, tier: 'T0-cache', confidence: 0.9, reason: 'last locator that passed this step' });
  if (!cached.length) ctx.note('T0-cache: nothing cached for this step');
  for (const c of cached) {
    const o = offer(c);
    if (o) yield o;
  }
  if (tierRank(policy.maxTier) < tierRank('T1-fingerprint')) return;

  const { src } = await native.source(0);
  const pool = src.nodes.filter(isNodeVisible);
  const kind = describedKind(ctx.target);

  // T1: fingerprint similarity over the page source.
  const fp: ElementFingerprint | undefined = mem?.fingerprint ?? ctx.target.fingerprint;
  if (fp) {
    const ranked: Array<Ranked<NativeNode>> = pool.map((n) => ({ item: n, score: scoreFingerprint(fp, fingerprintOf(n)).score }));
    const pick = pickBest(ranked, policy.threshold, policy.margin);
    if (!pick.ok) ctx.note(`T1-fingerprint: ${pick.reason}`);
    else {
      const locator = await confirmedLocator(pick.best.item, src, native);
      if (!locator) ctx.note('T1-fingerprint: matched an element but could not build a unique locator for it');
      else {
        const breakdown = scoreFingerprint(fp, fingerprintOf(pick.best.item)).breakdown;
        const top = Object.entries(breakdown).filter(([, v]) => v >= 0.99).map(([k]) => k);
        const o = offer({
          locator, tier: 'T1-fingerprint', confidence: round(pick.best.score),
          reason: `fingerprint score ${pick.best.score.toFixed(2)}${pick.runnerUp ? ` (runner-up ${pick.runnerUp.score.toFixed(2)})` : ' (only candidate)'}; matching: ${top.join(', ') || 'none exact'}`,
        });
        if (o) yield o;
      }
    }
  } else ctx.note('T1-fingerprint: no stored fingerprint for this step');
  if (tierRank(policy.maxTier) < tierRank('T2-semantic')) return;

  // T2: the description's words vs names, texts and hints of elements of the described kind.
  const a = analyzeDescription(ctx.target.description);
  if (!a.name) {
    ctx.note('T2-semantic: the target description names no text to match');
    return;
  }
  const kindPool = kind ? pool.filter((n) => kindOf(n) === kind) : pool;
  const ranked = kindPool.map((n) => ({
    item: n,
    score: Math.max(textSimilarity(a.name, nameOf(n)), textSimilarity(a.name, textOf(n)), textSimilarity(a.name, hintOf(n))),
  }));
  const pick = pickBest(ranked, policy.minConfidence, policy.margin);
  if (!pick.ok) {
    ctx.note(`T2-semantic: ${pick.reason}`);
    return;
  }
  const locator = await confirmedLocator(pick.best.item, src, native);
  if (!locator) {
    ctx.note('T2-semantic: matched an element but could not build a unique locator for it');
    return;
  }
  const chosen = pick.best.item;
  const o = offer({
    locator, tier: 'T2-semantic', confidence: round(pick.best.score),
    reason: `"${a.name}" ~ "${nameOf(chosen) ?? textOf(chosen) ?? hintOf(chosen) ?? ''}" (similarity ${pick.best.score.toFixed(2)}${pick.runnerUp ? `, runner-up ${pick.runnerUp.score.toFixed(2)}` : ''})`,
  });
  if (o) yield o;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
