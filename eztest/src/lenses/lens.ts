/**
 * Lens contract (local to this module until it moves to core): a lens runs
 * after a step against the live page and returns a result that can be stored
 * as evidence.
 */
import type { Page } from '../browser/index.js';
import type { EvidenceVault } from '../core/index.js';

export interface LensStep {
  id: string;
  intent?: string;
}

export interface LensContext {
  journeyId?: string;
  /** When provided, lens findings are stored as evidence and their ids returned. */
  vault?: EvidenceVault;
}

export interface LensResult<T = unknown> {
  lens: string;
  stepId: string;
  passed: boolean;
  summary: string;
  evidence: string[];
  data: T;
}

export interface Lens<T = unknown> {
  readonly name: string;
  afterStep(page: Page, step: LensStep, ctx?: LensContext): Promise<LensResult<T>>;
}

export async function storeLensEvidence(ctx: LensContext | undefined, lens: string, step: LensStep, data: unknown): Promise<string[]> {
  if (!ctx?.vault) return [];
  const safe = `${ctx.journeyId ?? 'journey'}-${step.id}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const ref = await ctx.vault.store('data', `lenses/${lens}/${safe}.json`, JSON.stringify(data, null, 2), {
    journeyId: ctx.journeyId,
    stepId: step.id,
    description: `${lens} lens result`,
  });
  return [ref.id];
}
