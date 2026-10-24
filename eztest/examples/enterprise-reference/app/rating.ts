/**
 * The Larkspur rating engine. The published rating rules (README) are:
 *
 *   base     = sumInsured x rate            (HOME 0.25%, MOTOR 3.5%)
 *   loaded   = base x regionFactor x (1 + loading)
 *              regionFactor NORTH 1.00, SOUTH 1.10, COAST 1.25, METRO 1.15
 *              loading HOME: property older than 30 years +12%; MOTOR: driver under 25 +30%
 *   discount = loaded x no-claims discount  (5% per claim-free year, at most 25%)
 *   net      = max(150.00, loaded - discount)
 *   tax      = net x 12% insurance premium tax
 *   total    = net + tax                     (every step rounded to cents)
 *
 * REF_BUG=premium-tax deliberately charges the tax on the loaded premium (before the discount).
 */
import { HttpError, round2 } from './http.ts';
import { PREMIUM_TAX_RATE, settings } from './settings.ts';

export const RATES = { HOME: 0.0025, MOTOR: 0.035 } as const;
export const REGION_FACTORS = { NORTH: 1.0, SOUTH: 1.1, COAST: 1.25, METRO: 1.15 } as const;
export const MIN_NET_PREMIUM = 150;

export type Product = keyof typeof RATES;
export type Region = keyof typeof REGION_FACTORS;

export interface QuoteInput {
  product: Product;
  sumInsured: number;
  region: Region;
  /** HOME: age of the property in years; MOTOR: age of the main driver. */
  riskAge: number;
  noClaimsYears: number;
}

export interface Premium {
  basePremium: number;
  regionFactor: number;
  loadingPct: number;
  loadedPremium: number;
  noClaimsDiscountPct: number;
  discount: number;
  netPremium: number;
  taxRate: number;
  tax: number;
  totalPremium: number;
}

export function validateQuote(raw: Record<string, unknown>): QuoteInput {
  const product = String(raw.product ?? '').toUpperCase() as Product;
  const region = String(raw.region ?? '').toUpperCase() as Region;
  const sumInsured = Number(raw.sumInsured);
  const riskAge = Number(raw.riskAge);
  const noClaimsYears = Number(raw.noClaimsYears ?? 0);
  const problems: string[] = [];
  if (!(product in RATES)) problems.push('product must be HOME or MOTOR');
  if (!(region in REGION_FACTORS)) problems.push('region must be NORTH, SOUTH, COAST or METRO');
  if (!Number.isFinite(sumInsured) || sumInsured < 1000 || sumInsured > 10_000_000) problems.push('sumInsured must be between 1000 and 10000000');
  if (!Number.isInteger(riskAge) || riskAge < 0 || riskAge > 300) problems.push('riskAge must be a whole number of years');
  if (product === 'MOTOR' && Number.isInteger(riskAge) && riskAge < 17) problems.push('the main driver must be at least 17');
  if (!Number.isInteger(noClaimsYears) || noClaimsYears < 0 || noClaimsYears > 60) problems.push('noClaimsYears must be a whole number');
  if (problems.length) throw new HttpError(422, problems.join('; '), 'validation_failed');
  return { product, region, sumInsured, riskAge, noClaimsYears };
}

export function ratePremium(q: QuoteInput): Premium {
  const base = round2(q.sumInsured * RATES[q.product]);
  const regionFactor = REGION_FACTORS[q.region];
  const loadingPct = q.product === 'HOME' ? (q.riskAge > 30 ? 12 : 0) : q.riskAge < 25 ? 30 : 0;
  const loaded = round2(base * regionFactor * (1 + loadingPct / 100));
  const ncdPct = Math.min(q.noClaimsYears, 5) * 5;
  const discount = round2(loaded * (ncdPct / 100));
  const net = Math.max(MIN_NET_PREMIUM, round2(loaded - discount));
  const taxBase = settings.bug === 'premium-tax' ? loaded : net;
  const tax = round2(taxBase * PREMIUM_TAX_RATE);
  return {
    basePremium: base,
    regionFactor,
    loadingPct,
    loadedPremium: loaded,
    noClaimsDiscountPct: ncdPct,
    discount,
    netPremium: net,
    taxRate: PREMIUM_TAX_RATE,
    tax,
    totalPremium: round2(net + tax),
  };
}
