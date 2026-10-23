/**
 * Fault injection rules for the mock server. Probabilities use a seeded PRNG
 * so a fault scenario is reproducible run after run.
 */
import { z } from 'zod';
import { EzTestError } from '../core/index.js';
import { globMatch } from '../insights/glob.js';

export const FaultRule = z
  .object({
    /** HTTP method or "*" (default). */
    method: z.string().default('*'),
    /** Glob over the request path, e.g. "/api/orders/**". */
    path: z.string().min(1),
    latencyMs: z.number().int().min(0).optional(),
    status: z.number().int().min(100).max(599).optional(),
    /** Truncate the body and append garbage bytes. */
    corruptBody: z.boolean().optional(),
    /** Destroy the connection without any response. */
    drop: z.boolean().optional(),
    /** 0..1, default 1 (always). */
    probability: z.number().min(0).max(1).default(1),
  })
  .refine((r) => r.latencyMs !== undefined || r.status !== undefined || r.corruptBody || r.drop, {
    message: 'a fault rule needs at least one effect (latencyMs, status, corruptBody or drop)',
  });
export type FaultRule = z.infer<typeof FaultRule>;
export type FaultRuleInput = z.input<typeof FaultRule>;

export function parseFaultRules(rules: FaultRuleInput[] | undefined): FaultRule[] {
  return (rules ?? []).map((r, i) => {
    const p = FaultRule.safeParse(r);
    if (!p.success) throw new EzTestError(`faults[${i}]: ${p.error.issues.map((x) => x.message).join('; ')}`, 'MOCK_FAULT_INVALID');
    return p.data;
  });
}

/** mulberry32: small deterministic PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** First matching rule whose probability roll succeeds, or undefined. */
export function pickFault(rules: FaultRule[], method: string, path: string, rand: () => number): FaultRule | undefined {
  for (const r of rules) {
    if (r.method !== '*' && r.method.toUpperCase() !== method.toUpperCase()) continue;
    if (!globMatch(r.path, path)) continue;
    // Always consume one random number per matching rule so sequences stay reproducible.
    const roll = rand();
    if (roll < r.probability) return r;
  }
  return undefined;
}

export function corrupt(body: Buffer): Buffer {
  const keep = body.subarray(0, Math.floor(body.length / 2));
  return Buffer.concat([keep, Buffer.from('\u0000#corrupted-by-eztest#{', 'utf8')]);
}
