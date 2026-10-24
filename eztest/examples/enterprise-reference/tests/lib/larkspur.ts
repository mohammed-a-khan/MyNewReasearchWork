/**
 * The Larkspur test team's shared helper library: business rules the tests compute
 * expectations from (written from the underwriting manual, never imported from the
 * app), test-data builders and small utilities. Used by code journeys and code steps.
 */

export type Product = 'HOME' | 'MOTOR';
export type Region = 'NORTH' | 'SOUTH' | 'COAST' | 'METRO';

export interface RiskInput {
  product: Product;
  sumInsured: number;
  region: Region;
  riskAge: number;
  noClaimsYears: number;
}

export interface ExpectedPremium {
  basePremium: number;
  loadingPct: number;
  loadedPremium: number;
  discount: number;
  netPremium: number;
  tax: number;
  totalPremium: number;
}

export const TAX_RATE = 0.12;
export const MIN_NET_PREMIUM = 150;
export const ADJUSTER_LIMIT = 10_000;
const RATE: Record<Product, number> = { HOME: 0.0025, MOTOR: 0.035 };
const REGION: Record<Region, number> = { NORTH: 1, SOUTH: 1.1, COAST: 1.25, METRO: 1.15 };

/** Round half away from zero to cents, like the rating engine's specification says. */
export const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The premium the underwriting manual prescribes for a risk. */
export function expectedPremium(r: RiskInput): ExpectedPremium {
  const basePremium = cents(r.sumInsured * RATE[r.product]);
  const loadingPct = r.product === 'HOME' ? (r.riskAge > 30 ? 12 : 0) : r.riskAge < 25 ? 30 : 0;
  const loadedPremium = cents(basePremium * REGION[r.region] * (1 + loadingPct / 100));
  const discount = cents((loadedPremium * Math.min(r.noClaimsYears, 5) * 5) / 100);
  const netPremium = Math.max(MIN_NET_PREMIUM, cents(loadedPremium - discount));
  const tax = cents(netPremium * TAX_RATE);
  return { basePremium, loadingPct, loadedPremium, discount, netPremium, tax, totalPremium: cents(netPremium + tax) };
}

/** What a claim pays out: the approved amount less the policy excess, never below zero. */
export const expectedPayout = (approved: number, excess: number): number => Math.max(0, cents(approved - excess));

/** Who may decide a claim of this size. */
export const decisionLevel = (amount: number): 'ADJUSTER' | 'SENIOR' => (amount > ADJUSTER_LIMIT ? 'SENIOR' : 'ADJUSTER');

/** ISO date (YYYY-MM-DD) n days from `from` (UTC calendar arithmetic). */
export function isoDaysFrom(from: string | Date, n: number): string {
  const d = typeof from === 'string' ? new Date(`${from}T12:00:00Z`) : new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A unique, readable reference for data a test creates (broker references, descriptions). */
export function testRef(prefix: string): string {
  const shard = process.env.EZTEST_SHARD_INDEX ?? '0';
  return `${prefix}-${shard}${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
}

/** Money as the portal shows it ("1234.50"). */
export const money = (n: number): string => cents(n).toFixed(2);
