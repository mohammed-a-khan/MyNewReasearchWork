/**
 * The deterministic healing ladder: T0 cache -> T1 fingerprint -> T2 semantic.
 * Every tier is read-only: it inspects the DOM, never clicks, scrolls,
 * dismisses overlays or presses keys. Verification is the runner's job.
 */
import type { Locator } from '../browser/index.js';
import { NotSupportedError, type ElementFingerprint, type HealTier, type LocatorCandidate } from '../core/index.js';
import { analyzeDescription, KIND_ROLE } from '../intent/target.js';
import { describeCandidate, toLocator, type LocatorRoot } from '../runner/locate.js';
import { poolSelector, scanElements, type ScannedElement } from './fingerprint.js';
import { pickBest, scoreFingerprint, type Ranked } from './score.js';
import { textSimilarity } from './similarity.js';
import { DEFAULT_HEAL_POLICY, HEAL_TIERS, type HealCandidate, type HealContext, type Healer, type HealPolicy } from './types.js';
import type { HealDecisions } from './decisions.js';

/** Extra inputs for the healer beyond its policy. */
export interface HealerOptions {
  /**
   * Reviewer decisions (`.eztest/heal-decisions.json`). A rejected heal blocks its tier for
   * that step (and its exact locator at any tier): the ladder stops there and the step fails
   * as a suspected regression instead of healing again.
   */
  decisions?: HealDecisions;
}

/** Note text the healer emits when a reviewer rejection stops the ladder. */
export const REJECTED_HEAL_NOTE = 'suspected regression: this heal was rejected in review';

const tierRank = (t: HealTier) => HEAL_TIERS.indexOf(t);
const keyOf = (c: LocatorCandidate) => JSON.stringify([c.strategy, c.value, c.name ?? null, c.exact ?? true]);

/** Validate and complete a heal policy. AI healing is refused explicitly. */
export function resolveHealPolicy(p: Partial<HealPolicy> = {}): HealPolicy {
  const policy: HealPolicy = { ...DEFAULT_HEAL_POLICY, ...p };
  if (policy.allowAI || policy.maxTier === 'T3-ai') {
    throw new NotSupportedError('AI healing is not available in this version');
  }
  if (!HEAL_TIERS.includes(policy.maxTier)) throw new Error(`Unknown heal tier ${policy.maxTier}`);
  for (const k of ['minConfidence', 'margin', 'threshold'] as const) {
    if (!(policy[k] >= 0 && policy[k] <= 1)) throw new Error(`Heal policy ${k} must be between 0 and 1`);
  }
  return policy;
}

/** Create the standard deterministic healer. */
export function createHealer(policy: Partial<HealPolicy> = {}, opts: HealerOptions = {}): Healer {
  return new LadderHealer(resolveHealPolicy(policy), opts.decisions);
}

function cssId(id: string): string {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/"/g, '\\"')}"]`;
}

/** Candidate locators for a scanned element, most robust first. */
export function robustCandidates(fp: ElementFingerprint): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  if (fp.role && fp.name) out.push({ strategy: 'role', value: fp.role, name: fp.name, exact: true });
  if (fp.label) out.push({ strategy: 'label', value: fp.label, exact: true });
  if (fp.testId) out.push({ strategy: 'testId', value: fp.testId });
  if (fp.id) out.push({ strategy: 'css', value: cssId(fp.id) });
  if (fp.placeholder) out.push({ strategy: 'placeholder', value: fp.placeholder, exact: true });
  if (fp.text && fp.text.length <= 80) out.push({ strategy: 'text', value: fp.text, exact: true });
  return out;
}

/**
 * Pick the first robust locator that resolves to exactly the chosen element
 * (unique, and the very same node). Read-only.
 */
export async function buildLocatorFor(root: LocatorRoot, pool: Locator, index: number, fp: ElementFingerprint): Promise<LocatorCandidate | undefined> {
  const handle = await pool.nth(index).elementHandle({ timeout: 1000 });
  if (!handle) return undefined;
  try {
    for (const c of robustCandidates(fp)) {
      const loc = toLocator(root, c);
      if ((await loc.count()) !== 1) continue;
      const same = await loc.evaluate((el, other) => el === other, handle, { timeout: 1000 }).catch(() => false);
      if (same) return c;
    }
    return undefined;
  } finally {
    await handle.dispose();
  }
}

class LadderHealer implements Healer {
  constructor(
    readonly policy: HealPolicy,
    private readonly decisions?: HealDecisions,
  ) {}

  async *candidates(ctx: HealContext): AsyncIterable<HealCandidate> {
    if (!this.policy.enabled) return;
    const note = ctx.note ?? (() => {});
    const seen = new Set(ctx.target.locators.map(keyOf));
    let blocked = false;
    const offer = (c: HealCandidate, originTier?: HealTier): HealCandidate | undefined => {
      if (blocked || seen.has(keyOf(c.locator))) return undefined;
      const rej = this.decisions?.rejection(ctx.journey.id, ctx.step.id, c.tier, c.locator, originTier);
      if (rej) {
        // A reviewer said this heal is not trusted: do not climb further, fail the step instead.
        blocked = true;
        note(
          `${c.tier}: ${REJECTED_HEAL_NOTE} by ${rej.reviewer} (${rej.decidedAt.slice(0, 10)}${rej.reason ? `: ${rej.reason}` : ''}); ` +
            `${describeCandidate(c.locator)} was not tried and healing stopped`,
        );
        return undefined;
      }
      if (c.confidence < this.policy.minConfidence) {
        note(`${c.tier}: ${describeCandidate(c.locator)} confidence ${c.confidence.toFixed(2)} below ${this.policy.minConfidence}`);
        return undefined;
      }
      seen.add(keyOf(c.locator));
      return c;
    };

    // T0: previously verified heal / last good locator.
    const mem = ctx.store?.get(ctx.memory?.journeyId ?? ctx.journey.id, ctx.memory?.stepId ?? ctx.step.id);
    const cached: HealCandidate[] = [];
    if (mem?.healed) {
      cached.push({ locator: mem.healed.locator, tier: 'T0-cache', confidence: Math.max(0.9, mem.healed.confidence),
        reason: `previously verified heal (${mem.healed.tier}, ${mem.healed.verifiedAt})` });
    }
    if (mem?.lastGood) cached.push({ locator: mem.lastGood, tier: 'T0-cache', confidence: 0.9, reason: 'last locator that passed this step' });
    if (!cached.length) note('T0-cache: nothing cached for this step');
    for (const c of cached) {
      const o = offer(c, c === cached[0] && mem?.healed ? mem.healed.tier : undefined);
      if (o) yield o;
    }
    if (blocked || tierRank(this.policy.maxTier) < tierRank('T1-fingerprint')) return;

    // T1: fingerprint similarity.
    const fp = mem?.fingerprint ?? ctx.target.fingerprint;
    if (fp) {
      const c = await this.fingerprintTier(ctx, fp, note);
      const o = c && offer(c);
      if (o) yield o;
    } else {
      note('T1-fingerprint: no stored fingerprint for this step');
    }
    if (blocked || tierRank(this.policy.maxTier) < tierRank('T2-semantic')) return;

    // T2: description words vs accessible names.
    const c2 = await this.semanticTier(ctx, note);
    const o2 = c2 && offer(c2);
    if (o2) yield o2;
  }

  private async scanPool(ctx: HealContext, role: string | undefined, describedRole: string | undefined) {
    const sel = poolSelector({ role, describedRole, action: ctx.step.action });
    if (!sel) return undefined;
    const pool = ctx.root.locator(sel);
    const scanned = await scanElements(pool);
    return { pool, scanned };
  }

  private async fingerprintTier(ctx: HealContext, fp: ElementFingerprint, note: (m: string) => void): Promise<HealCandidate | undefined> {
    const described = KIND_ROLE[analyzeDescription(ctx.target.description).kind];
    const scan = await this.scanPool(ctx, fp.role, described);
    if (!scan) {
      note('T1-fingerprint: cannot tell which kind of element to look for');
      return undefined;
    }
    const ranked: Array<Ranked<number>> = [];
    scan.scanned.forEach((s: ScannedElement, i) => {
      if (s.visible) ranked.push({ item: i, score: scoreFingerprint(fp, s.fingerprint).score });
    });
    const pick = pickBest(ranked, this.policy.threshold, this.policy.margin);
    if (!pick.ok) {
      note(`T1-fingerprint: ${pick.reason}`);
      return undefined;
    }
    const chosen = scan.scanned[pick.best.item].fingerprint;
    const locator = await buildLocatorFor(ctx.root, scan.pool, pick.best.item, chosen);
    if (!locator) {
      note('T1-fingerprint: matched an element but could not build a unique locator for it');
      return undefined;
    }
    const breakdown = scoreFingerprint(fp, chosen).breakdown;
    const top = Object.entries(breakdown).filter(([, v]) => v >= 0.99).map(([k]) => k);
    return {
      locator,
      tier: 'T1-fingerprint',
      confidence: round(pick.best.score),
      reason: `fingerprint score ${pick.best.score.toFixed(2)}${pick.runnerUp ? ` (runner-up ${pick.runnerUp.score.toFixed(2)})` : ' (only candidate)'}; matching: ${top.join(', ') || 'none exact'}`,
    };
  }

  private async semanticTier(ctx: HealContext, note: (m: string) => void): Promise<HealCandidate | undefined> {
    const a = analyzeDescription(ctx.target.description);
    if (!a.name) {
      note('T2-semantic: the target description names no text to match');
      return undefined;
    }
    const role = KIND_ROLE[a.kind];
    const scan = await this.scanPool(ctx, undefined, role);
    if (!scan) {
      note('T2-semantic: cannot tell which kind of element to look for');
      return undefined;
    }
    const ranked: Array<Ranked<number>> = [];
    scan.scanned.forEach((s, i) => {
      if (!s.visible) return;
      const f = s.fingerprint;
      const score = Math.max(textSimilarity(a.name, f.name), textSimilarity(a.name, f.label), textSimilarity(a.name, f.text), textSimilarity(a.name, f.placeholder));
      ranked.push({ item: i, score });
    });
    const pick = pickBest(ranked, this.policy.minConfidence, this.policy.margin);
    if (!pick.ok) {
      note(`T2-semantic: ${pick.reason}`);
      return undefined;
    }
    const chosen = scan.scanned[pick.best.item].fingerprint;
    const locator = await buildLocatorFor(ctx.root, scan.pool, pick.best.item, chosen);
    if (!locator) {
      note('T2-semantic: matched an element but could not build a unique locator for it');
      return undefined;
    }
    return {
      locator,
      tier: 'T2-semantic',
      confidence: round(pick.best.score),
      reason: `"${a.name}" ~ "${chosen.name ?? chosen.label ?? chosen.text ?? ''}" (similarity ${pick.best.score.toFixed(2)}${pick.runnerUp ? `, runner-up ${pick.runnerUp.score.toFixed(2)}` : ''})`,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
