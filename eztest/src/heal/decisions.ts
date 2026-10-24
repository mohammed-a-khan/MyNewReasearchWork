/**
 * Heal review decisions (`.eztest/heal-decisions.json`): a reviewer accepts a
 * verified heal (the new locator was written into the journey) or rejects it
 * (the heal is not trusted). The healer reads the rejections: when the ladder
 * would offer a candidate at a rejected tier for that step, or offers the very
 * locator that was rejected (e.g. from the T0 cache), it stops and the step
 * fails as a suspected regression instead of healing again.
 *
 * Writes are atomic (temp file + rename). A corrupt file is an error, never
 * silently reset: losing a rejection would let an untrusted heal pass again.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HealTier, LocatorCandidate } from '../core/index.js';

export type HealDecisionKind = 'accepted' | 'rejected';

/** What was reviewed: a heal at a tier, or an "improvement" (a verified, more robust locator proposed after a pass). */
export type ReviewTier = HealTier | 'improvement';

export interface HealDecision {
  journeyId: string;
  stepId: string;
  decision: HealDecisionKind;
  /** Tier of the heal that was reviewed (for T0 cache hits: the tier that originally produced it). */
  tier: ReviewTier;
  /** The healed locator that was reviewed. */
  locator: LocatorCandidate;
  original?: LocatorCandidate[];
  reviewer: string;
  reason?: string;
  decidedAt: string;
  /** Run the heal was reviewed from. */
  runId?: string;
  /** For accepted heals: the journey file that was rewritten and how. */
  file?: string;
  rewrite?: string;
}

interface DecisionsFile {
  version: 1;
  decisions: HealDecision[];
}

const TIERS: ReadonlySet<string> = new Set(['T0-cache', 'T1-fingerprint', 'T2-semantic', 'improvement']);
/** A tier older decision files may name (EZTest no longer has it): such decisions are dropped on load. */
const REMOVED_TIERS: ReadonlySet<string> = new Set(['T3-ai']);

export const locatorKey = (c: LocatorCandidate): string => JSON.stringify([c.strategy, c.value, c.name ?? null, c.exact ?? true]);

export function healKey(journeyId: string, stepId: string): string {
  return `${journeyId}/${stepId}`;
}

function validate(raw: unknown, path: string): DecisionsFile {
  const bad = (why: string) => new Error(`Heal decisions file ${path} is invalid: ${why}`);
  if (!raw || typeof raw !== 'object') throw bad('not an object');
  const d = raw as Partial<DecisionsFile>;
  if (d.version !== 1) throw bad(`unsupported version ${String(d.version)}`);
  if (!Array.isArray(d.decisions)) throw bad('"decisions" is not a list');
  d.decisions = d.decisions.filter((x) => !(x && REMOVED_TIERS.has(x.tier)));
  for (const x of d.decisions) {
    if (!x || typeof x.journeyId !== 'string' || typeof x.stepId !== 'string') throw bad('a decision lacks journeyId/stepId');
    if (x.decision !== 'accepted' && x.decision !== 'rejected') throw bad(`unknown decision "${String(x.decision)}"`);
    if (!TIERS.has(x.tier)) throw bad(`unknown tier "${String(x.tier)}"`);
    if (!x.locator || typeof x.locator.strategy !== 'string' || typeof x.locator.value !== 'string') throw bad('a decision lacks its locator');
  }
  return d as DecisionsFile;
}

/** The decisions store. Later decisions for the same step, tier and locator replace earlier ones. */
export class HealDecisions {
  private data: DecisionsFile = { version: 1, decisions: [] };

  private constructor(readonly path?: string) {}

  /** An empty, in-memory set (nothing rejected). */
  static empty(): HealDecisions {
    return new HealDecisions();
  }

  static from(decisions: HealDecision[]): HealDecisions {
    const d = new HealDecisions();
    d.data.decisions = [...decisions];
    return d;
  }

  static async open(path: string): Promise<HealDecisions> {
    const d = new HealDecisions(path);
    if (existsSync(path)) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, 'utf8'));
      } catch (e) {
        throw new Error(`Heal decisions file ${path} is not valid JSON: ${(e as Error).message}`);
      }
      d.data = validate(raw, path);
    }
    return d;
  }

  list(): readonly HealDecision[] {
    return this.data.decisions;
  }

  forStep(journeyId: string, stepId: string): HealDecision[] {
    return this.data.decisions.filter((d) => d.journeyId === journeyId && d.stepId === stepId);
  }

  /** The latest decision on one heal (step + tier + locator), if any. */
  decisionOn(journeyId: string, stepId: string, tier: ReviewTier, locator: LocatorCandidate): HealDecision | undefined {
    const k = locatorKey(locator);
    return [...this.forStep(journeyId, stepId)].reverse().find((d) => d.tier === tier && locatorKey(d.locator) === k);
  }

  /**
   * Why a candidate must not heal this step, or undefined when it may.
   * A rejection blocks its whole tier for the step, and its exact locator at any tier
   * (so the T0 cache cannot replay a rejected heal). A later acceptance of the same
   * tier lifts a rejection.
   */
  rejection(journeyId: string, stepId: string, tier: HealTier, locator: LocatorCandidate, originTier?: HealTier): HealDecision | undefined {
    const mine = this.forStep(journeyId, stepId);
    const k = locatorKey(locator);
    for (const d of [...mine].reverse()) {
      const sameTier = d.tier === tier || (originTier !== undefined && d.tier === originTier);
      const sameLocator = locatorKey(d.locator) === k;
      if (!sameTier && !sameLocator) continue;
      return d.decision === 'rejected' ? d : undefined;
    }
    return undefined;
  }

  /** Record a decision (replacing an earlier one on the same heal). */
  record(d: HealDecision): void {
    const k = locatorKey(d.locator);
    this.data.decisions = this.data.decisions.filter(
      (x) => !(x.journeyId === d.journeyId && x.stepId === d.stepId && x.tier === d.tier && locatorKey(x.locator) === k),
    );
    this.data.decisions.push(d);
  }

  /** Remove the decision on one heal (e.g. undo). Returns whether one existed. */
  remove(journeyId: string, stepId: string, tier: ReviewTier, locator: LocatorCandidate): boolean {
    const k = locatorKey(locator);
    const before = this.data.decisions.length;
    this.data.decisions = this.data.decisions.filter((x) => !(x.journeyId === journeyId && x.stepId === stepId && x.tier === tier && locatorKey(x.locator) === k));
    return this.data.decisions.length !== before;
  }

  async save(path = this.path): Promise<void> {
    if (!path) throw new Error('HealDecisions.save: no path');
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2) + '\n');
    await rename(tmp, path);
  }
}
